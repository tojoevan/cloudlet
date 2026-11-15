/**
 * 云存档 + 账号网关 —— 游戏前端与 cloudflarepool 数据湖之间唯一的一层。
 *
 * 架构（对齐微家事，路C 对接通用网关）：
 *   [ 浏览器前端 ] → HTTPS /api/* → [ 本网关（持有 GATEWAY_KEY / JWT_SECRET）]
 *     → T2 JWT(tid=cloudlet) → [ 微家事网关 your-gateway.example.com /api/t2data ] → [ cloudflarepool 数据湖 cloudlet 租户 ]
 *   本网关不再直连数据湖、不持有 X-Sync-Key；数据湖凭证收敛到微家事网关一侧；数据按租户隔离。
 *
 * 为什么需要这层（数据湖直连的五个卡点）：
 *   1. 数据湖零 CORS，浏览器跨域调用预检直接 403
 *   2. 一把服务密钥下所有玩家的 owner 都是密钥 ID，服务端分不清玩家
 *   3. 服务密钥写限流 60/分钟且按密钥共享，多玩家必然 429
 *   4. 没有 upsert，POST 是裸 INSERT，重复 id 会 500
 *   5. 单条 GET 不校验 owner，持读令牌可遍历 id 读他人存档
 *
 * 走微家事网关 T2 通道（/api/t2data）+ 注入 T2 JWT，五个问题一次解决：
 *   同源部署绕开 CORS、owner 即玩家（T2 sub）、网关代理豁免限流、
 *   PUT→404→POST 自动回退补上 upsert、代理层补 owner 校验。
 *
 * 本次新增（账号体系 + 双等级 + 管理后台），全部保持零 npm 依赖：
 *   - 账号：pbkdf2 密码哈希（node:crypto）+ JWT（HMAC-SHA256 手写）
 *   - 双等级：游戏等级 PUT 时合理性校验 + 会员等级 memberTier（按活跃度自动晋升，管理后台可覆盖）
 *   - 管理后台：/api/admin/* 走独立 x-admin-token，与玩家 JWT 隔离
 *
 * 安全红线：
 *   - INTERNAL_KEY / JWT_SECRET 只存在于本进程环境变量
 *   - 绝不转发客户端的任何请求头，全部由本文件重新构造
 *   - 只允许访问 /api/t2data/c/{COLLECTION_*}/ 前缀（微家事网关侧再转发到 weijiashi 租户）
 *
 * 开发/测试：LAKE_BASE 以 `memory` 开头时启用内存存储适配器，无需真实数据湖即可端到端验证。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// ---------- 配置 ----------
const PORT = Number(process.env.PORT || 8787);
const LAKE = (process.env.LAKE_BASE || 'https://your-data-lake.example.com').replace(/\/$/, '');
const TENANT = process.env.LAKE_TENANT || 'cloudlet';
// 集合（表）名统一加 cloudlet_ 前缀，避免与同数据湖下其他应用的表冲突
const COLLECTION_SAVES = process.env.LAKE_COLLECTION || 'cloudlet_saves';
const COLLECTION_ACCOUNTS = process.env.LAKE_COLLECTION_ACCOUNTS || 'cloudlet_accounts';
const COLLECTION_USERNAMES = process.env.LAKE_COLLECTION_USERNAMES || 'cloudlet_usernames';
// 覆盖前快照：多设备「最后写入者胜 + 整体覆盖」会静默丢进度，这里给每次覆盖留一份旧档副本。
const COLLECTION_HISTORY = process.env.LAKE_COLLECTION_HISTORY || 'cloudlet_saves_history';
// 每个账号保留的份数，以及最小快照间隔（自动同步每 60s 一次，不设间隔会把历史冲成几分钟）
const HISTORY_KEEP = Number(process.env.SAVE_HISTORY_KEEP || 12);
const SNAPSHOT_MIN_INTERVAL_MS = Number(process.env.SAVE_SNAPSHOT_INTERVAL_MS || 10 * 60_000);
const INTERNAL_KEY = process.env.INTERNAL_KEY;
// 路C：对接微家事通用网关，经 /api/t2data 通道（T2 account JWT）代理到数据湖。
// 持有微家事网关的 Ed25519 私钥，为每个玩家签 T2 JWT，由微家事网关转发到
// 数据湖的 weijiashi 租户；cloudlet 数据用 cloudlet_ 前缀集合名隔离。
const GATEWAY_MODE = !!process.env.GATEWAY_KEY;
const GATEWAY_BASE = (process.env.GATEWAY_BASE || 'https://your-gateway.example.com').replace(/\/$/, '');
const GATEWAY_KEY = process.env.GATEWAY_KEY ? process.env.GATEWAY_KEY.replace(/\\n/g, '\n') : '';
// T2 JWT 的两个身份声明，故意都不设默认值（见下方启动守卫）：
//   aid = 该租户在数据湖 tenants 表里记录的 app_id，配错会被上游 403 app mismatch；
//   aud = 数据湖域名，配错会被上游 401 bad aud。
// 历史上这里给 aid 留过 'jiashiben' 默认值，导致未配置时每条数据湖请求都 403，
// 而登录接口又把 403 映射成「用户名或密码错误」，长期被误判为密码问题。
const GATEWAY_APP_ID = process.env.GATEWAY_APP_ID || '';
const GATEWAY_AUD = process.env.GATEWAY_AUD || '';
// 路A：直接对接微家事网关的 T4 数据层（/api/t4data），用 data 作用域 API Key 鉴权
const T4_MODE = !!process.env.T4_KEY;
const T4_BASE = (process.env.T4_BASE || 'https://your-gateway.example.com/api/t4data').replace(/\/$/, '');
const T4_KEY = process.env.T4_KEY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const PBKDF2_ITER = Number(process.env.PBKDF2_ITER || 120_000);
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
const MEMORY_MODE = LAKE.startsWith('memory');
// 管理令牌：生产必须显式设置；内存模式下未设置则放行 'admin' 便于本地测
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || (MEMORY_MODE ? 'admin' : '');

const MAX_BYTES = 200 * 1024;
const TIMEOUT_MS = 20000;

// 管理后台静态页：默认读取 deploy/admin.html，可用 ADMIN_HTML 覆盖
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = process.env.ADMIN_HTML || path.join(__dirname, '..', 'deploy', 'admin.html');
let adminHtmlCache = null;
function serveAdmin(res, cors) {
  try {
    if (adminHtmlCache === null) adminHtmlCache = fs.readFileSync(ADMIN_HTML, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cors });
    res.end(adminHtmlCache);
  } catch {
    send(res, 404, { error: 'admin page not found' }, cors);
  }
}
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

if (!JWT_SECRET) {
  console.error('[cloudlet-api] 缺少 JWT_SECRET，拒绝启动');
  process.exit(1);
}
if (!MEMORY_MODE && !T4_MODE && !INTERNAL_KEY && !GATEWAY_MODE) {
  console.error('[cloudlet-api] 缺少数据湖凭证：请设置 GATEWAY_KEY（微家事网关 T2 通道，路C）/ INTERNAL_KEY（原始通道，路B）/ T4_KEY（路A）');
  process.exit(1);
}
// 路C 的两个声明必须显式配置：缺任何一个都不会「降级可用」，只会让全部数据湖请求失败。
// 宁可启动即失败，也不要上线后表现为「登录始终失败」。
// 占位值也拦住：照抄 .env.example 时这些值非空，能绕过「是否为空」的检查
const isPlaceholder = (v) => /REPLACE_WITH|^your-|^<.*>$/i.test(String(v || ''));
if (GATEWAY_MODE && (!GATEWAY_APP_ID || isPlaceholder(GATEWAY_APP_ID))) {
  console.error(
    '[cloudlet-api] GATEWAY_APP_ID 缺失或仍是占位值：必须填该租户在数据湖 tenants 表里的 app_id' +
    '（cloudlet 租户归属 weijiashi）。配错时数据湖会对每条请求返回 403 forbidden: app mismatch',
  );
  process.exit(1);
}
if (GATEWAY_MODE && (!GATEWAY_AUD || isPlaceholder(GATEWAY_AUD))) {
  console.error(
    '[cloudlet-api] GATEWAY_AUD 缺失或仍是占位值：必须填数据湖域名（与上游 JWT aud 校验一致，如 data.example.com）。' +
    '配错时签发的 T2 令牌会被上游以 401 bad aud 拒绝',
  );
  process.exit(1);
}

// ---------- 密码哈希（pbkdf2，零依赖） ----------
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function fromB64url(s) {
  return Buffer.from(s, 'base64url');
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(pw, salt, PBKDF2_ITER, 32, 'sha256');
  return `pbkdf2$${PBKDF2_ITER}$${b64url(salt)}$${b64url(hash)}`;
}

export function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, iterS, saltS, hashS] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const iter = Number(iterS);
  const salt = fromB64url(saltS);
  const expected = fromB64url(hashS);
  const check = crypto.pbkdf2Sync(pw, salt, iter, 32, 'sha256');
  if (check.length !== expected.length) return false;
  return crypto.timingSafeEqual(check, expected);
}

// ---------- JWT（HMAC-SHA256 手写，零依赖） ----------
export function signJWT(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + Math.floor(TOKEN_TTL_MS / 1000) };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

export function verifyJWT(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expect = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest());
  // 令牌场景，恒定时间比较意义有限，但保持一致性
  if (sig.length !== expect.length || sig !== expect) return null;
  try {
    const body = JSON.parse(fromB64url(p).toString('utf8'));
    if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

// ---------- 等级 ----------
export function expForLevel(level) {
  return Math.floor(100 * Math.pow(level, 1.6));
}

const MAX_LEVEL_JUMP = 5;     // 两次存盘之间等级最多跨越 5 级（防刷级注入）
const MAX_LEVEL_INIT = 200;   // 首次/迁移建档允许的最高等级（防极端注入，正常游玩远不及）

/**
 * 游戏等级合理性校验（轻量防作弊，非完整重算）。
 * doc: 客户端存档的 {level, exp}；mirror: 服务端权威镜像（可能 null）。
 * loose: 首次建档/账号迁移时放开等级跳跃限制（仍挡住极端值）。
 *
 * 不变式：exp 必须低于当前等级容量 expForLevel(level) —— 即前端归一化后
 * 的经验永远不足以再升一级。localStorage 把 level 改成 99、exp 改成 0 这类
 * 注入会被「等级跳跃封顶」或「经验越界」直接拒绝。
 */
