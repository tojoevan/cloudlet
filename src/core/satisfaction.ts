import { BUILDINGS } from '../data/buildings';
import { populationOf } from './economy';
import type { GameState } from './types';

/**
 * 居民满意度（0~100）。
 *
 * 设计意图：把散落的几条线——心愿（帮过多少忙）、装饰（镇子好不好看）、
 * 公共设施（有没有地方可去）——合成一个居民能感知的指标。
 * 只做正向激励：满意度高时订单收益更高；低不会惩罚，避免变成压力。
 */
export function satisfactionOf(state: GameState): number {
  const buildings = state.buildings ?? [];
  const deco = buildings.filter((b) => BUILDINGS[b.type]?.deco).length;
  const publicCount = buildings.filter(
    (b) => b.type === 'park' || b.type === 'fountain' || b.type === 'cafe',
  ).length;

  // 装饰占比：装饰占全部建筑的比例，最多 40 分
  const ratio = buildings.length > 0 ? deco / buildings.length : 0;
  const decoScore = Math.min(40, ratio * 120);

  // 帮过的忙：每个心愿 2 分，最多 30 分
  const wishScore = Math.min(30, (state.stats.wishesDone ?? 0) * 2);

  // 公共设施：公园/喷泉/咖啡馆，每处 6 分，最多 30 分
  const publicScore = Math.min(30, publicCount * 6);

  // 住房：人口与住宅匹配度（每人至少 1 个铺位）给一点点基础分
  const houses = buildings.filter((b) => b.type === 'house').length;
  const beds = houses * 5;
  const housingScore = populationOf(state) <= beds ? 4 : 0;

  return Math.max(0, Math.min(100, Math.round(decoScore + wishScore + publicScore + housingScore)));
}

/** 满意度带来的订单收益倍率：最高 +20% */
export function satisfactionBonus(state: GameState): number {
  return 1 + (satisfactionOf(state) / 100) * 0.2;
}

/** 满意度档位文案，给 UI 用 */
export function satisfactionLabel(v: number): string {
  if (v >= 75) return '很开心';
  if (v >= 50) return '挺开心';
  if (v >= 25) return '还不错';
  if (v >= 10) return '刚安顿';
  return '刚搬来';
}
