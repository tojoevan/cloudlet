import { BUILDINGS } from '../data/buildings';
import { CROPS } from '../data/crops';
import { PRODUCTS } from '../data/factories';
import type { CropId, GameState, ItemId, OrderLine, ProductId } from './types';

export const SAVE_VERSION = 2;

/** 一块地一次的产量 */
export const HARVEST_YIELD = 2;
/** 直接出售的折扣，防止无限套利 */
export const SELL_RATE = 0.6;

const CROP_KEYS = new Set(Object.keys(CROPS));

export function isCrop(id: ItemId): id is CropId {
  return CROP_KEYS.has(id);
}

export function itemPrice(id: ItemId): number {
  return isCrop(id) ? CROPS[id].price : PRODUCTS[id as ProductId].price;
}

export function itemName(id: ItemId): string {
  return isCrop(id) ? CROPS[id].name : PRODUCTS[id as ProductId].name;
}

/** 升到下一级所需经验。前期几分钟一级，后期数天一级。 */
export function expForLevel(level: number): number {
  return Math.floor(100 * Math.pow(level, 1.6));
}

/** 仓库容量。跟着等级长，避免早期就被卡住。 */
export function capacityOf(state: GameState): number {
  return 120 + state.level * 20;
}

export function invTotal(state: GameState): number {
  let sum = 0;
  for (const v of Object.values(state.inventory)) sum += v ?? 0;
  return sum;
}

export function invCount(state: GameState, id: ItemId): number {
  return state.inventory[id] ?? 0;
}

/** 在容量约束下实际能装入的数量 */
export function roomFor(state: GameState, n: number): number {
  return Math.max(0, Math.min(n, capacityOf(state) - invTotal(state)));
}

export function addItem(state: GameState, id: ItemId, n: number): number {
  const got = roomFor(state, n);
  if (got <= 0) return 0;
  state.inventory[id] = (state.inventory[id] ?? 0) + got;
  return got;
}

export function hasItems(state: GameState, lines: OrderLine[]): boolean {
  return lines.every((l) => invCount(state, l.id) >= l.count);
}

export function consumeItems(state: GameState, lines: OrderLine[]): void {
  for (const l of lines) {
    const left = (state.inventory[l.id] ?? 0) - l.count;
    if (left <= 0) delete state.inventory[l.id];
    else state.inventory[l.id] = left;
  }
}

/**
 * 小镇每秒金币产出估算，用于离线经营收入。
 * 是估算值而非精确模拟——离线收益不该比在线更划算。
 */
export function incomeRate(state: GameState): number {
  const factoryPart = state.factories.reduce((s, f) => s + f.slots.length, 0) * 0.8;
  const prosperity = prosperityOf(state);
  return state.level * 0.5 + prosperity * 0.3 + factoryPart;
}

export function prosperityOf(state: GameState): number {
  return state.buildings.reduce((s, b) => s + BUILDINGS[b.type].prosperity, 0);
}

export function populationOf(state: GameState): number {
  return state.buildings.reduce((s, b) => s + BUILDINGS[b.type].pop, 0);
}