export function validateLevel(doc, mirror, loose = false) {
  const lvl = Number(doc?.level);
  const exp = Number(doc?.exp);
  if (!Number.isFinite(lvl) || !Number.isFinite(exp) || lvl < 1 || exp < 0) return { ok: false };
  // 经验不得超过当前等级容量（这是前端 deltas 归一化后的硬不变式）
  if (exp >= expForLevel(lvl)) return { ok: false };

  if (loose) {
    if (lvl > MAX_LEVEL_INIT) return { ok: false };
    return { ok: true, level: lvl, exp };
  }
  if (mirror) {
    if (lvl < mirror.level) return { ok: false };                 // 不倒退
    if (lvl > mirror.level + MAX_LEVEL_JUMP) return { ok: false }; // 等级跳跃封顶
  } else if (lvl > 10) {
    return { ok: false }; // 无镜像（全新账号首份存档）等级不应过高
  }
  return { ok: true, level: lvl, exp };
}

/** 会员等级：按累计游玩秒数自动晋升（管理后台可手动覆盖，只升不降） */
export function autoTier(playSeconds) {
  const s = Number(playSeconds) || 0;
  if (s >= 43_200) return 4; // 12h
  if (s >= 14_400) return 3; // 4h
  if (s >= 3600) return 2; // 1h
  return 1;
}

