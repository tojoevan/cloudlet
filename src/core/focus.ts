import type { GameState } from './types';

export const FOCUS_PRESETS = [25, 45] as const;
/** 专注期间收益与生产速度倍率 */
export const FOCUS_MULT = 1.5;

export function isFocusing(state: GameState, now: number): boolean {
  return state.focus.until > now;
}

/** 0~1，用于进度环 */
export function focusProgress(state: GameState, now: number): number {
  if (!isFocusing(state, now)) return 0;
  const elapsed = now - state.focus.startedAt;
  if (state.focus.totalMs <= 0) return 1;
  return Math.min(1, Math.max(0, elapsed / state.focus.totalMs));
}

export function focusRemainMs(state: GameState, now: number): number {
  return Math.max(0, state.focus.until - now);
}

const EMPTY_FOCUS = { until: 0, startedAt: 0, totalMs: 0, harvested: 0, planted: 0, produced: 0 };

export function startFocus(state: GameState, minutes: number, now: number): void {
  const totalMs = minutes * 60_000;
  state.focus = { startedAt: now, totalMs, until: now + totalMs, harvested: 0, planted: 0, produced: 0 };
}

/** 中途放弃：按已完成分钟数折半结算，不让人白坐 */
export function cancelFocus(
  state: GameState,
  now: number,
): { gems: number; minutes: number; harvested: number; planted: number; produced: number } | null {
  if (!isFocusing(state, now)) return null;
  const done = Math.floor((now - state.focus.startedAt) / 60_000);
  const gems = Math.floor(done / 25);
  if (gems > 0) state.gems += gems;
  state.stats.focusMinutes += done;

  const { harvested, planted, produced } = state.focus;
  state.focus = { ...EMPTY_FOCUS };
  return { gems, minutes: done, harvested, planted, produced };
}

export interface FocusReward {
  gems: number;
  minutes: number;
  /** 这段专注里自动运转的战果：收了几块地、补种几块、工厂产出几批 */
  harvested: number;
  planted: number;
  produced: number;
}

/** 专注跑完的结算。没在专注或还没到点返回 null。 */
export function settleFocus(state: GameState, now: number): FocusReward | null {
  if (state.focus.until === 0 || now < state.focus.until) return null;
  const minutes = Math.round(state.focus.totalMs / 60_000);
  const gems = Math.max(1, Math.round(minutes / 12));
  state.gems += gems;
  state.stats.focusSessions += 1;
  state.stats.focusMinutes += minutes;

  const { harvested, planted, produced } = state.focus;
  state.focus = { ...EMPTY_FOCUS };
  return { gems, minutes, harvested, planted, produced };
}
