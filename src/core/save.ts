import { SAVE_VERSION } from './economy';
import { createInitialState } from './state';
import type { GameState } from './types';

const SAVE_KEY = 'cloudlet.save';
const DEVICE_KEY = 'cloudlet.device';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newDeviceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 兜底：手写 UUID v4
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isValidDeviceId(id: string): boolean {
  return UUID_V4.test(id);
}

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id || !isValidDeviceId(id)) {
    id = newDeviceId();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/**
 * 存档迁移链。每次结构变更加一个函数，老存档自动升级，不丢进度。
 * 目前只有 v1，框架先立好。
 */
const MIGRATIONS: Record<number, (s: any) => any> = {
  // v1 → v2：补上番茄钟、图鉴、成就三项长线系统
  1: (s) => ({
    ...s,
    version: 2,
    focus: s.focus ?? { until: 0, startedAt: 0, totalMs: 0 },
    codex: {
      crops: s.codex?.crops ?? [],
      products: s.codex?.products ?? [],
      buildings: s.codex?.buildings ?? [],
      factories: s.codex?.factories ?? [],
    },
    achievements: s.achievements ?? [],
    stats: {
      ...s.stats,
      focusSessions: s.stats?.focusSessions ?? 0,
      focusMinutes: s.stats?.focusMinutes ?? 0,
    },
  }),
};

export function migrate(raw: any): GameState {
  let s = raw;
  let v = s.version ?? 0;
  while (v < SAVE_VERSION) {
    const fn = MIGRATIONS[v];
    if (!fn) {
      // 没有迁移路径就重建，避免带着坏结构崩掉
      return createInitialState(s.deviceId ?? getDeviceId());
    }
    s = fn(s);
    v = s.version;
  }
  s.version = SAVE_VERSION;
  return s as GameState;
}

/** 补齐后续版本新增的设置项，老存档不至于因缺字段而行为异常 */
function normalize(s: GameState): GameState {
  s.settings ??= { channel: 'citypop', radioUrl: '', volume: 0.6, powerSave: false, cloudSync: false };
  s.settings.cloudSync ??= false;
  s.settings.powerSave ??= false;
  s.settings.channel ??= 'citypop';
  s.settings.volume ??= 0.6;
  return s;
}

export function loadLocal(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    return normalize(migrate(JSON.parse(raw)));
  } catch {
    return null;
  }
}

export function saveLocal(state: GameState): void {
  try {
    state.savedAt = Date.now();
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch {
    // 配额满或隐私模式：静默失败，游戏继续可玩
  }
}

export function clearLocal(): void {
  localStorage.removeItem(SAVE_KEY);
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 存档码：跨设备手动迁移用。云端同步之外的兜底手段。 */
export function exportCode(state: GameState): string {
  return toBase64(JSON.stringify(state));
}

export function importCode(code: string): GameState | null {
  try {
    const s = JSON.parse(fromBase64(code.trim()));
    if (!s || typeof s !== 'object' || !s.plots) return null;
    return migrate(s);
  } catch {
    return null;
  }
}
