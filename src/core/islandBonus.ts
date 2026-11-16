import type { CropId, GameState, ProductId } from './types';

/**
 * 每座岛的经营性格。
 *
 * 为什么要做：多岛如果只是"多一块能盖房子的空地"，玩家没有理由换岛。
 * 给每座岛一个**产出偏向**，"在哪座岛种什么"才变成经营决策。
 */
export interface IslandBonus {
  /** 加速的作物/产物（留空表示全部） */
  crops?: CropId[];
  products?: ProductId[];
  /** 速度倍率：1.25 表示快 25% */
  speed?: number;
  /** 被动收益倍率 */
  income?: number;
  /** 一句话说明，显示在建造面板里 */
  note: string;
}

export const ISLAND_BONUS: Record<string, IslandBonus> = {
  orchard: {
    crops: ['strawberry', 'pumpkin'],
    speed: 1.3,
    note: '草莓与南瓜生长快 30%',
  },
  ranch: {
    products: ['milk', 'butter'],
    speed: 1.3,
    note: '牛奶与黄油生产快 30%',
  },
  onsen: {
    income: 1.25,
    note: '居民消费收入 +25%',
  },
  summit: {
    speed: 1.12,
    note: '所有作物与加工都快 12%',
  },
};

/** 当前岛对某作物的生长倍率 */
export function cropSpeed(state: GameState, crop: CropId): number {
  const b = ISLAND_BONUS[state.activeIsland];
  if (!b?.speed) return 1;
  if (b.crops && !b.crops.includes(crop)) return 1;
  return b.speed;
}

/** 当前岛对某产物的加工倍率 */
export function productSpeed(state: GameState, product: ProductId): number {
  const b = ISLAND_BONUS[state.activeIsland];
  if (!b?.speed) return 1;
  if (b.products && !b.products.includes(product)) return 1;
  return b.speed;
}

/** 当前岛的被动收益倍率 */
export function incomeBonus(state: GameState): number {
  return ISLAND_BONUS[state.activeIsland]?.income ?? 1;
}
