import { CROPS } from '../data/crops';
import { RECIPE_BY_ID, recipesOf, isDirectSell } from '../data/factories';
import { recordCrop, recordProduct } from './codex';
import { addItem, HARVEST_YIELD, incomeRate, itemPrice, SELL_RATE } from './economy';
import { FOCUS_MULT, isFocusing } from './focus';
import type { GameState, ItemId, OfflineReport, TickEvent } from './types';

const HOUR = 3_600_000;

/**
 * 离线被动收益倍率。放置游戏「离开有奖励」，但只该是加速器：
 * 1.3 倍于在线速率，配合离线时长上限，既奖励离开也不会让在线变得毫无意义。
 */
const OFFLINE_BONUS = 1.3;

/** 离线收益时长上限：4 小时起，每级 +0.15 小时，封顶 12 小时 */
export function offlineCapMs(level: number): number {
  return Math.min(4 + level * 0.15, 12) * HOUR;
}

export function isFever(state: GameState, now: number): boolean {
  return now < state.feverUntil;
}

/** Fever 期间收益翻倍 */
export function feverMult(state: GameState, now: number): number {
  return isFever(state, now) ? 2 : 1;
}

/** 收益总倍率：Fever 与专注可叠加 */
export function rewardMult(state: GameState, now: number): number {
  let m = 1;
  if (isFever(state, now)) m *= 2;
  if (isFocusing(state, now)) m *= FOCUS_MULT;
  return m;
}

/**
 * 结算从 state.savedAt 到 now 的推进。
 * 农场只成熟不自动收——把一键收获的快乐留给玩家回来点。
 * 工厂每个在用槽位离线最多完成一次，完成后留空，避免离线把在线玩法吃掉。
 */
export function advance(state: GameState, now: number): OfflineReport {
  const elapsed = Math.max(0, now - state.savedAt);
  const cap = offlineCapMs(state.level);
  const capped = elapsed > cap;
  const seconds = Math.min(elapsed, cap) / 1000;

  const produced: Partial<Record<ItemId, number>> = {};

  for (const f of state.factories) {
    for (const slot of f.slots) {
      if (!slot.recipe || slot.readyAt > now) continue;
      const recipe = RECIPE_BY_ID.get(slot.recipe);
      if (!recipe) continue;
      if (isDirectSell(recipe.output)) {
        // 生产即卖钱：直接折算金币，不进仓库、不占订单
        state.coins += itemPrice(recipe.output);
        recordProduct(state, recipe.output);
        produced[recipe.output] = (produced[recipe.output] ?? 0) + 1;
        slot.recipe = null;
        slot.readyAt = 0;
      } else {
        const got = addItem(state, recipe.output, 1);
        if (got > 0) {
          recordProduct(state, recipe.output);
          produced[recipe.output] = (produced[recipe.output] ?? 0) + got;
          slot.recipe = null;
          slot.readyAt = 0;
        }
      }
    }
  }

  // 经营收入：居民消费与观光，按估算速率结算
  const coins = Math.floor(incomeRate(state) * seconds * OFFLINE_BONUS);
  if (coins > 0) state.coins += coins;

  const ripePlots = state.plots.filter((p) => p.crop && p.readyAt <= now).length;

  state.savedAt = now;
  // 离线收益已结算，把在线累积锚点归位，避免加载后重复计入这段时间
  state.lastYieldAt = now;
  state.yieldCarry = 0;
  return { seconds, produced, coins, ripePlots, capped };
}

/**
 * 专注期间的自动农活：成熟的收掉，空地补上次的作物。
 * 人不在的时候小镇得自己转，这是番茄钟能成立的前提。
 *
 * 仓库塞满时不再干等——装不下的部分按 60% 折成金币，
 * 否则专注两分钟就卡死在仓库上限上了。
 */
function autoFarm(state: GameState, now: number): { harvested: number; planted: number } {
  let harvested = 0;
  let planted = 0;

  for (const plot of state.plots) {
    if (plot.crop && plot.readyAt <= now) {
      const crop = plot.crop;
      const got = addItem(state, crop, HARVEST_YIELD);
      const leftover = HARVEST_YIELD - got;
      if (leftover > 0) {
        state.coins += Math.floor(CROPS[crop].price * leftover * SELL_RATE);
      }
      // 装进仓库的、和折成金币的，都算收了一次——田里确实空了
      if (got > 0 || leftover > 0) {
        recordCrop(state, crop);
        state.stats.harvests += 1;
        harvested += 1;
        plot.crop = null;
        plot.plantedAt = 0;
        plot.readyAt = 0;
      }
    }

    if (!plot.crop && state.lastCrop && CROPS[state.lastCrop].unlockLevel <= state.level) {
      const crop = state.lastCrop;
      plot.crop = crop;
      plot.plantedAt = now;
      plot.readyAt = now + CROPS[crop].growMs;
      planted += 1;
    }
  }

  return { harvested, planted };
}

