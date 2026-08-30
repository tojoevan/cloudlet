import type { GameState, IslandData, IslandMeta } from './types';
import { PLOT_COUNT } from './state';

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

/** 默认双岛：圆岛（主岛，沿用既有玩法）+ 方岛（网格新岛）。以后可在此追加更多空岛。 */
export function defaultIslands(): IslandMeta[] {
  return [
    { id: ROUND_ID, shape: 'round', name: '云上町' },
    { id: SQUARE_ID, shape: 'square', name: '方舟町' },
  ];
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
  return true;
}