// ---------- 数据湖访问（统一接口，支持内存模式） ----------
const mem = new Map(); // key = `${collection}/${id}` → { id, doc, owner_openid, updated_at }

async function memLake(method, collection, id, ownerId, body) {
  const key = `${collection}/${id}`;
  const ok = (status) => status >= 200 && status < 300;
  if (method === 'GET') {
    const row = mem.get(key);
    if (!row) return { status: 404, ok: false, json: async () => ({}) };
    return { status: 200, ok: true, json: async () => row };
  }
  if (method === 'PUT') {
    const existing = mem.get(key);
    if (!existing) return { status: 404, ok: false, json: async () => ({}) };
    existing.doc = body.doc;
    existing.owner_openid = ownerId;
    existing.updated_at = Date.now();
    return { status: 200, ok: true, json: async () => existing };
  }
  if (method === 'POST') {
    // 与真实数据湖一致：POST 到集合根时 id 从 body 取（lakeUpsert 的创建分支就是这种调用）。
    // 之前直接用形参 id（此时为 undefined），导致所有「先 PUT 失败再 POST 创建」的行
    // 都堆到 `${collection}/undefined` 这个键上，本地内存模式注册完就登录不上。
    const rowId = id ?? body?.id;
    const postKey = `${collection}/${rowId}`;
    if (mem.has(postKey)) return { status: 409, ok: false, json: async () => ({}) };
    const row = { id: rowId, doc: body.doc, owner_openid: ownerId, updated_at: Date.now() };
    mem.set(postKey, row);
    return { status: 201, ok: true, json: async () => row };
  }
  if (method === 'DELETE') {
    mem.delete(key);
    return { status: 200, ok: true, json: async () => ({}) };
  }
  return { status: 405, ok: false, json: async () => ({}) };
}

/** 统一数据湖调用，返回 { status, ok, json() }，屏蔽内存 / 原始 cloudflarepool / 微家事 T4 网关 差异 */
async function lake(method, collection, id, ownerId, body, query = '') {
  if (MEMORY_MODE) return memLake(method, collection, id, ownerId, body);
  if (GATEWAY_MODE) return gwLake(method, collection, id, ownerId, body, 0, query);
  if (T4_MODE) return t4Lake(method, collection, id, ownerId, body, query);
  return rawLake(method, collection, id, ownerId, body, query);
}

/** 原始 cloudflarepool（X-Sync-Key 通道） */
async function rawLake(method, collection, id, ownerId, body, query = '') {
  const base = `/t/${encodeURIComponent(TENANT)}/c/${encodeURIComponent(collection)}`;
  const path = id ? `${base}/${encodeURIComponent(id)}` : `${base}${query}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${LAKE}${path}`, {
      method,
      headers: {
        'x-sync-key': INTERNAL_KEY,
        'x-user-id': ownerId,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const status = res.status;
    const ok = status >= 200 && status < 300;
    return { status, ok, json: async () => { try { return await res.json(); } catch { return {}; } } };
  } finally {
    clearTimeout(timer);
  }
}

/** 微家事网关 T4 数据层：/api/t4data/rows/{table}[/{id}]，Bearer API Key 鉴权 */
async function t4Lake(method, collection, id, ownerId, body, query = '') {
  const base = `${T4_BASE}/rows/${encodeURIComponent(collection)}`;
  const url = id ? `${base}/${encodeURIComponent(id)}` : `${base}${query || '?limit=1000'}`;
  const headers = { 'content-type': 'application/json', Authorization: 'Bearer ' + T4_KEY };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const payload = body === undefined || method === 'GET' || method === 'DELETE'
      ? undefined
      : JSON.stringify({ ...body, owner_openid: ownerId });
    const res = await fetch(url, { method, headers, body: payload, signal: ctrl.signal });
    const status = res.status;
    const ok = status >= 200 && status < 300;
    return { status, ok, json: async () => { try { return await res.json(); } catch { return {}; } } };
  } finally {
    clearTimeout(timer);
  }
}

/** 对接微家事通用网关：经 /api/t2data 通道（T2 account JWT）代理到数据湖。
 *  T2 JWT 带 tid:'cloudlet'，由微家事网关验签后路由到数据湖的独立 cloudlet 租户
 *  （/t/cloudlet/...）；集合名仍用 cloudlet_ 前缀以便可读性。 */
