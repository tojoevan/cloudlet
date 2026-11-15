/**
 * 账号登录态管理（零依赖）。
 *
 * 设计要点：
 * - JWT 仅「客户端解码」用于即时展示用户名/会员等级，绝不用于鉴权——
 *   权威数据一律来自服务端 /api/auth/me（后台改 memberTier 后能立刻反映）。
 * - local-first：未登录时游戏完全不受影响，存档走设备 UUID 模式。
 * - 登录态持久化在 localStorage，刷新页面自动恢复；令牌失效则静默清除。
 */

const TOKEN_KEY = 'cloudlet.token';
const PROFILE_KEY = 'cloudlet.profile';

export interface AuthProfile {
  username: string;
  accountId: string;
  memberTier: number;
  level: number;
  exp: number;
}

// ---------- 底层 ----------

function b64urlDecode(s: string): string {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  try {
    return decodeURIComponent(escape(atob(norm + pad)));
  } catch {
    return '';
  }
}

/** 仅解码载荷用于展示，不验证签名（防篡改以服务端为准）。 */
function decodeJWT(token: string): { accountId?: string; username?: string } | null {
  const p = token.split('.')[1];
  if (!p) return null;
  try {
    const o = JSON.parse(b64urlDecode(p));
    return { accountId: o.accountId, username: o.username };
  } catch {
    return null;
  }
}

function readJSON<T>(key: string): T | null {
  try {
    const r = localStorage.getItem(key);
    return r ? (JSON.parse(r) as T) : null;
  } catch {
    return null;
  }
}

let memProfile: AuthProfile | null = readJSON<AuthProfile>(PROFILE_KEY);

// ---------- 对外查询 ----------

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

export function accountId(): string | null {
  return memProfile?.accountId ?? decodeJWT(getToken() ?? '')?.accountId ?? null;
}

export function memberTier(): number {
  return memProfile?.memberTier ?? 1;
}

export function username(): string | null {
  return memProfile?.username ?? null;
}

// ---------- 写入 ----------

function persist(profile: AuthProfile, token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  memProfile = profile;
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PROFILE_KEY);
  memProfile = null;
}

// ---------- 网络 ----------

async function postJSON(url: string, body: unknown): Promise<{ status: number; data: any }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data: any = {};
    try {
      data = await res.json();
    } catch {
      /* 空响应或非 JSON */
    }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: {} };
  }
}

function toProfile(data: any): AuthProfile {
  return {
    username: data.profile.username,
    accountId: data.profile.accountId,
    memberTier: data.profile.memberTier ?? 1,
    level: data.profile.level ?? 1,
    exp: data.profile.exp ?? 0,
  };
}

export interface AuthResult {
  ok: boolean;
  error?: string;
  profile?: AuthProfile;
}

function applyAuth(data: any): AuthResult {
  if (!data?.token || !data?.profile) return { ok: false, error: '服务端返回异常' };
  const profile = toProfile(data);
  persist(profile, data.token);
  return { ok: true, profile };
}

export async function login(username: string, password: string): Promise<AuthResult> {
  const { status, data } = await postJSON('/api/auth/login', { username, password });
  if (status !== 200) return { ok: false, error: data?.error || '用户名或密码错误' };
  return applyAuth(data);
}

export async function register(username: string, password: string): Promise<AuthResult> {
  const { status, data } = await postJSON('/api/auth/register', { username, password });
  if (status !== 200) return { ok: false, error: data?.error || '注册失败' };
  return applyAuth(data);
}

/** 用本地令牌回源服务端拿最新档案（反映后台改动的 memberTier/封禁）。失败则清除登录态。 */
export async function refresh(): Promise<AuthProfile | null> {
  const token = getToken();
  if (!token) return null;
  try {
    // 加超时保护：/api/auth/me 是 GET，在部分 CDN 上可能挂起，
    // 不能让会员刷新拖垮调用方（同步等）。
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch('/api/auth/me', {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    // 只有 401 才是「令牌真的失效」。502/503/超时是上游故障，
    // 若也在这里 logout()，用户会被静默踢下线、还看不到真实原因。
    if (res.status === 401) {
      logout();
      return null;
    }
    if (!res.ok) return memProfile;
    const data = await res.json();
    const profile: AuthProfile = {
      username: data.username,
      accountId: data.accountId,
      memberTier: data.memberTier ?? 1,
      level: data.level ?? 1,
      exp: data.exp ?? 0,
    };
    memProfile = profile;
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    return profile;
  } catch {
    return memProfile;
  }
}

/** 启动恢复：有令牌就回源刷新，失效则静默清除。 */
export async function restore(): Promise<AuthProfile | null> {
  if (!getToken()) return null;
  return refresh();
}
