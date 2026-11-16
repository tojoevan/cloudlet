import type { CropId } from '../core/types';

export interface CropDef {
  id: CropId;
  name: string;
  /** 从播种到成熟的毫秒数 */
  growMs: number;
  price: number;
  unlockLevel: number;
  /** 主色（茎叶）与果实色，程序化渲染用 */
  stem: number;
  fruit: number;
  /** 成熟时植株高度（世界单位） */
  height: number;
}

export const CROPS: Record<CropId, CropDef> = {
  wheat: {
    id: 'wheat', name: '小麦', growMs: 30_000, price: 12, unlockLevel: 1,
    stem: 0xdbc873, fruit: 0xf5e8b8, height: 0.55,
  },
  corn: {
    id: 'corn', name: '玉米', growMs: 120_000, price: 60, unlockLevel: 2,
    stem: 0x8cc878, fruit: 0xffd45e, height: 0.95,
  },
  carrot: {
    id: 'carrot', name: '胡萝卜', growMs: 300_000, price: 180, unlockLevel: 5,
    stem: 0x7cc45f, fruit: 0xf08a6e, height: 0.5,
  },
  strawberry: {
    id: 'strawberry', name: '草莓', growMs: 900_000, price: 620, unlockLevel: 10,
    stem: 0x7cc45f, fruit: 0xf0687a, height: 0.45,
  },
  pumpkin: {
    id: 'pumpkin', name: '南瓜', growMs: 2_700_000, price: 2_100, unlockLevel: 18,
    stem: 0x7cc45f, fruit: 0xf79a48, height: 0.6,
  },
  lettuce: {
    id: 'lettuce', name: '生菜', growMs: 240_000, price: 140, unlockLevel: 7,
    stem: 0x8fd06a, fruit: 0xbfe98a, height: 0.42,
  },
  grape: {
    id: 'grape', name: '葡萄', growMs: 1_200_000, price: 900, unlockLevel: 16,
    stem: 0x7a9c5a, fruit: 0x8e5bc4, height: 0.85,
  },
  cotton: {
    id: 'cotton', name: '棉花', growMs: 7_200_000, price: 6_400, unlockLevel: 28,
    stem: 0xa9c88c, fruit: 0xfdfdf8, height: 0.7,
  },
};

export const CROP_ORDER: CropId[] = [
  'wheat', 'corn', 'carrot', 'lettuce', 'strawberry', 'grape', 'pumpkin', 'cotton',
];

export function unlockedCrops(level: number): CropId[] {
  return CROP_ORDER.filter((id) => CROPS[id].unlockLevel <= level);
}