function signT2Jwt(sub, ttl = 3600) {
  const privateKey = crypto.createPrivateKey(GATEWAY_KEY);
  const header = { alg: 'EdDSA', typ: 'JWT', kid: 'gw1' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub,
    aid: GATEWAY_APP_ID,
    typ: 'account',
    tid: 'cloudlet',
    scp: ['user:read', 'user:write'],
    iss: 'gateway',
    aud: GATEWAY_AUD,
    iat: now,
    exp: now + ttl,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

async function gwLake(method, collection, id, ownerId, body, attempt = 0, query = '') {
  const base = `/api/t2data/c/${encodeURIComponent(collection)}`;
  const url = id
    ? `${GATEWAY_BASE}${base}/${encodeURIComponent(id)}`
    : `${GATEWAY_BASE}${base}${query}`;
  const token = signT2Jwt(ownerId || 'cloudlet-system');
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + token,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const payload =
      body === undefined || method === 'GET' || method === 'DELETE'
        ? undefined
        : JSON.stringify(body);
    const res = await fetch(url, { method, headers, body: payload, signal: ctrl.signal });
    const status = res.status;
    const ok = status >= 200 && status < 300;
    return { status, ok, json: async () => { try { return await res.json(); } catch { return {}; } } };
  } catch (e) {
    // 首次可能因微家事网关/数据湖冷启动超时，重试一次
    if (attempt < 1) return gwLake(method, collection, id, ownerId, body, attempt + 1, query);
    return { status: 504, ok: false, json: async () => ({ error: 'gateway timeout' }) };
  } finally {
    clearTimeout(timer);
  }
}

/** upsert：先 PUT，404 再 POST 创建 */
async function lakeUpsert(collection, id, doc, ownerId) {
  let r = await lake('PUT', collection, id, ownerId, { doc });
  if (r.status === 404) {
    // 数据湖通用集合 API：PUT 仅更新已存在行（不存在返回 404），
    // 因此 404 时 POST 到集合根（id 放 body）创建，而非 POST 到 /{id}（该路由不存在）。
    r = await lake('POST', collection, undefined, ownerId, { id, doc });
  }
  return r;
}

/** 列出某集合全部（管理后台用；统一把行规整为 doc 对象返回） */
async function lakeList(collection, ownerId, allOwners = false) {
  if (MEMORY_MODE) {
    const items = [];
    for (const [k, v] of mem) {
      if (!k.startsWith(`${collection}/`) || !v.doc) continue;
      // 内存模式没有「按密钥自动过滤 owner」这层，必须显式过滤，
      // 否则清理快照时会把别的账号的历史一起删掉。
      if (!allOwners && ownerId && v.owner_openid !== ownerId) continue;
      items.push(v.doc);
    }
    return items;
  }
  // 数据湖的列表默认是 owner=me（即令牌 sub 自己的行）。管理员要跨账号看列表，
  // 必须显式带 owner=all，否则永远返回空数组（曾经导致管理后台账号数恒为 0）。
  const r = await lake('GET', collection, null, ownerId || 'admin', undefined, allOwners ? '?owner=all' : '');
  if (!r.ok) return [];
  const data = await r.json().catch(() => ({}));
  const rows = data.rows || data.items || data.list || (Array.isArray(data) ? data : []);
  return rows.map((x) => (x && x.doc ? x.doc : x));
}

// ---------- 覆盖前快照 ----------
/** owner → 上一次快照时间。重启后清空，最多多存一份，不影响正确性。 */
const snapshotLastAt = new Map();
/** owner → 串行队列，避免并发写档时快照互相穿插 */
const snapshotQueues = new Map();

/** 只保留最近 HISTORY_KEEP 份 */
async function pruneSnapshots(owner) {
  if (!(HISTORY_KEEP > 0)) return;
  const items = (await lakeList(COLLECTION_HISTORY, owner)).filter((x) => x && x.id);
  if (items.length <= HISTORY_KEEP) return;
  const older = items
    .sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0))
    .slice(HISTORY_KEEP);
  for (const old of older) {
    const r = await lake('DELETE', COLLECTION_HISTORY, old.id, owner);
    if (!r.ok && r.status !== 404) console.warn('[save-history] 清理失败', old.id, r.status);
  }
}

/**
 * 把「即将被覆盖的那份存档」存进历史集合。
 * @param owner   账号 ID
 * @param prevRow 覆盖前读到的 saves 行（{doc, updated_at}）
 * @param force   跳过最小间隔限制（恢复存档时用）
 *
 * 全程 fire-and-forget：写档主流程只多了一次并行 GET，快照本身不占响应时间。
 * 失败只打日志，绝不影响玩家存档。
 */
