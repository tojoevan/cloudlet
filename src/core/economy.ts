import { BUILDINGS } from '../data/buildings';
import { CROPS } from '../data/crops';
import { PRODUCTS } from '../data/factories';
import type { CropId, GameState, ItemId, OrderLine, ProductId } from './types';
import { incomeBonus } from './islandBonus';

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

/**
 * 把经验归一化到当前等级容量内，并保证等级/经验字段合法。
 * 后端存档校验要求 exp < expForLevel(level)（防作弊注入），
 * 旧版遗留或异常路径可能让 exp 越界，推送前/加载后都规整一次，
 * 避免云端以「等级数据异常」拒绝保存（表现为同步失败）。
 */
export function normalizeProgress(state: GameState): void {
  if (!Number.isFinite(state.level) || state.level < 1) state.level = 1;
  if (!Number.isFinite(state.exp) || state.exp < 0) state.exp = 0;
  while (state.exp >= expForLevel(state.level)) {
    state.exp -= expForLevel(state.level);
    state.level += 1;
  }
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
 * 小镇每秒的金币被动产出（居民消费与观光）。
 *
 * 标定目标：每小时 ≈ 活跃玩家订单收入的 10~20%，
 * 让「开着页面看着它转」也有稳定进账，但不足以取代交付订单。
 *
 * 历史坑：原式直接把 (等级*0.5 + 繁荣*0.3 + 槽位*0.8) 当作「每秒」，
 * 25 级的镇子能到 30+ 金币/秒，4 小时离线 ≈ 26 万金币（约 670 单订单），
 * 与订单收益完全脱节，所以整体除以 60 换成合理量级。
 */
export function incomeRate(state: GameState): number {
  const factoryPart = state.factories.reduce((s, f) => s + f.slots.length, 0) * 0.8;
  const prosperity = prosperityOf(state);
  return ((state.level * 0.5 + prosperity * 0.3 + factoryPart) / 60) * incomeBonus(state);
}

export function prosperityOf(state: GameState): number {
  return state.buildings.reduce((s, b) => s + BUILDINGS[b.type].prosperity * (b.level ?? 1), 0);
}

export function populationOf(state: GameState): number {
  return state.buildings.reduce((s, b) => s + Math.round(BUILDINGS[b.type].pop * (b.level ?? 1)), 0);
}
