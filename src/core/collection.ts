import { BUILDING_ORDER, PERMANENT_DECO } from '../data/buildings';
import { CROP_ORDER } from '../data/crops';
import { FACTORY_ORDER, PRODUCTS } from '../data/factories';
import type { GameState } from './types';

/**
 * 收集奖励：把图鉴从「计数器」变成「长期目标」。
 *
 * 集齐某一类就解锁一条永久加成——这是放置游戏最经典的钩子：
 * 每多收一样东西，都在朝一个明确的、能感知到的能力提升靠近。
 */
export interface CollectionSet {
  id: string;
  name: string;
  /** 该类别总项数 */
  total: number;
  /** 已收集数 */
  found: (s: GameState) => number;
  /** 集齐后的效果描述 */
  reward: string;
  /** 集齐后的倍率（作物/加工速度） */
  cropMul?: number;
  productMul?: number;
  /** 集齐后的繁荣度倍率 */
  prosperityMul?: number;
}

export const COLLECTION_SETS: CollectionSet[] = [
  {
    id: 'crops',
    name: '作物全集',
    total: CROP_ORDER.length,
    found: (s) => s.codex.crops.length,
    reward: '所有作物生长 +10%',
    cropMul: 1.1,
  },
  {
    id: 'products',
    name: '加工品全集',
    total: Object.keys(PRODUCTS).length,
    found: (s) => s.codex.products.length,
    reward: '所有加工 +10%',
    productMul: 1.1,
  },
  {
    id: 'buildings',
    name: '建筑全集',
    total: BUILDING_ORDER.length,
    found: (s) => s.codex.buildings.length,
    reward: '所有作物与加工再 +5%',
    cropMul: 1.05,
    productMul: 1.05,
  },
  {
    id: 'deco',
    name: '装饰全集',
    total: PERMANENT_DECO.length,
    found: (s) => PERMANENT_DECO.filter((t) => s.codex.buildings.includes(t)).length,
    reward: '繁荣度 +8%',
    prosperityMul: 1.08,
  },
  {
    id: 'factories',
    name: '工厂全集',
    total: FACTORY_ORDER.length,
    found: (s) => s.codex.factories.length,
    reward: '所有加工 +10%',
    productMul: 1.1,
  },
];

export function isSetComplete(s: GameState, set: CollectionSet): boolean {
  return set.found(s) >= set.total;
}

/** 已集齐的套装带来的作物生长倍率 */
export function collectionCropSpeed(s: GameState): number {
  let m = 1;
  for (const set of COLLECTION_SETS) {
    if (set.cropMul && isSetComplete(s, set)) m *= set.cropMul;
  }
  return m;
}

/** 已集齐的套装带来的加工倍率 */
export function collectionProductSpeed(s: GameState): number {
  let m = 1;
  for (const set of COLLECTION_SETS) {
    if (set.productMul && isSetComplete(s, set)) m *= set.productMul;
  }
  return m;
}

/** 已集齐的套装带来的繁荣度倍率 */
export function collectionProsperity(s: GameState): number {
  let m = 1;
  for (const set of COLLECTION_SETS) {
    if (set.prosperityMul && isSetComplete(s, set)) m *= set.prosperityMul;
  }
  return m;
}