function queueSnapshot(owner, prevRow, force = false) {
  const job = async () => {
    const prevDoc = prevRow && prevRow.doc;
    if (!prevDoc || typeof prevDoc !== 'object') return;
    const now = Date.now();
    if (!force && now - (snapshotLastAt.get(owner) || 0) < SNAPSHOT_MIN_INTERVAL_MS) return;

    const id = `${owner}-${now}-${crypto.randomBytes(3).toString('hex')}`;
    const entry = {
      id,
      owner,
      savedAt: now,                                  // 快照生成时间
      replacedAt: Number(prevRow.updated_at) || 0,   // 被覆盖那份的写入时间
      level: Number(prevDoc.level) || 0,
      exp: Number(prevDoc.exp) || 0,
      bytes: Buffer.byteLength(JSON.stringify(prevDoc)),
      doc: prevDoc,
    };
    const w = await lake('POST', COLLECTION_HISTORY, undefined, owner, { id, doc: entry });
    if (!w.ok) {
      console.warn('[save-history] 快照写入失败', owner.slice(-8), w.status);
      return;
    }
    snapshotLastAt.set(owner, now);
    await pruneSnapshots(owner);
  };

  const prev = snapshotQueues.get(owner) || Promise.resolve();
  const next = prev.then(job).catch((e) => console.warn('[save-history] 快照异常', owner.slice(-8), e?.message));
  snapshotQueues.set(owner, next);
  next.finally(() => { if (snapshotQueues.get(owner) === next) snapshotQueues.delete(owner); });
  return next;
}

// ---------- 账号业务 ----------
function profileOf(accountDoc) {
  return {
    username: accountDoc.username,
    accountId: accountDoc.accountId,
    memberTier: accountDoc.memberTier,
    level: accountDoc.level,
    exp: accountDoc.exp,
  };
}

export async function registerUser(username, password) {
  const norm = String(username || '').toLowerCase().trim();
  if (!USERNAME_RE.test(norm)) return { error: '用户名需 3-20 位字母/数字/下划线', status: 400 };
  if (typeof password !== 'string' || password.length < 6) return { error: '密码至少 6 位', status: 400 };

  // 用户名查重（by-id 索引）
  const uname = await lake('GET', COLLECTION_USERNAMES, norm, norm);
  if (uname.status === 200) return { error: '用户名已被占用', status: 409 };

  const accountId = crypto.randomUUID();
  const accountDoc = {
    id: accountId,
    username,
    accountId,
    passwordHash: hashPassword(password),
    memberTier: 1,
    level: 1,
    exp: 0,
    synced: false,
    devices: [],
    createdAt: Date.now(),
    lastLogin: 0,
    banned: false,
  };

  // 先建账号，再建用户名索引（索引用于登录解析 + 查重）
  let r = await lakeUpsert(COLLECTION_ACCOUNTS, accountId, accountDoc, accountId);
  if (!r.ok) return { error: `lake ${r.status}`, status: 502 };
  r = await lakeUpsert(COLLECTION_USERNAMES, norm, { norm, accountId }, accountId);
  if (!r.ok) return { error: `lake ${r.status}`, status: 502 };

  const token = signJWT({ sub: accountId, username, accountId });
  return { status: 200, token, profile: profileOf(accountDoc) };
}

/**
 * 上游故障的统一回应。
 * 关键点：403/502/超时属于「基础设施不可用」，绝不能伪装成「用户名或密码错误」——
 * 否则一次配置错误会被误判成用户忘记密码，排障方向完全跑偏。
 */
function upstreamUnavailable(status) {
  return { error: `数据服务暂不可用（上游 HTTP ${status}），请稍后重试`, status: 502 };
}

export async function loginUser(username, password) {
  const norm = String(username || '').toLowerCase().trim();
  const uname = await lake('GET', COLLECTION_USERNAMES, norm, norm);
  // 404 = 用户名不存在，按凭据错误处理（不泄露账号是否存在）
  if (uname.status === 404) return { error: '用户名或密码错误', status: 401 };
  if (uname.status !== 200) return upstreamUnavailable(uname.status);
  const { accountId } = (await uname.json()).doc || {};
  if (!accountId) return { error: '用户名或密码错误', status: 401 };

  const acc = await lake('GET', COLLECTION_ACCOUNTS, accountId, accountId);
  if (acc.status === 404) return { error: '用户名或密码错误', status: 401 };
  if (acc.status !== 200) return upstreamUnavailable(acc.status);
  const row = await acc.json();
  if (row.owner_openid !== accountId) return { error: 'not found', status: 401 };
  const doc = row.doc;
  if (!verifyPassword(password, doc.passwordHash)) return { error: '用户名或密码错误', status: 401 };
  if (doc.banned) return { error: '账号已被封禁', status: 403 };

  // 更新最后登录
  doc.lastLogin = Date.now();
  await lake('PUT', COLLECTION_ACCOUNTS, accountId, accountId, { doc });

  const token = signJWT({ sub: accountId, username: doc.username, accountId });
  return { status: 200, token, profile: profileOf(doc) };
}

/** 从 JWT 取档案（并回源账号拿最新 memberTier/level，反映后台改动） */
export async function profileFromToken(authHeader) {
  const m = /^Bearer\s+(.+)$/i.exec(authHeader || '');
  const claims = verifyJWT(m?.[1]);
  if (!claims || !claims.accountId) return null;
  const acc = await lake('GET', COLLECTION_ACCOUNTS, claims.accountId, claims.accountId);
  if (acc.status === 404) return null;
  if (acc.status !== 200) {
    // 上游故障 ≠ 令牌失效：这里若返回 null，前端会把用户静默登出且看不到真实原因
    throw Object.assign(new Error(`数据服务暂不可用（上游 HTTP ${acc.status}）`), { status: 502 });
  }
  const row = await acc.json();
  if (row.owner_openid !== claims.accountId) return null;
  return profileOf(row.doc);
}

// ---------- HTTP 工具 ----------
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

