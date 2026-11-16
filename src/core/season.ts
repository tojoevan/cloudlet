import type { CropId, GameState } from './types';
import { SEASONAL_DECO } from '../data/buildings';

/**
 * 季节：按真实月份轮换的长期节律。
 *
 * 为什么值得做：天气只有几分钟的变化，季节是"几周才有一次"的变化，
 * 它给老玩家一个「过些日子回来看看」的理由，也是限定装饰与作物加成的载体。
 */
export type SeasonId = 'spring' | 'summer' | 'autumn' | 'winter';

export interface SeasonDef {
  id: SeasonId;
  name: string;
  /** 主题色，用于 HUD 徽章 */
  color: number;
  /** 当季限定的装饰建筑 id */
  deco: string;
  /** 当季加成：这些作物生长更快 */
  crops: CropId[];
  /** 作物加速倍率 */
  speed: number;
  /** 一句话氛围描述 */
  note: string;
}

export const SEASONS: Record<SeasonId, SeasonDef> = {
  spring: {
    id: 'spring', name: '春', color: 0xf6a5c0, deco: 'sakura',
    crops: ['wheat', 'strawberry'], speed: 1.2,
    note: '樱花开了，小麦与草莓长得快 20%',
  },
  summer: {
    id: 'summer', name: '夏', color: 0x62b6e8, deco: 'sunflower',
    crops: ['corn', 'carrot'], speed: 1.2,
    note: '日头很长，玉米与胡萝卜长得快 20%',
  },
  autumn: {
    id: 'autumn', name: '秋', color: 0xe8934a, deco: 'scarecrow',
    crops: ['pumpkin', 'wheat'], speed: 1.2,
    note: '南瓜丰收，南瓜与小麦长得快 20%',
  },
  winter: {
    id: 'winter', name: '冬', color: 0x9fc4e0, deco: 'snowman',
    crops: ['cotton'], speed: 1.25,
    note: '雪落下来，棉花长得快 25%',
  },
};

/** 按日期取当前季节（北半球习惯：3-5 春、6-8 夏、9-11 秋、其余冬） */
export function seasonOf(date = new Date()): SeasonId {
  const m = date.getMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

/** 测试与活动用的季节覆盖：设为 null 恢复按真实月份 */
let override: SeasonId | null = null;
export function setSeasonOverride(id: SeasonId | null): void {
  override = id;
}

export function currentSeason(state?: GameState): SeasonDef {
  // state 参数暂时不用，留给以后做"季节可被活动覆盖"
  void state;
  return SEASONS[override ?? seasonOf()];
}

/** 当季对该作物的生长倍率（不合季则为 1） */
export function seasonCropSpeed(crop: CropId): number {
  const s = currentSeason();
  return s.crops.includes(crop) ? s.speed : 1;
}

/** 某季节是否可建造这件装饰：季节限定件只在对应季节开放，其余常年可建 */
export function decoAvailableIn(type: string, season: SeasonId): boolean {
  const seasonal = Object.values(SEASONAL_DECO) as string[];
  if (!seasonal.includes(type)) return true;
  return SEASONAL_DECO[season] === type;
}
