import { BUILDINGS, BUILDING_FOOTPRINT } from '../data/buildings';
import { CROPS } from '../data/crops';
import { FACTORIES, RECIPE_BY_ID, recipesOf } from '../data/factories';
import { recordBuilding, recordCrop, recordFactory } from './codex';
import { addItem, HARVEST_YIELD, itemPrice, populationOf, roomFor, SELL_RATE } from './economy';
import { FOCUS_MULT, isFocusing } from './focus';
import { activeIslandMeta } from './island';
import { cropSpeed, productSpeed } from './islandBonus';
import { collectionCropSpeed, collectionProductSpeed } from './collection';
import { seasonCropSpeed } from './season';
import { dayNightCropSpeed } from './daynight';
import { canPlace, expandDir, firstFreeCell } from './grid';
import type {
  BuildingType,
  CropId,
  FactoryType,
  GameState,
  ItemId,
  ProductId,
} from './types';

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

/** 建筑最高等级。升级已有房屋比新建更省空间，人口/繁荣按等级放大。 */
export const BUILDING_MAX_LEVEL = 3;

function fail(reason: string): ActionResult<never> {
  return { ok: false, reason };
}

/** 第 k 座（0 基）某类建筑的新建成本 = cost * costGrowth^k */
function buildCostOf(type: BuildingType, k: number): number {
  const def = BUILDINGS[type];
  return Math.floor(def.cost * Math.pow(def.costGrowth, k));
}

export function plant(state: GameState, plotId: number, crop: CropId, now: number): ActionResult {
  const plot = state.plots[plotId];
  if (!plot) return fail('地块不存在');
  if (plot.crop) return fail('这块地已经种了东西');
  if (CROPS[crop].unlockLevel > state.level) return fail('等级不够');

  plot.crop = crop;
  plot.plantedAt = now;
  // 岛屿加成：果园岛的水果类作物长得更快
  // 岛屿加成 × 收集奖励 × 当季加成 × 昼夜（夜里露水，作物略快）
  const speed =
    cropSpeed(state, crop) * collectionCropSpeed(state) * seasonCropSpeed(crop) * dayNightCropSpeed();
  plot.readyAt = now + Math.round(CROPS[crop].growMs / speed);
  state.lastCrop = crop;
  return { ok: true, data: undefined };
}

export function harvest(
  state: GameState,
  plotId: number,
  now: number,
): ActionResult<{ item: CropId; count: number; overflow: number }> {
  const plot = state.plots[plotId];
  if (!plot || !plot.crop) return fail('这里没有作物');
  if (plot.readyAt > now) return fail('还没成熟');

  // 放置游戏最怕「循环停摆」：仓库一满就不让收，屏幕上唯一在生长的东西就此卡死。
  // 因此装不下的部分按 60% 折成金币（与专注自动收一致），田照常空出来。
  const room = roomFor(state, HARVEST_YIELD);
  const crop = plot.crop;
  const got = addItem(state, crop, room);
  const overflow = HARVEST_YIELD - got;
  if (overflow > 0) state.coins += Math.floor(CROPS[crop].price * overflow * SELL_RATE);

  recordCrop(state, crop);
  state.stats.harvests += 1;
  plot.crop = null;
  plot.plantedAt = 0;
  plot.readyAt = 0;
  return { ok: true, data: { item: crop, count: got, overflow } };
}