function corsHeaders() {
  if (!ALLOWED_ORIGIN) return {};
  return {
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS,PATCH',
    'access-control-allow-headers': 'content-type,authorization,x-admin-token',
    'access-control-max-age': '86400',
  };
}

// 轻量限流：单 IP 令牌桶
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

function authToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
  return m?.[1] || null;
}

function requireAdmin(req) {
  const t = req.headers['x-admin-token'];
  return !!ADMIN_TOKEN && t === ADMIN_TOKEN;
}

// ---------- 路由 ----------
async function handleSave(req, res, cors) {
  // 维护期只读开关：CLOUD_READONLY=1 时拒绝任何写入，冻结云端存档，防止客户端互殴覆盖。
  // 读取/拉取（GET/POST）不受影响，客户端仍可下载核对。解除时置 0 或删掉变量即可。
  if (process.env.CLOUD_READONLY === '1' && req.method !== 'GET' && req.method !== 'POST') {
    return send(res, 423, { error: '云端维护中（只读），暂不接受保存', readonly: true }, cors);
  }
  const url = req.urlObj;
  let owner = url.searchParams.get('owner') ?? url.searchParams.get('device') ?? '';
  const token = authToken(req);

  let mode = 'device';
  if (token) {
    const claims = verifyJWT(token);
    if (!claims || !claims.accountId) return send(res, 401, { error: 'invalid token' }, cors);
    // 账号模式 owner 直接取自令牌，客户端不可伪造（忽略其传入的 owner）
    owner = claims.accountId;
    mode = 'account';
  } else if (!UUID_V4.test(owner)) {
    return send(res, 400, { error: 'invalid owner id' }, cors);
  }

  const path = `${COLLECTION_SAVES}/${encodeURIComponent(owner)}`;

  // POST 与 GET 共用拉取分支：部分 CDN 会无视 Cache-Control 缓存 GET /api/save 的陈旧响应，
  // 前端因此改用 POST 拉档（POST 永不被缓存）。决策见 docs/sync-incident-and-redesign.md。
  if (req.method === 'GET' || req.method === 'POST') {
    const r = await lake('GET', COLLECTION_SAVES, owner, owner);
    if (r.status === 404) return send(res, 404, { error: 'not found' }, cors);
    if (!r.ok) return send(res, 502, { error: `lake ${r.status}` }, cors);
    const row = await r.json();
    if (row.owner_openid !== owner) return send(res, 404, { error: 'not found' }, cors);
    return send(res, 200, { doc: row.doc, updatedAt: row.updated_at }, cors);
  }

  if (req.method === 'PUT') {
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'invalid json' }, cors);
    }
    if (!parsed || typeof parsed.doc !== 'object' || parsed.doc === null) {
      return send(res, 400, { error: 'doc required' }, cors);
    }

    // 账号模式下做双等级处理：游戏等级合理性校验 + 会员等级自动晋升
    let accP = null;
    let prevRow = null;
    if (mode === 'account') {
      // 覆盖前先读旧存档：与下面的账号读取并行发出，不额外增加一次串行往返。
      // 必须在 PUT 之前拿到，否则读到的是刚写进去的新值，快照就失去意义。
      const prevP = lake('GET', COLLECTION_SAVES, owner, owner);
      const acc = await lake('GET', COLLECTION_ACCOUNTS, owner, owner);
      if (acc.status !== 200) return send(res, 502, { error: `lake ${acc.status}` }, cors);
      const row = await acc.json();
      if (row.owner_openid !== owner) return send(res, 403, { error: 'forbidden' }, cors);
      const mirror = { level: row.doc.level, exp: row.doc.exp };
      const firstSync = !row.doc.synced; // 首次建档/账号迁移：放开等级跳跃限制
      // 显式导入存档码 ?import=1 也走 loose：放开等级跳跃，但仍封顶 MAX_LEVEL_INIT 且禁止经验越界
      const importMode = url.searchParams.get('import') === '1';
      const loose = firstSync || importMode;
      const v = validateLevel(parsed.doc, loose ? null : mirror, loose);
      if (!v.ok) return send(res, 400, { error: '等级数据异常，已拒绝保存' }, cors);
      const doc = row.doc;
      doc.synced = true;
      doc.level = v.level;
      doc.exp = v.exp;
      const playSeconds = parsed.doc?.stats?.playSeconds || 0;
      doc.memberTier = Math.max(Number(doc.memberTier) || 1, autoTier(playSeconds));
      // 账号镜像更新与存档写入相互独立，并行发起省去一次上游往返（约 2.5s）。
      // 这里只发起、不 await，等存档写入完成后再取结果。
      accP = lake('PUT', COLLECTION_ACCOUNTS, owner, owner, { doc });

      const prevRes = await prevP;
      if (prevRes.status === 200) {
        const prevJson = await prevRes.json();
        if (prevJson && prevJson.owner_openid === owner && prevJson.doc) {
          // 必须深拷贝：内存模式下 GET 返回的是存储行的活引用，随后的 PUT 会就地替换
          // 其中的 doc，直接持有引用会让快照存成「覆盖后的新值」，失去回滚意义。
          prevRow = { doc: JSON.parse(JSON.stringify(prevJson.doc)), updated_at: prevJson.updated_at };
        }
      }
    }

    // 写存档（与账号镜像更新并行）
    let r = await lake('PUT', COLLECTION_SAVES, owner, owner, { doc: parsed.doc });
    if (r.status === 404) {
      r = await lake('POST', COLLECTION_SAVES, undefined, owner, { id: owner, doc: parsed.doc });
    }
    if (accP) {
      const ur = await accP;
      if (!ur.ok) return send(res, 502, { error: `lake ${ur.status}` }, cors);
    }
    if (!r.ok) return send(res, 502, { error: `lake ${r.status}` }, cors);
    // 写成功后再落快照，异步执行，不占本次响应时间
    if (prevRow) queueSnapshot(owner, prevRow);
    return send(res, 200, { ok: true, updatedAt: Date.now() }, cors);
  }

  if (req.method === 'DELETE') {
    const r = await lake('DELETE', COLLECTION_SAVES, owner, owner);
    if (!r.ok && r.status !== 404) return send(res, 502, { error: `lake ${r.status}` }, cors);
    return send(res, 200, { ok: true }, cors);
  }

  return send(res, 405, { error: 'method not allowed' }, cors);
}

