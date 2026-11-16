import { consumeItems, invCount, itemPrice } from './economy';
import { availableItems, pickVillager } from './orders';
import type { GameState, Wish } from './types';

export const WISH_SLOTS = 2;
/** 心愿给的数量少、回报甜：它更像"顺手帮个忙"，不该比订单更赚 */
const WISH_TIP_COINS = 1.35;

function makeWish(state: GameState, now: number): Wish | null {
  const items = availableItems(state);
  if (items.length === 0) return null;
  const item = items[Math.floor(Math.random() * items.length)];
  const price = itemPrice(item);
  const max = price > 1000 ? 1 : price > 300 ? 1 : price > 80 ? 2 : 3;
  const count = 1 + Math.floor(Math.random() * max);
  return {
    id: `w_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    villager: pickVillager(state),
    item,
    count,
    coins: Math.max(20, Math.floor(price * count * WISH_TIP_COINS)),
    gems: price >= 300 ? 2 : 1,
    createdAt: now,
  };
}

export function fillWishes(state: GameState, now: number): void {
  if (!state.wishes) state.wishes = [];
  while (state.wishes.length < WISH_SLOTS) {
    const w = makeWish(state, now);
    if (!w) break;
    state.wishes.push(w);
  }
}

export interface WishResult {
  coins: number;
  gems: number;
  villager: string;
}

/** 满足心愿：扣物品、给金币与宝石，并补一条新的 */
export function deliverWish(state: GameState, id: string, now: number): WishResult | null {
  const idx = state.wishes.findIndex((w) => w.id === id);
  if (idx < 0) return null;
  const w = state.wishes[idx];
  if (invCount(state, w.item) < w.count) return null;
  consumeItems(state, [{ id: w.item, count: w.count }]);
  state.coins += w.coins;
  state.gems += w.gems;
  state.stats.wishesDone = (state.stats.wishesDone ?? 0) + 1;
  state.wishes.splice(idx, 1);
  fillWishes(state, now);
  return { coins: w.coins, gems: w.gems, villager: w.villager };
}
