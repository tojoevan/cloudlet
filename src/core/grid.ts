import type { GameState } from './types';
import { CELL, SQUARE_N } from './island';
import { activeIslandMeta } from './island';

/** 格 → 世界坐标（格中心）。gx 沿 +x，gz 沿 +z，整张网格以岛心为原点居中。 */
export function cellToWorld(gx: number, gz: number): { x: number; z: number } {
  const off = (SQUARE_N - 1) / 2;
  return { x: (gx - off) * CELL, z: (gz - off) * CELL };
}

/** footprint 锚点(gx,gz, 取最小角) 的中心世界坐标 */
export function footprintCenter(gx: number, gz: number, w: number, h: number): { x: number; z: number } {
  return cellToWorld(gx + (w - 1) / 2, gz + (h - 1) / 2);
}

/** 收集当前激活岛上所有已占用格（建筑/工厂/道路），可选排除某建筑 */
export function occupiedCells(state: GameState, excludeId?: string): Set<string> {
  const set = new Set<string>();
  const add = (gx: number, gz: number, w: number, h: number) => {
    for (let dx = 0; dx < w; dx++)
      for (let dz = 0; dz < h; dz++) set.add(`${gx + dx},${gz + dz}`);
  };
  for (const b of state.buildings) {
    if (b.id === excludeId) continue;
    const w = b.w ?? 1;
    const h = b.h ?? 1;
    if (b.gx != null && b.gz != null) add(b.gx, b.gz, w, h);
  }
  for (const f of state.factories) {
    if (f.gx != null && f.gz != null) add(f.gx, f.gz, 2, 2);
  }
  // 方岛：农田占用的格也不可建造
  if (activeIslandMeta(state).shape === 'square') {
    for (let i = 0; i < state.plots.length; i++) {
      const c = squarePlotCell(i);
      add(c.gx, c.gz, 1, 1);
    }
  }
  return set;
}

/** 在 (gx,gz) 放下 w×h 的占地是否可行（越界或与已有占用冲突） */
export function canPlace(
  state: GameState,
  gx: number,
  gz: number,
  w: number,
  h: number,
  excludeId?: string,
): boolean {
  if (gx < 0 || gz < 0 || gx + w > SQUARE_N || gz + h > SQUARE_N) return false;
  const occ = occupiedCells(state, excludeId);
  for (let dx = 0; dx < w; dx++)
    for (let dz = 0; dz < h; dz++) if (occ.has(`${gx + dx},${gz + dz}`)) return false;
  return true;
}

/** 自动打包：按行优先扫描，找第一处能放 w×h 的空格。找不到返回 null。 */
export function firstFreeCell(state: GameState, w: number, h: number): { gx: number; gz: number } | null {
  for (let gz = 0; gz <= SQUARE_N - h; gz++) {
    for (let gx = 0; gx <= SQUARE_N - w; gx++) {
      if (canPlace(state, gx, gz, w, h)) return { gx, gz };
    }
  }
  return null;
}

/** 住宅扩建时尝试找相邻可扩方向，返回新 footprint；都堵死则返回 null */
export function expandDir(
  state: GameState,
  gx: number,
  gz: number,
  excludeId: string,
): { w: number; h: number } | null {
  // 优先横向 2×1，再纵向 1×2
  if (canPlace(state, gx, gz, 2, 1, excludeId)) return { w: 2, h: 1 };
  if (canPlace(state, gx, gz, 1, 2, excludeId)) return { w: 1, h: 2 };
  return null;
}

/** 方岛农田：4×4 块居中放在网格里（start = (N-4)/2）。与建筑/道路互斥。 */
export function squarePlotCell(i: number): { gx: number; gz: number } {
  const start = Math.floor((SQUARE_N - 4) / 2);
  const c = i % 4;
  const r = Math.floor(i / 4);
  return { gx: start + c, gz: start + r };
}