async function handleAdmin(req, res, cors) {
  if (!requireAdmin(req)) return send(res, 401, { error: 'unauthorized' }, cors);
  const url = req.urlObj;
  const parts = url.pathname.split('/').filter(Boolean); // ['api','admin', ...]
  const sub = parts[2] || '';
  const id = parts[3] || '';

  if (sub === 'stats' && req.method === 'GET') {
    const accounts = await lakeList(COLLECTION_ACCOUNTS, 'admin', true);
    const now = Date.now();
    const week = now - 7 * 24 * 3600 * 1000;
    const stats = {
      total: accounts.length,
      activeWeek: accounts.filter((a) => (a.lastLogin || 0) >= week).length,
      banned: accounts.filter((a) => a.banned).length,
    };
    return send(res, 200, stats, cors);
  }

  if (sub === 'accounts') {
    if (req.method === 'GET') {
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size')) || 20));
      const q = (url.searchParams.get('q') || '').toLowerCase().trim();
      const all = await lakeList(COLLECTION_ACCOUNTS, 'admin', true);
      const summary = all
        .map((a) => ({
          accountId: a.accountId,
          username: a.username,
          memberTier: a.memberTier,
          level: a.level,
          exp: a.exp,
          lastLogin: a.lastLogin || 0,
          deviceCount: (a.devices || []).length,
          banned: !!a.banned,
          createdAt: a.createdAt || 0,
        }))
        .filter((a) => (q ? String(a.username || '').toLowerCase().includes(q) : true));
      const start = (page - 1) * size;
      return send(res, 200, {
        total: summary.length,
        page,
        size,
        items: summary.slice(start, start + size),
      }, cors);
    }
    // 单账号操作需要 id
    if (!UUID_V4.test(id)) return send(res, 400, { error: 'invalid account id' }, cors);

    if (req.method === 'GET') {
      const r = await lake('GET', COLLECTION_ACCOUNTS, id, id);
      if (!r.ok) return send(res, r.status === 404 ? 404 : 502, { error: 'not found' }, cors);
      return send(res, 200, (await r.json()).doc, cors);
    }

    if (req.method === 'PATCH') {
      const r = await lake('GET', COLLECTION_ACCOUNTS, id, id);
      if (r.status !== 200) return send(res, r.status === 404 ? 404 : 502, { error: 'not found' }, cors);
      const row = await r.json();
      const doc = row.doc;
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* ignore */ }
      if (typeof body.memberTier === 'number') doc.memberTier = Math.max(1, Math.floor(body.memberTier));
      if (typeof body.banned === 'boolean') doc.banned = body.banned;
      const ur = await lake('PUT', COLLECTION_ACCOUNTS, id, id, { doc });
      if (!ur.ok) return send(res, 502, { error: `lake ${ur.status}` }, cors);
      return send(res, 200, profileOf(doc), cors);
    }

    if (req.method === 'DELETE') {
      const r = await lake('DELETE', COLLECTION_ACCOUNTS, id, id);
      if (!r.ok && r.status !== 404) return send(res, 502, { error: `lake ${r.status}` }, cors);
      // 连带删除用户名索引与存档
      const acc = await lake('GET', COLLECTION_ACCOUNTS, id, id).catch(() => ({ status: 404 }));
      if (acc.status === 200) {
        const norm = (await acc.json()).doc?.username?.toLowerCase();
        if (norm) await lake('DELETE', COLLECTION_USERNAMES, norm, id).catch(() => {});
      }
      await lake('DELETE', COLLECTION_SAVES, id, id).catch(() => {});
      return send(res, 200, { ok: true }, cors);
    }
  }

  // ---------- 存档历史（覆盖前快照）：/api/admin/saves/{accountId}/... ----------
  if (sub === 'saves') {
    if (!UUID_V4.test(id)) return send(res, 400, { error: 'invalid account id' }, cors);
    const action = parts[4] || '';

    // 列出该账号最近的快照（不返回正文，避免几十 KB × N 撑爆响应）
    if (action === 'history' && req.method === 'GET') {
      const items = (await lakeList(COLLECTION_HISTORY, id))
        .filter((x) => x && x.id)
        .map((x) => ({
          id: x.id,
          savedAt: x.savedAt || 0,
          replacedAt: x.replacedAt || 0,
          level: x.level,
          exp: x.exp,
          bytes: x.bytes,
        }))
        .sort((a, b) => b.savedAt - a.savedAt);
      return send(res, 200, { total: items.length, keep: HISTORY_KEEP, items }, cors);
    }

    // 回滚到指定快照：先把「当前档」也快照一份，恢复动作本身也可撤销
    if (action === 'restore' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* ignore */ }
      if (!body.historyId) return send(res, 400, { error: 'historyId required' }, cors);

      const hr = await lake('GET', COLLECTION_HISTORY, body.historyId, id);
      if (hr.status !== 200) return send(res, 404, { error: 'snapshot not found' }, cors);
      const snap = (await hr.json()).doc;
      if (!snap || typeof snap.doc !== 'object' || snap.doc === null) {
        return send(res, 400, { error: 'bad snapshot' }, cors);
      }

      const cur = await lake('GET', COLLECTION_SAVES, id, id);
      if (cur.status === 200) {
        const crow = await cur.json();
        if (crow && crow.doc) await queueSnapshot(id, crow, true);
      }

      let w = await lake('PUT', COLLECTION_SAVES, id, id, { doc: snap.doc });
      if (w.status === 404) {
        w = await lake('POST', COLLECTION_SAVES, undefined, id, { id, doc: snap.doc });
      }
      if (!w.ok) return send(res, 502, { error: `lake ${w.status}` }, cors);

      // 同步账号镜像的等级，否则客户端下次推送会被「等级跳变」判 400
      const ar = await lake('GET', COLLECTION_ACCOUNTS, id, id);
      if (ar.status === 200) {
        const arow = await ar.json();
        if (arow && arow.doc) {
          const doc = arow.doc;
          doc.level = Number(snap.doc.level) || doc.level;
          doc.exp = Number(snap.doc.exp) || 0;
          doc.synced = true;
          await lake('PUT', COLLECTION_ACCOUNTS, id, id, { doc });
        }
      }
      return send(res, 200, {
        ok: true,
        restoredFrom: snap.id || body.historyId,
        savedAt: snap.savedAt || 0,
        level: snap.doc.level,
        exp: snap.doc.exp,
      }, cors);
    }

    return send(res, 404, { error: 'not found' }, cors);
  }

  return send(res, 404, { error: 'not found' }, cors);
}

