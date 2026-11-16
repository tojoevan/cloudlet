/**
 * 自动画质的判定逻辑（纯函数，便于测试）。
 *
 * 规则：单帧超过 40ms（低于 25fps）就累加，正常帧则缓慢回退；
 * 累计到 6 秒触发一次降档。只降不升，避免在临界帧率来回抖动。
 */
export const SLOW_FRAME_MS = 40;
export const DOWNGRADE_AFTER_MS = 6000;

export function accumulateSlowMs(prev: number, rawInterval: number): number {
  if (rawInterval > SLOW_FRAME_MS) return prev + rawInterval;
  return Math.max(0, prev - rawInterval * 0.5);
}

export function shouldDowngrade(accMs: number): boolean {
  return accMs >= DOWNGRADE_AFTER_MS;
}
