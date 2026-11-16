import { CROP_ORDER, CROPS } from '../data/crops';
import { recipesOf, isDirectSell } from '../data/factories';
import { consumeItems, expForLevel, hasItems, itemPrice } from './economy';
import { rewardMult } from './simulation';
import { festivalOrder } from './festival';
import type { GameState, ItemId, Order, OrderLine, ProductId } from './types';

export const ORDER_SLOTS = 3;
/** 委托人的名字池：都是小镇居民的感觉，带一点家常气 */
export const VILLAGERS = ['小满', '阿吉', '柚子', '豆豆', '老周', '桃桃', '阿福', '米粒', '小鹿', '团子'];
/** 村民委托的小费倍率：比系统派单略高一点，让"有人找你"这件事更值得期待 */
const VILLAGER_TIP = 1.12;
const FEVER_COMBO = 5;
const FEVER_MS = 30_000;
const COMBO_WINDOW_MS = 60_000;

/** 玩家当前能产出的物品：已解锁作物 + 已有工厂能做的产品 */
export function availableItems(state: GameState): ItemId[] {
  const crops = CROP_ORDER.filter((id) => CROPS[id].unlockLevel <= state.level);
  const products = state.factories.flatMap((f) =>
    recipesOf(f.type, state.level)
      .map((r) => r.output as ProductId)
      .filter((p) => !isDirectSell(p)),
  );
  return [...crops, ...new Set(products)];
}

function rollLines(items: ItemId[]): OrderLine[] {
  const wanted = items.length >= 3 ? 2 + Math.floor(Math.random() * 2) : Math.min(items.length, 2);
  const pool = [...items];
  const lines: OrderLine[] = [];
  for (let i = 0; i < wanted && pool.length > 0; i++) {
    const id = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    const price = itemPrice(id);
    // 越贵要得越少，避免订单太难
    const max = price > 1_000 ? 1 : price > 300 ? 2 : price > 80 ? 3 : 5;
    lines.push({ id, count: 1 + Math.floor(Math.random() * max) });
  }
  return lines;
}

/** 挑一个当前订单里还没出现过的居民，避免三张卡全是同一个人 */
export function pickVillager(state: GameState): string {
  const used = new Set(state.orders.map((o) => o.villager).filter(Boolean));
  const pool = VILLAGERS.filter((v) => !used.has(v));
  const list = pool.length > 0 ? pool : VILLAGERS;
  return list[Math.floor(Math.random() * list.length)];
}

export function makeOrder(state: GameState, now: number): Order {
  const items = availableItems(state);
  const lines = rollLines(items);
  const goods = lines.reduce((s, l) => s + itemPrice(l.id) * l.count, 0);
  const mult = 1.8 + Math.random() * 0.7;
  const villager = pickVillager(state);
  return {
    id: `o_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    lines,
    coins: Math.max(15, Math.floor(goods * mult * VILLAGER_TIP)),
    exp: Math.max(3, Math.ceil(goods / 20)),
    createdAt: now,
    villager,
  };
}

export function fillOrders(state: GameState, now: number): void {
  while (state.orders.length < ORDER_SLOTS) {
    state.orders.push(makeOrder(state, now));
  }
}

export interface DeliverResult {
  coins: number;
  exp: number;
  levelsGained: number;
  fever: boolean;
}

/** 发货：扣物品、给奖励、推进 combo，必要时触发 Fever */
export function deliver(state: GameState, orderId: string, now: number): DeliverResult | null {
  const idx = state.orders.findIndex((o) => o.id === orderId);
  if (idx < 0) return null;
  const order = state.orders[idx];
  if (!hasItems(state, order.lines)) return null;
  consumeItems(state, order.lines);

  // Fever 与专注可叠加，专注本身也是一层正反馈
  const mult = rewardMult(state, now) * festivalOrder();
  const coins = Math.floor(order.coins * mult);
  const exp = Math.floor(order.exp * mult);
  state.coins += coins;
  state.exp += exp;
  state.stats.ordersDone += 1;

  // combo：60 秒内连续发货才累计
  state.combo = now < state.comboUntil ? state.combo + 1 : 1;
  state.comboUntil = now + COMBO_WINDOW_MS;
  state.stats.bestCombo = Math.max(state.stats.bestCombo, state.combo);

  let fever = false;
  if (state.combo >= FEVER_COMBO) {
    state.feverUntil = now + FEVER_MS;
    state.combo = 0;
    fever = true;
  }

  let levelsGained = 0;
  while (state.exp >= expForLevel(state.level)) {
    state.exp -= expForLevel(state.level);
    state.level += 1;
    levelsGained += 1;
  }

  state.orders.splice(idx, 1);
  fillOrders(state, now);
  return { coins, exp, levelsGained, fever };
}

export { FEVER_COMBO };
