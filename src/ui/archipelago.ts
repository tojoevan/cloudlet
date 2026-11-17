import type { GameState } from '../core/types';
import {
  canUnlockExpansion,
  EXPANSIONS,
  expansionCount,
  hasExpansion,
  plotCountOf,
  trailDone,
  trailTasks,
} from '../core/expansion';
import { prosperityOf } from '../core/economy';
import { closeModal, el, fmt, openModal } from './dom';

export interface ArchipelagoHandlers {
  onUnlock: (id: string) => void;
}

/**
 * 云海拓荒：把“容量不够”变成看得见的目标。
 * 任务链不新增存档字段，直接读现有 stats/level；锚定后才真正 +4 块田。
 */
export function openArchipelagoPanel(state: GameState, h: ArchipelagoHandlers): void {
  const body = el('div');
  body.appendChild(
    el(
      'p',
      'hint',
      `主岛 ${plotCountOf(state) - expansionCount(state) * 4} 块田 · 当前 ${plotCountOf(state)} 块田 · 已锚定 ${expansionCount(state)}/2 座小岛`,
    ),
  );

  // 三步任务链
  const tasks = trailTasks(state);
  const taskBox = el('div', 'trail');
  for (const t of tasks) {
    const row = el('div', `trail-row${t.done ? ' done' : ''}`);
    const mark = el('span', 'trail-mark', t.done ? '✓' : '○');
    const text = el('div', 'trail-text');
    text.appendChild(el('strong', undefined, t.label));
    text.appendChild(el('span', undefined, t.hint));
    const prog = el('span', 'trail-progress', t.done ? '完成' : t.progress);
    row.append(mark, text, prog);
    taskBox.appendChild(row);
  }
  body.appendChild(taskBox);
  if (!trailDone(state)) {
    body.appendChild(el('p', 'hint', '完成手账后，才能把第一座小岛锚定到云海边缘。'));
  }

  // 两座小岛
  const grid = el('div', 'islet-grid');
  for (const def of EXPANSIONS) {
    const unlocked = hasExpansion(state, def.id);
    const chk = canUnlockExpansion(state, def.id);
    const card = el('div', `islet-card${unlocked ? ' unlocked' : ''}`);
    const head = el('div', 'islet-head');
    const flag = el('span', 'islet-flag');
    flag.style.background = unlocked ? '#d96f4f' : '#aab6ba';
    head.append(flag, el('strong', undefined, def.name));
    head.appendChild(el('span', 'islet-sub', def.subtitle));
    card.appendChild(head);
    card.appendChild(el('p', 'islet-desc', def.desc));
    card.appendChild(el('p', 'islet-gain', `+${def.plots} 块田 · 预计总田块 ${plotCountOf(state) + (unlocked ? 0 : def.plots)}`));

    const meta = el('div', 'islet-meta');
    meta.appendChild(el('span', undefined, `锚定费用 ${fmt(def.cost)} 金币`));
    if (def.reqProsperity > 0) {
      meta.appendChild(el('span', undefined, `繁荣度 ${prosperityOf(state)}/${def.reqProsperity}`));
    }
    card.appendChild(meta);

    const btn = el('button', 'btn sm islet-btn', unlocked ? '已锚定' : '锚定这座岛');
    btn.disabled = unlocked || !chk.ok;
    if (!unlocked && !chk.ok) {
      btn.title = chk.reason;
      card.appendChild(el('p', 'islet-reason', chk.reason));
    }
    if (!unlocked) {
      btn.addEventListener('click', () => {
        closeModal();
        h.onUnlock(def.id);
      });
    }
    card.appendChild(btn);
    grid.appendChild(card);
  }
  body.appendChild(grid);
  body.appendChild(
    el(
      'p',
      'note',
      '小岛与主岛使用同一套草地、岩壁与坡屋顶语言。每座只加 4 块田，不盖高楼、不扩主岛。',
    ),
  );

  openModal('云海拓荒', '把有限的岛，变成可生长的群岛。', body);
}
