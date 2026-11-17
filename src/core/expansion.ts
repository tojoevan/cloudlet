import type { GameState, Plot } from './types';
import { prosperityOf } from './economy';

/**
 * 横向拓荒：主岛不再“填满就结束”，而是向云海里锚定新的小岛。
 *
 * 这是对“容量有限”的直接回答：不盖高楼、不扩大主岛、不换画风，
 * 每座小岛都保持同一套坡屋顶/草地/石径语言，只增加 4 块田和一小片可布置的陆地。
 */

export const BASE_PLOT_COUNT = 16;

export interface ExpansionDef {
  id: string;
  name: string;
  subtitle: string;
  desc: string;
  plots: number;
  cost: number;
  /** 第二座岛还要求繁荣度，避免开局直接买满 */
  reqProsperity: number;
  /** 画面上小岛的中心（世界坐标 xz），与 World 的渲染位置一致 */
  center: { x: number; z: number };
}

export const EXPANSIONS: ExpansionDef[] = [
  {
    id: 'clover',
    name: '三叶岛',
    subtitle: '第一片锚地',
    desc: '一小片被风带来的草地，正好放下四块田。',
    plots: 4,
    cost: 2_000,
    reqProsperity: 0,
    center: { x: 12.2, z: -4.7 },
  },
  {
    id: 'windbell',
    name: '风铃岛',
    subtitle: '云海上的第二块田',
    desc: '风很大，但土很肥。适合种需要时间的作物。',
    plots: 4,
    cost: 4_500,
    reqProsperity: 30,
    center: { x: -12.4, z: 4.9 },
  },
];

export function expansionById(id: string): ExpansionDef | undefined {
  return EXPANSIONS.find((e) => e.id === id);
}

export function hasExpansion(state: GameState, id: string): boolean {
  return (state.expansions ?? []).includes(id);
}

export function expansionCount(state: GameState): number {
  return (state.expansions ?? []).length;
}

export function plotCountOf(state: GameState): number {
  return BASE_PLOT_COUNT + expansionCount(state) * 4;
}

/** 主岛的一条轻量任务链：不新增任务存档，直接从已有统计推导，老档也立刻可用。 */
export interface TrailTask {
  id: string;
  label: string;
  hint: string;
  done: boolean;
  progress: string;
}

export function trailTasks(state: GameState): TrailTask[] {
  const harvests = state.stats.harvests ?? 0;
  const orders = state.stats.ordersDone ?? 0;
  return [
    {
      id: 'harvest',
      label: '让土地先活起来',
      hint: '累计收获 5 次作物',
      done: harvests >= 5,
      progress: `${Math.min(harvests, 5)}/5`,
    },
    {
      id: 'order',
      label: '把货送出去',
      hint: '完成 2 笔村民订单',
      done: orders >= 2,
      progress: `${Math.min(orders, 2)}/2`,
    },
    {
      id: 'level',
      label: '让镇子站稳',
      hint: '达到 Lv 3',
      done: state.level >= 3,
      progress: `Lv ${Math.min(state.level, 3)}/3`,
    },
  ];
}

export function trailDone(state: GameState): boolean {
  return trailTasks(state).every((t) => t.done);
}

export type UnlockCheck =
  | { ok: true; def: ExpansionDef; cost: number }
  | { ok: false; reason: string; def: ExpansionDef };

export function canUnlockExpansion(state: GameState, id: string): UnlockCheck {
  const def = expansionById(id);
  if (!def) return { ok: false, reason: '未知的锚地', def: EXPANSIONS[0] };
  if (state.activeIsland !== 'round') {
    return { ok: false, reason: '只能在云上町的群岛边缘锚定', def };
  }
  if (hasExpansion(state, id)) return { ok: false, reason: '已经锚定过了', def };
  // 第二座岛要求第一座先锚定，形成顺序
  if (id === 'windbell' && !hasExpansion(state, 'clover')) {
    return { ok: false, reason: '先锚定三叶岛', def };
  }
  if (!trailDone(state)) return { ok: false, reason: '先完成拓荒手账', def };
  if (id === 'windbell' && prosperityOf(state) < def.reqProsperity) {
    return { ok: false, reason: `繁荣度需达到 ${def.reqProsperity}`, def };
  }
  if (state.coins < def.cost) return { ok: false, reason: '金币不够', def };
  return { ok: true, def, cost: def.cost };
}

export interface UnlockResult {
  ok: boolean;
  reason?: string;
  def?: ExpansionDef;
  plots?: number;
}

/** 真正锚定：扣钱、记录、把新田块追加到当前主岛（只能主岛操作）。 */
export function unlockExpansion(state: GameState, id: string): UnlockResult {
  if (state.activeIsland !== 'round') {
    return { ok: false, reason: '只能在云上町的群岛边缘锚定新岛' };
  }
  const chk = canUnlockExpansion(state, id);
  if (!chk.ok) return { ok: false, reason: chk.reason };
  const def = chk.def;
  state.coins -= def.cost;
  state.expansions = [...(state.expansions ?? []), id];
  const start = state.plots.length;
  for (let i = 0; i < def.plots; i++) {
    const plot: Plot = {
      id: start + i,
      crop: null,
      plantedAt: 0,
      readyAt: 0,
    };
    state.plots.push(plot);
  }
  // 同步到岛屿仓库，切走再回来也不丢
  state.islandData[state.activeIsland] = {
    buildings: state.buildings,
    plots: state.plots,
    factories: state.factories,
  };
  return { ok: true, def, plots: def.plots };
}

/** 存档兼容：已锚定 n 座岛，但 plots 还是旧长度时补齐空田。 */
export function ensureExpansionPlots(state: GameState): void {
  if (!Array.isArray(state.expansions)) state.expansions = [];
  if (state.activeIsland !== 'round') return;
  const want = plotCountOf(state);
  while (state.plots.length < want) {
    const id = state.plots.length;
    state.plots.push({ id, crop: null, plantedAt: 0, readyAt: 0 });
  }
}

/** 新田块在哪个小岛上：0/1 号岛各 4 块。 */
export function expansionPlotSlot(index: number): { islet: number; slot: number } | null {
  if (index < BASE_PLOT_COUNT) return null;
  return { islet: Math.floor((index - BASE_PLOT_COUNT) / 4), slot: (index - BASE_PLOT_COUNT) % 4 };
}
