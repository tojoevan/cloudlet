import type { GameState } from './types';

/**
 * 云同步客户端。
 * 设计原则：local-first —— 任何失败都必须静默，绝不能打断游戏。
 * 后端没部署、断网、VPS 挂了，游戏都得照常能玩。
 */

export type SyncStatus = 'idle' | 'syncing' | 'ok' | 'error' | 'unavailable' | 'paused';

export interface CloudDoc {
  doc: GameState;
  updatedAt: number;
}

/**
 * 后端没起来（比如只跑了 npm run dev 没跑代理）时，同步请求会持续失败。
 * 不加以控制的话 console 会被 500 刷屏，还白白占着请求。
 * 连续失败若干次后暂停一段时间，手动同步可立即恢复。
 */
const FAIL_LIMIT = 3;
const PAUSE_MS = 5 * 60_000;

let failures = 0;
let pausedUntil = 0;

export function isPaused(): boolean {
  return Date.now() < pausedUntil;
}

/** 用户手动点「立即同步」时调用，立刻重试 */
export function resetPause(): void {
  failures = 0;
  pausedUntil = 0;
}

export function pauseRemainMs(): number {
  return Math.max(0, pausedUntil - Date.now());
}

function settle(ok: boolean): void {
  if (ok) {
    failures = 0;
    pausedUntil = 0;
    return;
  }
  failures += 1;
  if (failures >= FAIL_LIMIT) {
    pausedUntil = Date.now() + PAUSE_MS;
    failures = 0;
  }
}

interface RequestResult {
  ok: boolean;
  status: number;
  data?: CloudDoc;
  /** 处于退避暂停期，请求根本没发出去 */
  skipped?: boolean;
}

async function request(
  method: 'GET' | 'PUT',
  ownerId: string,
  token: string | null | undefined,
  body?: unknown,
): Promise<RequestResult> {
  if (isPaused()) return { ok: false, status: 0, skipped: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const params = new URLSearchParams();
    params.set('owner', ownerId);
    const headers: Record<string, string> = {};
    if (body) headers['content-type'] = 'application/json';
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(`/api/save?${params.toString()}`, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (res.status === 404) {
      settle(true);
      return { ok: true, status: 404 };
    }
    if (res.status === 400 && method === 'PUT') {
      // 等级校验未通过（疑似作弊或存档损坏）：当作错误，但不计入退避
      settle(true);
      return { ok: false, status: 400 };
    }
    if (!res.ok) {
      settle(false);
      return { ok: false, status: res.status };
    }
    const data = res.status === 204 ? undefined : ((await res.json()) as CloudDoc);
    settle(true);
    return { ok: true, status: res.status, data };
  } catch {
    settle(false);
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取存档。
 * @param ownerId 账号模式下为 accountId，未登录时为设备 UUID
 * @param token   登录态 JWT，未登录传 null
 */
export async function cloudPull(
  ownerId: string,
  token: string | null | undefined,
): Promise<{ status: SyncStatus; doc?: GameState; updatedAt?: number }> {
  const r = await request('GET', ownerId, token);
  if (r.skipped) return { status: 'paused' };
  if (!r.ok) return { status: r.status === 0 ? 'unavailable' : 'error' };
  if (!r.data?.doc) return { status: 'ok' };
  return { status: 'ok', doc: r.data.doc, updatedAt: r.data.updatedAt };
}

export async function cloudPush(
  ownerId: string,
  state: GameState,
  token: string | null | undefined,
): Promise<SyncStatus> {
  const r = await request('PUT', ownerId, token, { doc: state });
  if (r.skipped) return 'paused';
  if (!r.ok) return r.status === 0 ? 'unavailable' : 'error';
  return 'ok';
}

export function describeStatus(s: SyncStatus): string {
  switch (s) {
    case 'ok':
      return '云存档：已同步';
    case 'syncing':
      return '云存档：同步中';
    case 'error':
      return '云存档：同步失败（本地进度不受影响）';
    case 'unavailable':
      return '云存档：未连接（游戏照常可玩，进度存在本机）';
    case 'paused':
      return '云存档：未连接，已暂停自动重试。点「立即同步」可手动重试';
    default:
      return '云存档：待同步';
  }
}