const server = http.createServer(async (req, res) => {
  const cors = corsHeaders();
  req.urlObj = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  // 管理后台静态页（与 /api 同进程托管，省去单独 nginx 配置）
  if (req.urlObj.pathname === '/admin' || req.urlObj.pathname === '/admin.html') {
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' }, cors);
    return serveAdmin(res, cors);
  }

  if (!req.urlObj.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' }, cors);

  const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim())
    || (req.headers['x-real-ip'])
    || req.socket.remoteAddress
    || 'unknown';
  if (!rateLimit(ip)) return send(res, 429, { error: 'too many requests' }, cors);

  try {
    const p = req.urlObj.pathname;

    if (p === '/api/health') {
      return send(res, 200, {
        ok: true,
        mode: GATEWAY_MODE ? 'gateway' : (T4_MODE ? 't4' : (MEMORY_MODE ? 'memory' : 'raw')),
        memory: MEMORY_MODE,
        // 便于一眼核对 T2 令牌的 aid 是否指向正确的 app（历史上配错会表现为登录始终失败）
        ...(GATEWAY_MODE ? { app: GATEWAY_APP_ID } : {}),
      }, cors);
    }

    if (p === '/api/auth/register') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, cors);
      const body = JSON.parse(await readBody(req).catch(() => '{}'));
      const r = await registerUser(body.username, body.password);
      return send(res, r.status, r.error ? { error: r.error } : r, cors);
    }

    if (p === '/api/auth/login') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, cors);
      const body = JSON.parse(await readBody(req).catch(() => '{}'));
      const r = await loginUser(body.username, body.password);
      return send(res, r.status, r.error ? { error: r.error } : r, cors);
    }

    if (p === '/api/auth/me') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' }, cors);
      const profile = await profileFromToken(req.headers['authorization']);
      if (!profile) return send(res, 401, { error: 'unauthorized' }, cors);
      return send(res, 200, profile, cors);
    }

    if (p === '/api/save') {
      // 请求日志：包裹 res.end，记录方法/owner/状态/字节/耗时，便于直读排查同步问题
      const _t0 = Date.now();
      const _m = req.method;
      const _o = (new URL(req.url, 'http://localhost').searchParams.get('owner') || '').slice(-8);
      const _origEnd = res.end.bind(res);
      res.end = (chunk, ...rest) => {
        const ms = Date.now() - _t0;
        const bytes = chunk && chunk.length ? chunk.length : 0;
        console.log(`[save] ${_m} owner=...${_o} status=${res.statusCode} bytes=${bytes} ${ms}ms`);
        return _origEnd(chunk, ...rest);
      };
      return handleSave(req, res, cors);
    }

    if (p.startsWith('/api/admin/')) {
      return handleAdmin(req, res, cors);
    }

    return send(res, 404, { error: 'not found' }, cors);
  } catch (err) {
    const status = err?.status ?? 500;
    return send(res, status, { error: err?.message ?? 'internal error' }, cors);
  }
});

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  server.listen(PORT, () => {
    console.log(`[cloudlet-api] listening on ${PORT} → ${LAKE} (memory=${MEMORY_MODE})`);
  });
}

export { server };
