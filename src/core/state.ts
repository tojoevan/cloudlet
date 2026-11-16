import { SAVE_VERSION } from './economy';
import { fillOrders } from './orders';
import { fillWishes } from './wishes';
import { ensureIslands, defaultIslands, ROUND_ID } from './island';
import type { GameState } from './types';

export const GRID_COLS = 4;
export const GRID_ROWS = 4;
export const PLOT_COUNT = GRID_COLS * GRID_ROWS;

export function createInitialState(deviceId: string): GameState {
  const now = Date.now();
  const state: GameState = {
    version: SAVE_VERSION,
    deviceId,
    savedAt: now,
    syncedAt: 0,
    lastYieldAt: 0,
    yieldCarry: 0,
    level: 1,
    exp: 0,
    coins: 300,
    gems: 0,
    plots: Array.from({ length: PLOT_COUNT }, (_, i) => ({
      id: i,
      crop: null,
      plantedAt: 0,
      readyAt: 0,
    })),
    factories: [],
    buildings: [{ id: 'b_0', type: 'house', seed: 1, level: 1 }],
    inventory: {},
    orders: [],
    wishes: [],
    stats: { harvests: 0, ordersDone: 0, playSeconds: 0, bestCombo: 0, focusSessions: 0, focusMinutes: 0 },
    settings: { channel: 'citypop', radioUrl: '', volume: 0.6, powerSave: false, quality: 'standard', autoQuality: true, colorScheme: 'macaron', cloudSync: false, perfMonitor: false },
    feverUntil: 0,
    combo: 0,
    comboUntil: 0,
    lastCrop: null,
    focus: { until: 0, startedAt: 0, totalMs: 0, harvested: 0, planted: 0, produced: 0, placed: 0 },
    codex: { crops: [], products: [], buildings: [], factories: [] },
    achievements: [],
    islands: defaultIslands(),
    activeIsland: ROUND_ID,
    islandData: {},
  };
  fillOrders(state, now);
  fillWishes(state, now);
  ensureIslands(state);
  return state;
}