/** 一键收获：只收成熟的，返回总收获量供 UI 飘字 */
export function harvestAll(
  state: GameState,
  now: number,
): ActionResult<{
  total: number;
  kinds: Partial<Record<ItemId, number>>;
  plots: number;
  overflowCoins: number;
}> {
  const kinds: Partial<Record<ItemId, number>> = {};
  let total = 0;
  let plots = 0;
  let overflowCoins = 0;

  const mature = state.plots.filter((p) => p.crop && p.readyAt <= now);
  if (mature.length === 0) return fail('还没有作物成熟');

  for (const plot of mature) {
    const crop = plot.crop!;
    const room = roomFor(state, HARVEST_YIELD);
    const got = addItem(state, crop, room);
    const overflow = HARVEST_YIELD - got;
    // 仓库满也照收：多余部分折金币，别让一键收获半途停住
    if (overflow > 0) {
      const coins = Math.floor(CROPS[crop].price * overflow * SELL_RATE);
      state.coins += coins;
      overflowCoins += coins;
    }
    recordCrop(state, crop);
    if (got > 0) {
      kinds[crop] = (kinds[crop] ?? 0) + got;
      total += got;
    }
    plots += 1;
    state.stats.harvests += 1;
    plot.crop = null;
    plot.plantedAt = 0;
    plot.readyAt = 0;
  }

  if (plots === 0) return fail('还没有作物成熟');
  return { ok: true, data: { total, kinds, plots, overflowCoins } };
}

/** 一键补种：按各地块上次种的作物重新播下，前期最常用的按钮 */
export function replantAll(state: GameState, lastCrop: CropId, now: number): ActionResult<{ plots: number }> {
  if (CROPS[lastCrop].unlockLevel > state.level) return fail('等级不够');
  let plots = 0;
  for (const plot of state.plots) {
    if (plot.crop) continue;
    plot.crop = lastCrop;
    plot.plantedAt = now;
    plot.readyAt = now + CROPS[lastCrop].growMs;
    plots += 1;
  }
  if (plots === 0) return fail('没有空地');
  return { ok: true, data: { plots } };
}

export function startRecipe(
  state: GameState,
  factoryIndex: number,
  slotIndex: number,
  recipeId: string,
  now: number,
): ActionResult {
  const factory = state.factories[factoryIndex];
  if (!factory) return fail('工厂不存在');
  const slot = factory.slots[slotIndex];
  if (!slot) return fail('槽位不存在');
  if (slot.recipe) return fail('这个槽位正在生产');

  const recipe = RECIPE_BY_ID.get(recipeId);
  if (!recipe) return fail('配方不存在');
  if (recipe.factory !== factory.type) return fail('配方与工厂不匹配');
  if (recipe.unlockLevel > state.level) return fail('等级不够');

  for (const [id, need] of Object.entries(recipe.inputs)) {
    if ((state.inventory[id as ItemId] ?? 0) < (need ?? 0)) return fail('材料不足');
  }
  for (const [id, need] of Object.entries(recipe.inputs)) {
    const key = id as ItemId;
    const left = (state.inventory[key] ?? 0) - (need ?? 0);
    if (left <= 0) delete state.inventory[key];
    else state.inventory[key] = left;
  }

  // 专注期间生产提速；岛屿加成（牧场岛的奶制品）也在这里叠乘
  const base = recipe.timeMs / (productSpeed(state, recipe.output) * collectionProductSpeed(state));
  const timeMs = isFocusing(state, now) ? Math.round(base / FOCUS_MULT) : Math.round(base);
  slot.recipe = recipeId;
  slot.readyAt = now + timeMs;
  return { ok: true, data: undefined };
}

/**
 * 一键全部生产：把工厂里所有空闲槽位都开起来，每个槽位挑第一个材料够的配方投进去。
 * 配方按解锁列表顺序挑，材料在投产后实时扣减，所以后续槽位按剩余库存判断，
 * 不会超投。返回实际开工的槽位数。
 */
export function startAllSlots(
  state: GameState,
  factoryIndex: number,
  now: number,
): ActionResult<{ started: number }> {
  const factory = state.factories[factoryIndex];
  if (!factory) return fail('工厂不存在');
  const recipes = recipesOf(factory.type, state.level);
  if (recipes.length === 0) return fail('暂无可用配方');

  let started = 0;
  for (let slotIndex = 0; slotIndex < factory.slots.length; slotIndex++) {
    const slot = factory.slots[slotIndex];
    if (slot.recipe) continue; // 已在生产，跳过
    // 找第一个当前材料够的配方（库存每投一次就变，所以每次重新判断）
    const recipe = recipes.find((r) =>
      Object.entries(r.inputs).every(
        ([id, need]) => (state.inventory[id as ItemId] ?? 0) >= (need ?? 0),
      ),
    );
    if (!recipe) continue; // 材料都不够，这个槽先空着
    const r = startRecipe(state, factoryIndex, slotIndex, recipe.id, now);
    if (r.ok) started++;
    else break;
  }
  if (started === 0) return fail('没有可开工的空槽位或材料不足');
  return { ok: true, data: { started } };
}

