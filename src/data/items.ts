import type { ItemId } from '../core/types';

/** 物品在 UI 里的色块。low-poly 场景里的颜色也取自同一张表，保证对得上。 */
export const ITEM_COLOR: Record<ItemId, number> = {
  wheat: 0xe8d59a,
  corn: 0xf2c14e,
  carrot: 0xe07a5f,
  strawberry: 0xe05263,
  pumpkin: 0xdd8b3c,
  cotton: 0xf7f7f2,
  bread: 0xd9a066,
  butter: 0xf5e6a8,
  jam: 0xc73e5c,
  wood: 0x9c6b3f,
  milk: 0xf2f0e6,
  lettuce: 0xa9dc7c,
  grape: 0x8e5bc4,
  cheese: 0xe8c56a,
};

export function itemColor(id: ItemId): number {
  return ITEM_COLOR[id] ?? 0x9aa5b1;
}
