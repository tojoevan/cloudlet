import { BUILDINGS } from '../data/buildings';
import { CROPS } from '../data/crops';
import { FACTORIES, RECIPE_BY_ID, recipesOf } from '../data/factories';
import { recordBuilding, recordCrop, recordFactory } from './codex';
import { addItem, HARVEST_YIELD, itemPrice, populationOf, roomFor, SELL_RATE } from './economy';
import { FOCUS_MULT, isFocusing } from './focus';
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

function fail(reason: string): ActionResult<never> {
  return { ok: false, reason };
}

export function plant(state: GameState, plotId: number, crop: CropId, now: number): ActionResult {
  const plot = state.plots[plotId];
  if (!plot) return fail('地块不存在');
  if (plot.crop) return fail('这块地已经种了东西');
  if (CROPS[crop].unlockLevel > state.level) return fail('等级不够');

  plot.crop = crop;
  plot.plantedAt = now;
  plot.readyAt = now + CROPS[crop].growMs;
  state.lastCrop = crop;
  return { ok: true, data: undefined };
}

export function harvest(state: GameState, plotId: number, now: number): ActionResult<{ item: CropId; count: number }> {
  const plot = state.plots[plotId];
  if (!plot || !plot.crop) return fail('这里没有作物');
  if (plot.readyAt > now) return fail('还没成熟');

  const room = roomFor(state, HARVEST_YIELD);
  if (room <= 0) return fail('仓库满了，先交付订单');

  const crop = plot.crop;
  addItem(state, crop, room);
  recordCrop(state, crop);
  state.stats.harvests += 1;
  plot.crop = null;
  plot.plantedAt = 0;
  plot.readyAt = 0;
  return { ok: true, data: { item: crop, count: room } };
}

/** 一键收获：只收成熟的，返回总收获量供 UI 飘字 */
export function harvestAll(
  state: GameState,
  now: number,
): ActionResult<{ total: number; kinds: Partial<Record<ItemId, number>>; plots: number }> {
  const kinds: Partial<Record<ItemId, number>> = {};
  let total = 0;
  let plots = 0;

  // 先确认有成熟的地块，否则「仓库满」会被误报成「没成熟」
  const mature = state.plots.filter((p) => p.crop && p.readyAt <= now);
  if (mature.length === 0) return fail('还没有作物成熟');
  if (roomFor(state, 1) <= 0) return fail('仓库满了，先交付订单');

  for (const plot of mature) {
    const room = roomFor(state, HARVEST_YIELD);
    if (room <= 0) break;
    const crop = plot.crop!;
    const got = addItem(state, crop, room);
    if (got <= 0) break;
    recordCrop(state, crop);
    kinds[crop] = (kinds[crop] ?? 0) + got;
    total += got;
    plots += 1;
    state.stats.harvests += 1;
    plot.crop = null;
    plot.plantedAt = 0;
    plot.readyAt = 0;
  }

  if (plots === 0) return fail('仓库满了，先交付订单');
  return { ok: true, data: { total, kinds, plots } };
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

  // 专注期间生产提速，让番茄钟的收益看得见
  const timeMs = isFocusing(state, now) ? Math.round(recipe.timeMs / FOCUS_MULT) : recipe.timeMs;
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

export function buildFactory(state: GameState, type: FactoryType, now: number): ActionResult {
  const def = FACTORIES[type];
  if (def.unlockLevel > state.level) return fail(`需要 ${def.unlockLevel} 级`);
  if (state.factories.some((f) => f.type === type)) return fail('已经建过了');
  if (state.coins < def.buildCost) return fail('金币不够');

  state.coins -= def.buildCost;
  state.factories.push({ type, slots: [{ recipe: null, readyAt: 0 }] });
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

export function build(state: GameState, type: BuildingType, now: number): ActionResult<{ cost: number }> {
  const def = BUILDINGS[type];
  if (def.unlockLevel > state.level) return fail(`需要 ${def.unlockLevel} 级`);

  const owned = state.buildings.filter((b) => b.type === type).length;
  const cost = Math.floor(def.cost * Math.pow(def.costGrowth, owned));
  if (populationOf(state) < def.reqPop) return fail(`需要 ${def.reqPop} 人口`);
  if (state.coins < cost) return fail('金币不够');

  state.coins -= cost;
  state.buildings.push({
    id: `b_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    seed: Math.floor(Math.random() * 1e9),
  });
  recordBuilding(state, type);
  return { ok: true, data: { cost } };
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