/** 用专注果实立即完成一个槽位，省去等待 */
export function rushSlot(
  state: GameState,
  factoryIndex: number,
  slotIndex: number,
): ActionResult<{ item: ProductId }> {
  const slot = state.factories[factoryIndex]?.slots[slotIndex];
  if (!slot?.recipe) return fail('这个槽位是空的');
  if (state.gems < 1) return fail('专注果实不够，去做一次番茄钟');

  const recipe = RECIPE_BY_ID.get(slot.recipe);
  if (!recipe) return fail('配方不存在');
  if (addItem(state, recipe.output, 1) === 0) return fail('仓库满了');

  state.gems -= 1;
  slot.recipe = null;
  slot.readyAt = 0;
  return { ok: true, data: { item: recipe.output } };
}

export function buildFactory(
  state: GameState,
  type: FactoryType,
  now: number,
  at?: { gx: number; gz: number },
): ActionResult {
  const def = FACTORIES[type];
  if (def.unlockLevel > state.level) return fail(`需要 ${def.unlockLevel} 级`);
  if (state.factories.some((f) => f.type === type)) return fail('已经建过了');
  if (state.coins < def.buildCost) return fail('金币不够');

  // 方岛要把 2×2 厂房落到网格上
  let gx: number | undefined;
  let gz: number | undefined;
  if (activeIslandMeta(state).shape === 'square') {
    const spot = at ?? firstFreeCell(state, 2, 2);
    if (!spot) return fail('方岛已经放满了');
    if (at && !canPlace(state, at.gx, at.gz, 2, 2)) return fail('这里放不下');
    gx = spot.gx;
    gz = spot.gz;
  }

  state.coins -= def.buildCost;
  state.factories.push({ type, slots: [{ recipe: null, readyAt: 0 }], gx, gz });
  recordFactory(state, type);
  void now;
  return { ok: true, data: undefined };
}

export function unlockSlot(state: GameState, factoryIndex: number, now: number): ActionResult<{ cost: number }> {
  const factory = state.factories[factoryIndex];
  if (!factory) return fail('工厂不存在');
  const next = factory.slots.length;
  const def = FACTORIES[factory.type];
  if (next - 1 >= def.slotCosts.length) return fail('已是最大槽位');

  const cost = def.slotCosts[next - 1];
  if (state.coins < cost) return fail('金币不够');

  state.coins -= cost;
  factory.slots.push({ recipe: null, readyAt: 0 });
  void now;
  return { ok: true, data: { cost } };
}

