/**
 * 云存档代理 —— 游戏前端与 cloudflarepool 数据湖之间唯一的一层。
 *
 * 为什么要这一层（数据湖直连的五个卡点）：
 *   1. 数据湖零 CORS，浏览器跨域调用预检直接 403
 *   2. 一把服务密钥下所有玩家的 owner 都是密钥 ID，服务端分不清玩家
 *   3. 服务密钥写限流 60/分钟且按密钥共享，多玩家必然 429
 *   4. 没有 upsert，POST 是裸 INSERT，重复 id 会 500
 *   5. 单条 GET 不校验 owner，持读令牌可遍历 id 读他人存档
 *
 * 走 X-Sync-Key 内部通道 + 注入 X-User-Id，五个问题一次解决：
 *   同源部署绕开 CORS、owner 即玩家、该通道豁免限流、
 *   PUT→404→POST 自动回退补上 upsert、代理层补 owner 校验。
 *
 * 安全红线：
 *   - INTERNAL_KEY 是数据湖最高权限密钥，只存在于本进程环境变量
 *   - 绝不转发客户端的任何请求头，全部由本文件重新构造
 *   - 只允许访问 /t/{TENANT}/c/{COLLECTION}/ 这一个前缀，不是通用网关
 */

import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const LAKE = (process.env.LAKE_BASE || 'https://your-data-lake.example.com').replace(/\/$/, '');
const TENANT = process.env.LAKE_TENANT || 'cloudlet';
const COLLECTION = process.env.LAKE_COLLECTION || 'saves';
const INTERNAL_KEY = process.env.INTERNAL_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

const MAX_BYTES = 200 * 1024;
const TIMEOUT_MS = 8000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (!INTERNAL_KEY) {
  console.error('[cloudlet-api] 缺少 INTERNAL_KEY，拒绝启动');
  process.exit(1);
}

const BASE = `/t/${encodeURIComponent(TENANT)}/c/${encodeURIComponent(COLLECTION)}`;

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 请求头由代理全权构造，客户端的任何头都不透传 */
function lakeHeaders(device) {
  return {
    'x-sync-key': INTERNAL_KEY,
    'x-user-id': device,
    'content-type': 'application/json',
  };
}

async function lake(method, path, device, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${LAKE}${path}`, {
      method,
      headers: lakeHeaders(device),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function corsHeaders() {
  if (!ALLOWED_ORIGIN) return {};
  return {
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

// 轻量限流：单 IP 令牌桶，挡住误用与脚本刷写
const buckets = new Map();
function rateLimit(ip) {
  const key = String(ip);
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: 30, last: now };
  b.tokens = Math.min(30, b.tokens + ((now - b.last) / 1000) * 1);
  b.last = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 300_000;
  for (const [k, b] of buckets) if (b.last < cutoff) buckets.delete(k);
}, 60_000).unref();

const server = http.createServer(async (req, res) => {
  const cors = corsHeaders();
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' }, cors);

  const ip = req.socket.remoteAddress ?? 'unknown';
  if (!rateLimit(ip)) return send(res, 429, { error: 'too many requests' }, cors);

  try {
    if (url.pathname === '/api/health') {
      return send(res, 200, { ok: true, tenant: TENANT, collection: COLLECTION }, cors);
    }

    if (url.pathname !== '/api/save') return send(res, 404, { error: 'not found' }, cors);

    const device = url.searchParams.get('device') ?? '';
    if (!UUID_V4.test(device)) {
      return send(res, 400, { error: 'invalid device id' }, cors);
    }
    const path = `${BASE}/${encodeURIComponent(device)}`;

    if (req.method === 'GET') {
      const r = await lake('GET', path, device);
      if (r.status === 404) return send(res, 404, { error: 'not found' }, cors);
      if (!r.ok) return send(res, 502, { error: `lake ${r.status}` }, cors);

      const row = await r.json();
      // 数据湖单条 GET 不校验 owner，这一层补上
      if (row.owner_openid !== device) return send(res, 404, { error: 'not found' }, cors);
      return send(res, 200, { doc: row.doc, updatedAt: row.updated_at }, cors);
    }

    if (req.method === 'PUT') {
      const raw = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'invalid json' }, cors);
      }
      if (!parsed || typeof parsed.doc !== 'object' || parsed.doc === null) {
        return send(res, 400, { error: 'doc required' }, cors);
      }

      // 数据湖没有 upsert：先 PUT，404 再 POST 创建
      let r = await lake('PUT', path, device, { doc: parsed.doc });
      if (r.status === 404) {
        r = await lake('POST', BASE, device, { id: device, doc: parsed.doc });
      }
      if (!r.ok) return send(res, 502, { error: `lake ${r.status}` }, cors);
      return send(res, 200, { ok: true, updatedAt: Date.now() }, cors);
    }

    if (req.method === 'DELETE') {
      const r = await lake('DELETE', path, device);
      if (!r.ok && r.status !== 404) return send(res, 502, { error: `lake ${r.status}` }, cors);
      return send(res, 200, { ok: true }, cors);
    }

    return send(res, 405, { error: 'method not allowed' }, cors);
  } catch (err) {
    const status = err?.status ?? 500;
    return send(res, status, { error: err?.message ?? 'internal error' }, cors);
  }
});

server.listen(PORT, () => {
  console.log(`[cloudlet-api] listening on ${PORT} → ${LAKE}${BASE}`);
});
