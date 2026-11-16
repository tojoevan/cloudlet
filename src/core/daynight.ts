/**
 * 昼夜的玩法耦合。
 *
 * 设计原则：夜里**不惩罚**玩家——放置游戏的大部分时间玩家在睡觉，
 * 如果夜间减产，"睡一觉进度变慢"会很挫败。
 * 所以夜里给的是**另一种节奏**而不是惩罚：作物长得略快（露水），
 * 被动收益略高（夜市），白天则更依赖订单与建设。
 */
export interface DayNightBonus {
  /** 作物生长倍率 */
  crop: number;
  /** 被动收益倍率 */
  income: number;
  /** 当前是否是夜里 */
  night: boolean;
}

const DAY: DayNightBonus = { crop: 1, income: 1, night: false };
const NIGHT: DayNightBonus = { crop: 1.15, income: 1.2, night: true };

/** 测试与演出用：设为 true/false 可锁定昼夜，null 恢复按真实时间 */
let override: boolean | null = null;
export function setNightOverride(v: boolean | null): void {
  override = v;
}

export function isNightNow(now = new Date()): boolean {
  if (override !== null) return override;
  const h = now.getHours();
  return h >= 19 || h < 6;
}

export function dayNightBonus(now = new Date()): DayNightBonus {
  return isNightNow(now) ? NIGHT : DAY;
}

/** 作物生长倍率 */
export function dayNightCropSpeed(now = new Date()): number {
  return dayNightBonus(now).crop;
}

/** 被动收益倍率 */
export function dayNightIncome(now = new Date()): number {
  return dayNightBonus(now).income;
}
