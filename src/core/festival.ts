import type { GameState } from './types';

/**
 * 节日活动：按日期窗口生效的限时加成。
 *
 * 与季节的区别：季节是几周一次的"底色"，节日是**几天到几周的"事件"**——
 * 它给的是「这段时间回来一趟，有额外好处」的召回理由。
 * 全部用日期区间定义，不需要服务端下发活动配置。
 */
export interface FestivalDef {
  id: string;
  name: string;
  /** 起始月份/日（含） */
  from: [number, number];
  /** 结束月份/日（含），可跨年 */
  to: [number, number];
  /** 加成 */
  crop?: number;
  income?: number;
  order?: number;
  note: string;
  color: number;
}

export const FESTIVALS: FestivalDef[] = [
  {
    id: 'sakura',
    name: '樱花祭',
    from: [3, 20], to: [4, 20],
    crop: 1.1,
    note: '樱花祭 · 作物生长 +10%',
    color: 0xf6a5c0,
  },
  {
    id: 'nightmarket',
    name: '夏日祭',
    from: [7, 1], to: [8, 15],
    income: 1.15,
    note: '夏日祭 · 居民消费 +15%',
    color: 0x62b6e8,
  },
  {
    id: 'harvest',
    name: '丰收节',
    from: [9, 15], to: [10, 31],
    crop: 1.15,
    note: '丰收节 · 作物生长 +15%',
    color: 0xe8934a,
  },
  {
    id: 'snowlight',
    name: '雪灯节',
    from: [12, 1], to: [1, 7],
    order: 1.2,
    note: '雪灯节 · 订单金币 +20%',
    color: 0x9fc4e0,
  },
];

/** 日期是否落在 [from,to]（支持跨年，例如 12/1 → 1/7） */
function inWindow(m: number, d: number, from: [number, number], to: [number, number]): boolean {
  const cur = m * 100 + d;
  const a = from[0] * 100 + from[1];
  const b = to[0] * 100 + to[1];
  return a <= b ? cur >= a && cur <= b : cur >= a || cur <= b;
}

export function festivalOf(date = new Date()): FestivalDef | null {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return FESTIVALS.find((f) => inWindow(m, d, f.from, f.to)) ?? null;
}

/** 测试与预览用的固定日期 */
let overrideDate: Date | null = null;
export function setFestivalDate(date: Date | null): void {
  overrideDate = date;
}

export function currentFestival(): FestivalDef | null {
  return festivalOf(overrideDate ?? new Date());
}

export function festivalCropSpeed(): number {
  return currentFestival()?.crop ?? 1;
}
export function festivalIncome(): number {
  return currentFestival()?.income ?? 1;
}
export function festivalOrder(): number {
  return currentFestival()?.order ?? 1;
}

/** 当前节日（给 UI 用，state 参数保留给以后做"活动可被后台开关"） */
export function activeFestival(state?: GameState): FestivalDef | null {
  void state;
  return currentFestival();
}
