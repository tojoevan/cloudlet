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
  deviceId: string,
  body?: unknown,
): Promise<RequestResult> {
  if (isPaused()) return { ok: false, status: 0, skipped: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`/api/save?device=${encodeURIComponent(deviceId)}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (res.status === 404) {
      settle(true);
      return { ok: true, status: 404 };
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

export async function cloudPull(deviceId: string): Promise<{ status: SyncStatus; doc?: GameState; updatedAt?: number }> {
  const r = await request('GET', deviceId);
  if (r.skipped) return { status: 'paused' };
  if (!r.ok) return { status: r.status === 0 ? 'unavailable' : 'error' };
  if (!r.data?.doc) return { status: 'ok' };
  return { status: 'ok', doc: r.data.doc, updatedAt: r.data.updatedAt };
}

export async function cloudPush(deviceId: string, state: GameState): Promise<SyncStatus> {
  const r = await request('PUT', deviceId, { doc: state });
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