/**
 * 专注期间的自动开工：空闲槽位只要有料就投，优先做单价高的。
 * 和农田的自动收种接上后，整条「种 → 收 → 加工 → 出货」就自己转起来了。
 */
function autoFactory(state: GameState, now: number): number {
  let started = 0;

  for (const f of state.factories) {
    for (const slot of f.slots) {
      if (slot.recipe) continue;

      const candidates = recipesOf(f.type, state.level)
        .slice()
        .sort((a, b) => itemPrice(b.output) - itemPrice(a.output));
      const recipe = candidates.find((r) =>
        Object.entries(r.inputs).every(([id, n]) => (state.inventory[id as ItemId] ?? 0) >= (n ?? 0)),
      );
      if (!recipe) continue;

      for (const [id, n] of Object.entries(recipe.inputs)) {
        const key = id as ItemId;
        const left = (state.inventory[key] ?? 0) - (n ?? 0);
        if (left <= 0) delete state.inventory[key];
        else state.inventory[key] = left;
      }

      slot.recipe = recipe.id;
      slot.readyAt = now + Math.round(recipe.timeMs / FOCUS_MULT);
      started += 1;
    }
  }

  return started;
}

/** 在线推进：被动收益按帧累积，并处理「到点完成」与「状态过期」。 */
export function tick(state: GameState, now: number): TickEvent[] {
  const events: TickEvent[] = [];

  // 在线被动收益：放置游戏「看着它转就有进账」的核心。
  // 逐整金币进位，零头留在 yieldCarry 里，避免每帧取整把收益丢光。
  // 单次最多补 10 分钟：切后台时 rAF 会暂停，不该把整段时间都算成在线陪伴。
  const since = state.lastYieldAt && state.lastYieldAt > 0 ? state.lastYieldAt : now;
  const dtSec = Math.max(0, Math.min((now - since) / 1000, 600));
  if (dtSec > 0) {
    const raw = incomeRate(state) * dtSec + (state.yieldCarry ?? 0);
    const whole = Math.floor(raw);
    state.yieldCarry = raw - whole;
    if (whole > 0) state.coins += whole;
    state.stats.playSeconds += dtSec;
  }
  state.lastYieldAt = now;

  const focusing = isFocusing(state, now);

  // 专注中：田里自己种自己收，工厂自己开工，玩家回来只管收钱
  if (focusing) {
    const farm = autoFarm(state, now);
    if (farm.harvested > 0 || farm.planted > 0) {
      state.focus.harvested += farm.harvested;
      state.focus.planted += farm.planted;
      events.push({ kind: 'autofarm', harvested: farm.harvested, planted: farm.planted });
    }
    state.focus.produced += autoFactory(state, now);
  }

  for (const f of state.factories) {
    for (const slot of f.slots) {
      if (!slot.recipe || slot.readyAt > now) continue;
      const recipe = RECIPE_BY_ID.get(slot.recipe);
      if (!recipe) continue;
      if (isDirectSell(recipe.output)) {
        // 生产即卖钱：直接折算金币，不进仓库、不占订单
        state.coins += itemPrice(recipe.output);
        recordProduct(state, recipe.output);
        events.push({ kind: 'factory', item: recipe.output });
        slot.recipe = null;
        slot.readyAt = 0;
      } else {
        const got = addItem(state, recipe.output, 1);
        if (got > 0) {
          recordProduct(state, recipe.output);
          events.push({ kind: 'factory', item: recipe.output });
          slot.recipe = null;
          slot.readyAt = 0;
        } else if (focusing) {
          // 专注期间仓库满了就折成金币，别让整条产线堵在这儿
          state.coins += Math.floor(itemPrice(recipe.output) * SELL_RATE);
          events.push({ kind: 'factory', item: recipe.output });
          slot.recipe = null;
          slot.readyAt = 0;
        }
      }
    }
  }

  if (state.comboUntil && now > state.comboUntil) {
    state.combo = 0;
    state.comboUntil = 0;
  }

  return events;
}

/** 作物生长进度 0~1 */
export function plotProgress(plot: GameState['plots'][number], now: number): number {
  if (!plot.crop) return 0;
  const total = plot.readyAt - plot.plantedAt;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (now - plot.plantedAt) / total));
}

export function isRipe(plot: GameState['plots'][number], now: number): boolean {
  return !!plot.crop && plot.readyAt <= now;
}
