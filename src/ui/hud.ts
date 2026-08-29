import { ACHIEVEMENTS } from '../core/achievements';
import { codexFound, codexTotal } from '../core/codex';
import {
  capacityOf,
  expForLevel,
  invTotal,
  itemName,
  populationOf,
  prosperityOf,
} from '../core/economy';
import { focusRemainMs, isFocusing } from '../core/focus';
import { isFever } from '../core/simulation';
import type { GameState, ItemId } from '../core/types';
import { itemColor } from '../data/items';
import { el, fmt, fmtMMSS, hex, swatch } from './dom';

interface Chip {
  root: HTMLElement;
  text: HTMLElement;
  sub: HTMLElement;
}

function makeChip(color: number | null, cls = ''): Chip {
  const root = el('div', `chip ${cls}`.trim());
  if (color !== null) {
    const dot = el('span', 'dot');
    dot.style.background = hex(color);
    root.appendChild(dot);
  }
  const text = el('span', undefined, '');
  const sub = el('span', 'sub', '');
  root.appendChild(text);
  root.appendChild(sub);
  return { root, text, sub };
}

export class HUD {
  readonly el = el('div', 'hud');
  private lv = makeChip(null, 'lv');
  private coin = makeChip(0xe9b824);
  private prop = makeChip(0x6a994e);
  private store = makeChip(0x457b9d);
  private fever = el('div', 'chip fever', '热潮 ×2');
  /** 图鉴与成就做成可点的进度展示，既是入口也是收集欲的钩子 */
  private codex = makeChip(0x9b8ec4, 'clickable');
  private ach = makeChip(0xe9b824, 'clickable');

  constructor(onCodex: () => void, onAch: () => void) {
    this.el.append(
      this.lv.root,
      this.coin.root,
      this.prop.root,
      this.store.root,
      this.fever,
      this.codex.root,
      this.ach.root,
    );
    this.fever.style.display = 'none';
    this.codex.root.addEventListener('click', onCodex);
    this.ach.root.addEventListener('click', onAch);
  }

  update(state: GameState, now: number): void {
    this.lv.text.textContent = `Lv ${state.level}`;
    this.lv.sub.textContent = `${state.exp}/${expForLevel(state.level)}`;

    this.coin.text.textContent = fmt(state.coins);
    this.coin.sub.textContent = '金币';

    this.prop.text.textContent = fmt(prosperityOf(state));
    this.prop.sub.textContent = `人口 ${populationOf(state)}`;

    this.store.text.textContent = `${invTotal(state)}/${capacityOf(state)}`;
    this.store.sub.textContent = '仓库';

    this.codex.text.textContent = `${codexFound(state)}/${codexTotal()}`;
    this.codex.sub.textContent = '图鉴';

    this.ach.text.textContent = `${state.achievements.length}/${ACHIEVEMENTS.length}`;
    this.ach.sub.textContent = '成就';

    this.fever.style.display = isFever(state, now) ? '' : 'none';
  }
}

export class OrderBoard {
  readonly el = el('div', 'orders');
  private sig = '';

  update(state: GameState, onDeliver: (orderId: string) => void): void {
    // 只在订单集合或可交付状态变化时重建，避免每帧刷 DOM
    const sig = state.orders
      .map((o) => `${o.id}:${o.lines.every((l) => (state.inventory[l.id] ?? 0) >= l.count) ? 1 : 0}`)
      .join('|');
    if (sig === this.sig) return;
    this.sig = sig;

    this.el.replaceChildren();
    for (const order of state.orders) {
      const card = el('div', 'order');
      const lines = el('div', 'lines');

      for (const line of order.lines) {
        const have = state.inventory[line.id] ?? 0;
        const ok = have >= line.count;
        const need = el('div', `need ${ok ? 'ok' : ''}`.trim());
        need.appendChild(swatch(itemColor(line.id)));
        need.appendChild(el('span', undefined, `${itemName(line.id)} ${have}/${line.count}`));
        lines.appendChild(need);
      }

      const foot = el('div', 'foot');
      foot.appendChild(el('span', 'reward', `${fmt(order.coins)} 金币`));
      const btn = el('button', 'btn sm', '发货');
      btn.disabled = !order.lines.every((l) => (state.inventory[l.id] ?? 0) >= l.count);
      btn.addEventListener('click', () => onDeliver(order.id));
      foot.appendChild(btn);

      card.append(lines, foot);
      this.el.appendChild(card);
    }
  }
}

export interface ActionHandlers {
  onHarvestAll: () => void;
  onReplant: () => void;
  onBuild: () => void;
  onInventory: () => void;
  onSettings: () => void;
  onFocus: () => void;
}

export class ActionBar {
  readonly el = el('div', 'actionbar');
  private harvestBadge = el('span', 'badge');
  private harvestBtn: HTMLButtonElement;
  private replantBtn: HTMLButtonElement;
  private focusBtn: HTMLButtonElement;
  private focusLabel: HTMLElement;

  constructor(h: ActionHandlers) {
    const mk = (label: string, fn: () => void, cls = '') => {
      const b = el('button', `btn ${cls}`.trim());
      const span = el('span', undefined, label);
      b.appendChild(span);
      b.addEventListener('click', fn);
      return { btn: b, label: span };
    };

    const harvest = mk('一键收获', h.onHarvestAll, 'accent');
    this.harvestBtn = harvest.btn;
    this.harvestBtn.appendChild(this.harvestBadge);
    this.replantBtn = mk('补种', h.onReplant).btn;

    const focus = mk('专注', h.onFocus, 'ghost');
    this.focusBtn = focus.btn;
    this.focusLabel = focus.label;

    this.el.append(
      this.harvestBtn,
      this.replantBtn,
      mk('建造', h.onBuild).btn,
      focus.btn,
      mk('仓库', h.onInventory).btn,
      mk('设置', h.onSettings, 'ghost').btn,
    );
  }

  update(state: GameState, now: number): void {
    const ripe = state.plots.filter((p) => p.crop && p.readyAt <= now).length;
    this.harvestBadge.textContent = ripe > 0 ? String(ripe) : '';
    this.harvestBadge.style.display = ripe > 0 ? '' : 'none';
    this.harvestBtn.disabled = ripe === 0;

    const canReplant = !!state.lastCrop;
    this.replantBtn.disabled = !canReplant;
    this.replantBtn.lastChild!.textContent = canReplant ? `补种${cropShort(state.lastCrop!)}` : '补种';

    // 专注中按钮变倒计时，点它可以放弃
    if (isFocusing(state, now)) {
      this.focusLabel.textContent = fmtMMSS(focusRemainMs(state, now));
      this.focusBtn.classList.remove('ghost');
      this.focusBtn.classList.add('accent');
    } else {
      this.focusLabel.textContent = '专注';
      this.focusBtn.classList.add('ghost');
      this.focusBtn.classList.remove('accent');
    }
  }
}

function cropShort(id: ItemId): string {
  const n = itemName(id);
  return n.length > 2 ? n.slice(0, 2) : n;
}