export function build(
  state: GameState,
  type: BuildingType,
  now: number,
  at?: { gx: number; gz: number; rot?: 0 | 1 | 2 | 3 },
): ActionResult<{ cost: number }> {
  const def = BUILDINGS[type];
  if (def.unlockLevel > state.level) return fail(`需要 ${def.unlockLevel} 级`);

  const owned = state.buildings.filter((b) => b.type === type).length;
  const cost = Math.floor(def.cost * Math.pow(def.costGrowth, owned));
  if (populationOf(state) < def.reqPop) return fail(`需要 ${def.reqPop} 人口`);
  if (state.coins < cost) return fail('金币不够');

  const fp = BUILDING_FOOTPRINT[type];
  let gx: number | undefined;
  let gz: number | undefined;
  let rot: 0 | 1 | 2 | 3 = 0;
  if (activeIslandMeta(state).shape === 'square') {
    let spot = at ?? firstFreeCell(state, fp.w, fp.h);
    if (!spot) return fail('方岛已经放满了');
    if (at && !canPlace(state, at.gx, at.gz, fp.w, fp.h)) return fail('这里放不下');
    gx = spot.gx;
    gz = spot.gz;
    rot = at?.rot ?? 0;
  }

  state.coins -= cost;
  state.buildings.push({
    id: `b_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    seed: Math.floor(Math.random() * 1e9),
    level: 1,
    gx,
    gz,
    w: fp.w,
    h: fp.h,
    rot,
    cost,
  });
  recordBuilding(state, type);
  return { ok: true, data: { cost } };
}

/** 拆除某建筑预计返还的金币（实际建造价的一半）。 */
export function demolishRefund(state: GameState, id: string): number {
  const b = state.buildings.find((x) => x.id === id);
  if (!b) return 0;
  const def = BUILDINGS[b.type];
  // 实际花费：优先用建造时记录的成本；旧档无记录则按「含自己在内的拥有数」估算基础价
  const ownedBefore = state.buildings.filter((x) => x.type === b.type).length;
  const paid =
    b.cost ?? Math.floor(def.cost * Math.pow(def.costGrowth, Math.max(0, ownedBefore - 1)));
  return Math.floor(paid / 2);
}

/**
 * 拆除一栋社区建筑，返还其建造费用的一半。
 * 仅作用于 buildings（社区建筑，含道路）；工厂不在其中，避免误拆生产线。
 */
export function demolish(
  state: GameState,
  id: string,
): ActionResult<{ refund: number; name: string }> {
  const idx = state.buildings.findIndex((b) => b.id === id);
  if (idx < 0) return fail('建筑不存在');
  const b = state.buildings[idx];
  const def = BUILDINGS[b.type];
  const refund = demolishRefund(state, id);
  state.coins += refund;
  state.buildings.splice(idx, 1);
  return { ok: true, data: { refund, name: def.name } };
}

/** 升级一栋已有建筑到下一等级的成本（比新建便宜，鼓励就地升级、省空间） */
export function upgradeCost(state: GameState, id: string): number {
  const b = state.buildings.find((x) => x.id === id);
  if (!b) return Infinity;
  const owned = state.buildings.filter((x) => x.type === b.type).length;
  return Math.floor(buildCostOf(b.type, owned) * 0.6);
}

/**
 * 升级一栋已有建筑：
 *  - 住宅：先扩占地（1×1 → 2×1，扩不动则尝试 1×2），扩完再逐层加高（最多 3 层）。
 *    这样「升级」同时提供「更大 footprint」与「更多楼层」两种容量，且都不新增岛屿占地。
 *  - 其他点缀建筑：直接升层（缩放/装饰），占地固定。
 */
export function upgradeBuilding(
  state: GameState,
  id: string,
  now: number,
): ActionResult<{ level: number; cost: number; expanded?: boolean }> {
  const b = state.buildings.find((x) => x.id === id);
  if (!b) return fail('建筑不存在');
  const level = b.level ?? 1;

  // 住宅且仍是 1×1：优先扩建占地
  if (b.type === 'house' && (b.w ?? 1) * (b.h ?? 1) === 1 && b.gx != null && b.gz != null) {
    const dir = expandDir(state, b.gx, b.gz, id);
    if (dir) {
      const cost = Math.floor(upgradeCost(state, id) * 0.8);
      if (state.coins < cost) return fail('金币不够');
      state.coins -= cost;
      b.w = dir.w;
      b.h = dir.h;
      return { ok: true, data: { level, cost, expanded: true } };
    }
    // 扩不动则继续尝试升层
  }

  if (level >= BUILDING_MAX_LEVEL) return fail('已是最高级');
  const cost = upgradeCost(state, id);
  if (state.coins < cost) return fail('金币不够');

  state.coins -= cost;
  b.level = level + 1;
  void now;
  return { ok: true, data: { level: b.level, cost } };
}

export function sell(state: GameState, id: ItemId, count: number): ActionResult<{ coins: number }> {
  const have = state.inventory[id] ?? 0;
  if (have <= 0) return fail('没有这个物品');
  const n = Math.min(have, count);
  const coins = Math.floor(itemPrice(id) * n * SELL_RATE);
  const left = have - n;
  if (left <= 0) delete state.inventory[id];
  else state.inventory[id] = left;
  state.coins += coins;
  return { ok: true, data: { coins } };
}
