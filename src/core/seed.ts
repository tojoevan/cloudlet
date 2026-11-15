import type { GameState, BuildingType, FactoryType } from './types';
import { firstFreeCell, canPlace } from './grid';
import { SQUARE_N } from './island';
import { BUILDING_FOOTPRINT, FACTORY_FOOTPRINT } from '../data/buildings';

let _seq = 1;
function uid(p: string): string {
  return `${p}_${Date.now().toString(36)}_${_seq++}`;
}
function ri(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}

/**
 * 给方岛(方舟町)随机铺一层测试内容：住宅、点缀、道路、工厂，并随机播几块作物。
 * 仅在岛为空(没有任何建筑/工厂)时才填充，避免覆盖玩家自己摆的布局。
 * now/ rng 可注入，便于测试与确定性重放。
 */
export function seedSquareTestLayout(
  state: GameState,
  now = Date.now(),
  rng: () => number = Math.random,
): void {
  if (state.buildings.length > 0 || state.factories.length > 0) return;

  // 道路：先铺一段「连通路网」演示各种路口（十字/丁字/拐弯/直路/末端），
  // 放在最前，确保这些格子不被后续建筑占掉。用 canPlace 跳过已被占用的格。
  const bx = 2;
  const bz = 2;
  // 相对 (bx,bz) 的连通路型；(0,0) 为十字（上下左右都有路），(−1,0)/(1,0) 因各自
  // 多一个纵向邻居而成为丁字/拐弯，[0,−1]/[0,−2] 是向上的直路，两端为末端。
  const ROAD_PATTERN: Array<[number, number]> = [
    [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], // 横向主线
    [0, -1], [0, -2], [0, 1], // (0,0) 上/下直路分支 → (0,0) 成真正十字
    [1, -1], // 给 (1,0) 一个「上」邻居 → (1,0) 成十字 / 丁字
    [-1, -1], // 给 (-1,0) 一个上邻居 → 丁字 / 拐弯
    [1, 1], // 给 (1,0) 一个下邻居 → 丁字 / 拐弯
  ];
  for (const [dx, dz] of ROAD_PATTERN) {
    const gx = bx + dx;
    const gz = bz + dz;
    if (gx < 0 || gz < 0 || gx >= SQUARE_N || gz >= SQUARE_N) continue;
    if (!canPlace(state, gx, gz, 1, 1)) continue;
    state.buildings.push({
      id: uid('b'),
      type: 'road',
      seed: ri(rng, 1e9),
      level: 1,
      gx,
      gz,
      w: 1,
      h: 1,
      rot: 0,
    });
  }

  // 住宅：约 8 栋，部分扩成 1×2 / 2×1，并随机 1~3 层
  for (let i = 0; i < 8; i++) {
    let spot = firstFreeCell(state, 1, 1);
    let w = 1;
    let h = 1;
    if (i % 3 === 0 && (spot = firstFreeCell(state, 2, 1))) {
      w = 2;
      h = 1;
    } else if (i % 3 === 1 && (spot = firstFreeCell(state, 1, 2))) {
      w = 1;
      h = 2;
    } else {
      spot = firstFreeCell(state, 1, 1);
    }
    if (!spot) break;
    state.buildings.push({
      id: uid('b'),
      type: 'house',
      seed: ri(rng, 1e9),
      level: 1 + ri(rng, 3),
      gx: spot.gx,
      gz: spot.gz,
      w,
      h,
      rot: 0,
    });
  }

  // 点缀型 2×2：咖啡馆 / 公园 / 喷泉(当水景) 各一栋
  const deco: BuildingType[] = ['cafe', 'park', 'fountain'];
  for (const t of deco) {
    const fp = BUILDING_FOOTPRINT[t];
    const spot = firstFreeCell(state, fp.w, fp.h);
    if (!spot) continue;
    state.buildings.push({
      id: uid('b'),
      type: t,
      seed: ri(rng, 1e9),
      level: 1,
      gx: spot.gx,
      gz: spot.gz,
      w: fp.w,
      h: fp.h,
      rot: 0,
    });
  }

  // 工厂：1~2 座 2×2 生产建筑（烘焙坊 / 伐木场）
  const fTypes: FactoryType[] = ['bakery', 'lumber'];
  const fn = 1 + ri(rng, 2);
  for (let i = 0; i < fn; i++) {
    const spot = firstFreeCell(state, FACTORY_FOOTPRINT.w, FACTORY_FOOTPRINT.h);
    if (!spot) break;
    state.factories.push({
      type: fTypes[i % fTypes.length],
      slots: [{ recipe: null, readyAt: 0 }],
      gx: spot.gx,
      gz: spot.gz,
    });
  }

  // 农田：随机播几种作物，让中央 4×4 农田区有生气
  const cropIds = ['wheat', 'corn', 'carrot', 'strawberry', 'pumpkin', 'cotton'] as const;
  const planted = 4 + ri(rng, 8);
  for (let i = 0; i < planted && i < state.plots.length; i++) {
    const plot = state.plots[i];
    plot.crop = cropIds[ri(rng, cropIds.length)];
    plot.plantedAt = now - ri(rng, 3) * 3_600_000;
    plot.readyAt = now + (6 - ri(rng, 6)) * 3_600_000;
  }
}
