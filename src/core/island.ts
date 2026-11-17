import type { GameState, IslandData, IslandMeta } from './types';
import { prosperityOf } from './economy';
import { PLOT_COUNT } from './state';
import { ensureExpansionPlots } from './expansion';

/** 方岛网格单元尺寸：与农田田块间距一致，即「农田 = 1 格」 */
export const CELL = 1.18;
/** 方岛边长格数：13×13 ≈ 15.3 世界单位，与圆岛(Ø18)面积相近，作为「对比空间」 */
export const SQUARE_N = 13;

export const ROUND_ID = 'round';
export const SQUARE_ID = 'square';

/** 一座岛自带的初始玩法数据（空岛） */
export function makeEmptyIslandData(): IslandData {
  return {
    buildings: [],
    plots: Array.from({ length: PLOT_COUNT }, (_, i) => ({
      id: i,
      crop: null,
      plantedAt: 0,
      readyAt: 0,
    })),
    factories: [],
  };
}

/**
 * 默认岛屿表：两座起始岛 + 四座按繁荣度解锁的岛。
 * 多岛是这类游戏最自然的长线目标——新地图同时带来新的空间与新的目标感。
 */
export function defaultIslands(): IslandMeta[] {
  return [
    { id: ROUND_ID, shape: 'round', name: '云上町', reqProsperity: 0, desc: '一切开始的地方' },
    { id: SQUARE_ID, shape: 'square', name: '方舟町', reqProsperity: 0, desc: '规整的网格街区' },
    { id: 'orchard', shape: 'round', name: '果园岛', reqProsperity: 30, desc: '坡地上种满果树' },
    { id: 'ranch', shape: 'square', name: '牧场岛', reqProsperity: 80, desc: '牛羊在围栏里吃草' },
    { id: 'onsen', shape: 'round', name: '温泉岛', reqProsperity: 160, desc: '雾气袅袅的歇脚处' },
    { id: 'summit', shape: 'round', name: '云顶', reqProsperity: 300, desc: '离云最近的一小块地' },
  ];
}

/** 繁荣度是否够开这座岛 */
export function isIslandUnlocked(meta: IslandMeta | undefined, prosperity: number): boolean {
  if (!meta) return false;
  return prosperity >= (meta.reqProsperity ?? 0);
}

/**
 * 兼容/初始化岛屿系统。老存档没有 islands 字段时，把当前顶层
 * buildings/plots/factories 当作圆岛数据，并补一个空的方岛。
 */
export function ensureIslands(state: GameState): void {
  if (!state.islands || state.islands.length === 0) {
    state.islands = defaultIslands();
    state.activeIsland = ROUND_ID;
    state.islandData = {};
    state.islandData[SQUARE_ID] = makeEmptyIslandData();
  }
  if (!state.activeIsland) state.activeIsland = ROUND_ID;
  if (!state.islandData) state.islandData = {};
  // 老存档只有两座岛：把后来新增的岛补进去（数据留空，切过去再建）
  for (const meta of defaultIslands()) {
    if (!state.islands.some((x) => x.id === meta.id)) state.islands.push(meta);
  }
  if (!state.islandData[SQUARE_ID]) state.islandData[SQUARE_ID] = makeEmptyIslandData();
  if (!state.islands.some((x) => x.id === state.activeIsland)) {
    state.activeIsland = state.islands[0].id;
  }
}

export function activeIslandMeta(state: GameState): IslandMeta {
  return state.islands.find((x) => x.id === state.activeIsland) ?? state.islands[0];
}

/**
 * 切换到目标岛。两层数据交换：
 *  - 把当前激活岛的顶层 buildings/plots/factories 存入 islandData；
 *  - 从 islandData 取出目标岛的数据挂到顶层，成为新的「当前激活岛」。
 * 这样所有玩法代码只看顶层字段，无需感知多岛存在。返回是否真的切了岛。
 */
export function switchIsland(state: GameState, id: string): boolean {
  if (id === state.activeIsland) return false;
  const target = state.islands.find((x) => x.id === id);
  if (!target) return false;
  // 未解锁的岛不允许切入（繁荣度不够时 UI 也会置灰）
  if (!isIslandUnlocked(target, prosperityOf(state))) return false;

  state.islandData[state.activeIsland] = {
    buildings: state.buildings,
    plots: state.plots,
    factories: state.factories,
  };

  const data = state.islandData[id] ?? makeEmptyIslandData();
  state.buildings = data.buildings;
  state.plots = data.plots;
  state.factories = data.factories;
  state.activeIsland = id;
  ensureExpansionPlots(state);
  return true;
}
