import type { FactoryType, ItemId, ProductId } from '../core/types';

export interface ProductDef {
  id: ProductId;
  name: string;
  price: number;
  /**
   * 直接卖钱：生产完成不进仓库、不参与订单，直接折算金币。
   * 目前没有产物使用（木材/牛奶都已改为进仓库，可卖/可交付订单）。
   */
  sellDirect?: boolean;
}

export const PRODUCTS: Record<ProductId, ProductDef> = {
  bread: { id: 'bread', name: '面包', price: 90 },
  butter: { id: 'butter', name: '黄油', price: 260 },
  jam: { id: 'jam', name: '果酱', price: 1_800 },
  wood: { id: 'wood', name: '木材', price: 140 },
  milk: { id: 'milk', name: '牛奶', price: 200 },
  cheese: { id: 'cheese', name: '奶酪', price: 650 },
};

/** 是否「生产即卖钱」的产物——订单不应要求它，否则永远交不出去 */
export function isDirectSell(id: ItemId): boolean {
  const p = PRODUCTS[id as ProductId];
  return !!p && p.sellDirect === true;
}

export interface RecipeDef {
  id: string;
  factory: FactoryType;
  inputs: Partial<Record<ItemId, number>>;
  output: ProductId;
  timeMs: number;
  unlockLevel: number;
}

export const RECIPES: RecipeDef[] = [
  {
    id: 'bakery:bread', factory: 'bakery',
    inputs: { wheat: 3 }, output: 'bread',
    timeMs: 120_000, unlockLevel: 2,
  },
  {
    id: 'dairy:butter', factory: 'dairy',
    inputs: { corn: 3 }, output: 'butter',
    timeMs: 240_000, unlockLevel: 5,
  },
  {
    id: 'juice:jam', factory: 'juice',
    inputs: { strawberry: 2 }, output: 'jam',
    timeMs: 360_000, unlockLevel: 10,
  },
  {
    id: 'creamery:cheese', factory: 'creamery',
    inputs: { milk: 2 }, output: 'cheese',
    timeMs: 300_000, unlockLevel: 9,
  },
  {
    id: 'lumber:wood', factory: 'lumber',
    inputs: {}, output: 'wood',
    timeMs: 180_000, unlockLevel: 1,
  },
  {
    id: 'ranch:milk', factory: 'ranch',
    inputs: {}, output: 'milk',
    timeMs: 240_000, unlockLevel: 4,
  },
];

export const RECIPE_BY_ID = new Map(RECIPES.map((r) => [r.id, r]));

export function recipesOf(factory: FactoryType, level: number): RecipeDef[] {
  return RECIPES.filter((r) => r.factory === factory && r.unlockLevel <= level);
}

export interface FactoryDef {
  id: FactoryType;
  name: string;
  unlockLevel: number;
  buildCost: number;
  /** 槽位 2、3 的扩容成本 */
  slotCosts: number[];
  body: number;
  roof: number;
  chimney: number;
}

export const FACTORIES: Record<FactoryType, FactoryDef> = {
  bakery: {
    id: 'bakery', name: '面包坊', unlockLevel: 2, buildCost: 1_500,
    slotCosts: [2_400, 6_000], body: 0xfdf2dd, roof: 0xe89f6e, chimney: 0xcf8a54,
  },
  dairy: {
    id: 'dairy', name: '乳品厂', unlockLevel: 5, buildCost: 6_000,
    slotCosts: [9_000, 22_000], body: 0xf2fafa, roof: 0x85c0be, chimney: 0x6b9e9c,
  },
  juice: {
    id: 'juice', name: '果汁坊', unlockLevel: 10, buildCost: 24_000,
    slotCosts: [36_000, 90_000], body: 0xfff0f2, roof: 0xf0687a, chimney: 0xc9505d,
  },
  lumber: {
    id: 'lumber', name: '伐木场', unlockLevel: 1, buildCost: 1_200,
    slotCosts: [2_000, 5_000], body: 0xc9a06a, roof: 0x8a5a3b, chimney: 0x6e4a32,
  },
  creamery: {
    id: 'creamery', name: '奶酪坊', unlockLevel: 9, buildCost: 9_000,
    slotCosts: [14_000, 34_000], body: 0xfff6e2, roof: 0xd9a94e, chimney: 0xb98c39,
  },
  ranch: {
    id: 'ranch', name: '畜牧场', unlockLevel: 4, buildCost: 5_000,
    slotCosts: [8_000, 20_000], body: 0xf3e2b8, roof: 0x9bbf6a, chimney: 0x86a85a,
  },
};

export const FACTORY_ORDER: FactoryType[] = ['bakery', 'dairy', 'juice', 'lumber', 'ranch', 'creamery'];
