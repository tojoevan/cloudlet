import { ACHIEVEMENTS } from '../core/achievements';
import { codexFound, codexTotal } from '../core/codex';
import { itemName, itemPrice, populationOf, SELL_RATE } from '../core/economy';
import { prosperityOf } from '../core/economy';
import { FOCUS_PRESETS, focusRemainMs, isFocusing } from '../core/focus';
import type { BuildingType, CropId, FactoryType, GameState, ItemId, Settings } from '../core/types';
import { BUILDINGS, BUILDING_ORDER } from '../data/buildings';
import { BUILDING_MAX_LEVEL, upgradeCost } from '../core/actions';
import { CROPS, CROP_ORDER } from '../data/crops';
import { FACTORIES, FACTORY_ORDER, PRODUCTS, recipesOf } from '../data/factories';
import { itemColor } from '../data/items';
import { SCHEME_LIST } from '../render/palette';
import * as auth from '../core/auth';
import { closeModal, el, fmt, fmtDur, fmtMMSS, hex, openModal, toast } from './dom';

function card(opts: {
  color: number;
  name: string;
  meta: string;
  disabled?: boolean;
  /** 图鉴里还没见过的东西：置灰但保持可点（点了给提示） */
  locked?: boolean;
  onClick: () => void;
}): HTMLButtonElement {
  const b = el('button', `card ${opts.locked ? 'locked' : ''}`.trim());
  b.disabled = !!opts.disabled;
  const icon = el('div', 'icon');
  icon.style.background = hex(opts.color);
  const g = el('div', 'grow');
  g.appendChild(el('div', 'name', opts.name));
  g.appendChild(el('div', 'meta', opts.meta));
  b.append(icon, g);
  b.addEventListener('click', opts.onClick);
  return b;
}

export function openPlantPanel(
  state: GameState,
  plotId: number,
  onPlant: (crop: CropId) => void,
): void {
  const grid = el('div', 'grid');
  for (const id of CROP_ORDER) {
    const def = CROPS[id];
    const locked = def.unlockLevel > state.level;
    grid.appendChild(
      card({
        color: def.fruit,
        name: def.name,
        meta: locked ? `${def.unlockLevel} 级解锁` : `${fmtDur(def.growMs)} · ${def.price} 金`,
        disabled: locked,
        onClick: () => {
          onPlant(id);
          closeModal();
        },
      }),
    );
  }
  openModal(`第 ${plotId + 1} 号地`, '生长时间越久，单价越高', grid);
}

export function openFactoryPanel(
  state: GameState,
  index: number,
  ctx: {
    onStart: (recipeId: string, slot: number) => void;
    onStartAll: () => void;
    onUnlock: () => void;
    onCollect: (slot: number) => void;
    onRush: (slot: number) => void;
  },
): void {
  const factory = state.factories[index];
  if (!factory) return;
  const def = FACTORIES[factory.type];
  const now = Date.now();

  const body = el('div');

  // 一键全部生产：只要有空闲槽位就亮起，点一下把能开的槽位全开起来
  const idleSlots = factory.slots.filter((s) => !s.recipe).length;
  const startAllBtn = el('button', 'btn primary', idleSlots > 0 ? '一键全部生产' : '暂无可生产槽位');
  startAllBtn.disabled = idleSlots === 0;
  startAllBtn.addEventListener('click', () => {
    ctx.onStartAll();
    closeModal();
  });
  body.appendChild(startAllBtn);
  factory.slots.forEach((slot, i) => {
    const row = el('div', 'field');
    if (slot.recipe) {
      const left = slot.readyAt - now;
      row.appendChild(el('label', undefined, `槽位 ${i + 1}`));
      row.appendChild(
        el('div', 'name', left > 0 ? `生产中 · 还剩 ${fmtDur(left)}` : '已完成，点击收取'),
      );
      if (left <= 0) {
        const b = el('button', 'btn sm', '收取');
        b.addEventListener('click', () => {
          ctx.onCollect(i);
          closeModal();
        });
        row.appendChild(b);
      } else if (state.gems > 0) {
        const rush = el('button', 'btn sm ghost', `加速（1 果实）`);
        rush.addEventListener('click', () => {
          ctx.onRush(i);
          closeModal();
        });
        row.appendChild(rush);
      }
    } else {
      row.appendChild(el('label', undefined, `槽位 ${i + 1} · 空闲`));
      const recipes = recipesOf(factory.type, state.level);
      if (recipes.length === 0) {
        row.appendChild(el('div', 'meta', '暂无可用配方'));
      }
      for (const r of recipes) {
        const parts = Object.entries(r.inputs)
          .map(([k, v]) => `${itemName(k as ItemId)}×${v}`)
          .join(' + ');
        const lacking = Object.entries(r.inputs).some(
          ([k, v]) => (state.inventory[k as ItemId] ?? 0) < (v ?? 0),
        );
        row.appendChild(
          el('div', 'meta', `${parts} → ${itemName(r.output)}（${fmtDur(r.timeMs)}${lacking ? ' · 材料不足' : ''}）`),
        );
        const b = el('button', 'btn sm', lacking ? '材料不足' : `生产 ${itemName(r.output)}`);
        b.disabled = lacking;
        b.addEventListener('click', () => {
          ctx.onStart(r.id, i);
          closeModal();
        });
        row.appendChild(b);
      }
    }
    body.appendChild(row);
  });

  const nextSlot = factory.slots.length - 1;
  const canUnlock = nextSlot < def.slotCosts.length;
  const cost = canUnlock ? def.slotCosts[nextSlot] : 0;
  const unlockBtn = el('button', 'btn', canUnlock ? `扩槽位 · ${fmt(cost)} 金` : '已是最大槽位');
  unlockBtn.disabled = !canUnlock || state.coins < cost;
  unlockBtn.addEventListener('click', () => {
    ctx.onUnlock();
    closeModal();
  });
  const row = el('div', 'row');
  row.appendChild(unlockBtn);
  body.appendChild(row);

  openModal(def.name, `当前 ${factory.slots.length} 个槽位`, body);
}

export function openBuildPanel(
  state: GameState,
  ctx: {
    onBuild: (t: BuildingType) => void;
    onBuildFactory: (t: FactoryType) => void;
    onUpgrade: (t: BuildingType) => void;
    onSwitchIsland: (id: string) => void;
    onSeedTest: () => void;
    /** 进入拆除模式：关闭面板后点选建筑即可拆除并返还一半费用 */
    onDemolish: () => void;
  },
): void {
  const body = el('div');
  const pop = populationOf(state);

  // 拆除：进入拆除模式（关闭面板后点选建筑）。返还一半建造费用，避免误操作有二次确认
  const demoRow = el('div', 'row');
  const demoBtn = el('button', 'btn ghost danger', '拆除建筑（返还一半费用）');
  demoBtn.addEventListener('click', () => {
    ctx.onDemolish();
    closeModal();
  });
  demoRow.appendChild(demoBtn);
  body.appendChild(demoRow);

  // 岛屿切换：两座独立岛，各有自己的建筑/农田/工厂
  body.appendChild(el('p', 'hint', '岛屿'));
  const islRow = el('div', 'row');
  const prosperity = prosperityOf(state);
  for (const isl of state.islands) {
    const unlocked = prosperity >= (isl.reqProsperity ?? 0);
    const b = el(
      'button',
      // 已解锁：高亮当前岛；未解锁：置灰并直接写出还需要多少繁荣度
      `btn sm${isl.id === state.activeIsland ? ' on' : ''}${unlocked ? '' : ' locked'}`.trim(),
      unlocked ? isl.name : `${isl.name}（繁荣 ${isl.reqProsperity}）`,
    );
    b.disabled = !unlocked;
    if (unlocked) {
      b.addEventListener('click', () => {
        ctx.onSwitchIsland(isl.id);
        closeModal();
      });
    }
    islRow.appendChild(b);
  }
  body.appendChild(islRow);

  // 方岛测试便捷入口：清空并随机重铺一层内容，方便看运行效果
  if (state.activeIsland === 'square') {
    const seedBtn = el('button', 'btn sm ghost', '随机填充（测试）');
    seedBtn.addEventListener('click', () => {
      ctx.onSeedTest();
      closeModal();
    });
    const seedRow = el('div', 'row');
    seedRow.appendChild(seedBtn);
    body.appendChild(seedRow);
  }

  body.appendChild(el('p', 'hint', '社区建筑'));
  const grid = el('div', 'grid');
  for (const t of BUILDING_ORDER) {
    const def = BUILDINGS[t];
    const owned = state.buildings.filter((b) => b.type === t).length;
    const cost = Math.floor(def.cost * Math.pow(def.costGrowth, owned));
    const locked = def.unlockLevel > state.level;
    const needPop = pop < def.reqPop;
    grid.appendChild(
      card({
        color: def.roof,
        name: def.name,
        meta: locked
          ? `${def.unlockLevel} 级解锁`
          : needPop
            ? `需要 ${def.reqPop} 人口`
            : `${fmt(cost)} 金 · ${def.desc}`,
        disabled: locked || needPop || state.coins < cost,
        onClick: () => {
          ctx.onBuild(t);
          closeModal();
        },
      }),
    );
  }
  body.appendChild(grid);

  // 升级已有建筑：就地升等级，人口/繁荣放大但不新增占地，比新建更省空间
  const upgradable = BUILDING_ORDER.filter(
    (t) =>
      t !== 'road' &&
      state.buildings.some((b) => b.type === t && (b.level ?? 1) < BUILDING_MAX_LEVEL),
  );
  if (upgradable.length > 0) {
    body.appendChild(el('p', 'hint', '升级建筑（更省空间）'));
    const ugrid = el('div', 'grid');
    for (const t of upgradable) {
      const def = BUILDINGS[t];
      // 选当前等级最低的那一栋来升
      const lowest = state.buildings
        .filter((b) => b.type === t)
        .reduce((a, b) => ((b.level ?? 1) < (a.level ?? 1) ? b : a));
      const cost = upgradeCost(state, lowest.id);
      const lv = lowest.level ?? 1;
      ugrid.appendChild(
        card({
          color: def.accent,
          name: `${def.name} Lv${lv}→${lv + 1}`,
          meta: `${fmt(cost)} 金 · 升为 ${lv + 1} 层小屋`,
          disabled: state.coins < cost,
          onClick: () => {
            ctx.onUpgrade(t);
            closeModal();
          },
        }),
      );
    }
    body.appendChild(ugrid);
  }

  body.appendChild(el('p', 'hint', '工厂'));
  const fgrid = el('div', 'grid');
  for (const t of FACTORY_ORDER) {
    const def = FACTORIES[t];
    const owned = state.factories.some((f) => f.type === t);
    const locked = def.unlockLevel > state.level;
    fgrid.appendChild(
      card({
        color: def.roof,
        name: def.name,
        meta: owned ? '已建成' : locked ? `${def.unlockLevel} 级解锁` : `${fmt(def.buildCost)} 金`,
        disabled: owned || locked || state.coins < def.buildCost,
        onClick: () => {
          ctx.onBuildFactory(t);
          closeModal();
        },
      }),
    );
  }
  body.appendChild(fgrid);
  openModal('建造', '工厂解锁加工链，社区建筑带来人口与繁荣度', body);
}

export function openInventoryPanel(state: GameState, onSell: (id: ItemId, count: number) => void): void {
  const total = Object.values(state.inventory).reduce((a, b) => a + (b ?? 0), 0);
  const body = el('div');
  const list = el('div', 'grid');
  const entries = Object.entries(state.inventory).filter(([, v]) => (v ?? 0) > 0);

  if (entries.length === 0) {
    body.appendChild(el('p', 'hint', '仓库是空的，去田里收点东西吧'));
  }
  for (const [id, count] of entries) {
    const item = id as ItemId;
    list.appendChild(
      card({
        color: itemColor(item),
        name: `${itemName(item)} ×${count}`,
        meta: `单价 ${itemPrice(item)} 金`,
        onClick: () => openSellChooser(state, item, count, onSell),
      }),
    );
  }
  body.appendChild(list);
  body.appendChild(el('p', 'note', '点物品选卖多少。按 60% 价格出售，仓库满了就出不了货。'));
  openModal('仓库', `容量 ${total}`, body);
}

/**
 * 二级面板：卖这个物品卖多少。
 * 提供常用比例（全部 / 3/4 / 1/2 / 1/4）一键卖出，也能填具体数量。
 */
function openSellChooser(
  state: GameState,
  id: ItemId,
  count: number,
  onSell: (id: ItemId, count: number) => void,
): void {
  const body = el('div');
  body.appendChild(el('p', 'hint', `${itemName(id)} ×${count} · 单价 ${itemPrice(id)} 金`));

  const ratios: Array<[string, number]> = [
    ['全部', 1],
    ['3/4', 0.75],
    ['1/2', 0.5],
    ['1/4', 0.25],
  ];
  const rgrid = el('div', 'grid');
  for (const [label, r] of ratios) {
    const n = r >= 1 ? count : Math.max(1, Math.floor(count * r));
    const coins = Math.floor(itemPrice(id) * n * SELL_RATE);
    rgrid.appendChild(
      card({
        color: itemColor(id),
        name: label,
        meta: `卖 ${n} 个 · +${coins} 金`,
        onClick: () => {
          onSell(id, n);
          closeModal();
        },
      }),
    );
  }
  body.appendChild(rgrid);

  // 自定义数量
  const row = el('div', 'row');
  const input = el('input', 'num') as HTMLInputElement;
  input.type = 'number';
  input.min = '1';
  input.max = String(count);
  input.value = String(count);
  input.placeholder = '数量';
  const go = el('button', 'sell-go', '卖出');
  go.addEventListener('click', () => {
    let n = Math.floor(Number(input.value));
    if (!Number.isFinite(n) || n < 1) n = 1;
    n = Math.min(n, count);
    onSell(id, n);
    closeModal();
  });
  row.append(input, go);
  body.appendChild(row);
  body.appendChild(el('p', 'note', `最多 ${count} 个，按 60% 价格出售。`));

  const back = el('button', 'back', '← 返回仓库');
  back.addEventListener('click', () => openInventoryPanel(state, onSell));
  body.appendChild(back);

  openModal(`卖出 ${itemName(id)}`, `共 ${count} 个`, body);
}

export interface SettingsHandlers {
  onChannel: (c: Settings['channel']) => void;
  onRadio: (url: string) => void;
  onVolume: (v: number) => void;
  onPowerSave: (on: boolean) => void;
  onQuality: (q: Settings['quality']) => void;
  onColorScheme: (id: string) => void;
  onRotate: () => void;
  /** 性能监控浮层开关 */
  onTogglePerf: (on: boolean) => void;
  onExport: () => string;
  onExportFile: () => void;
  onImport: (code: string) => void;
  onSync: () => void;
  /** 清空本地存档并刷新页面，回到初始小岛（云端若开启会重新拉取） */
  onReset: () => void;
  /** 返回 true 表示成功（main 会重建面板），返回 string 表示错误信息（面板内联展示） */
  onLogin: (username: string, password: string) => void | Promise<boolean | string | undefined>;
  onRegister: (username: string, password: string) => void | Promise<boolean | string | undefined>;
  onLogout: () => void | boolean | undefined;
}

/** 操作说明。旋转视角藏得太深，用户会找不到，干脆列出来 */
const CONTROL_HELP: [string, string][] = [
  ['拖动', '移动视角'],
  ['滚轮 / 双指捏合', '缩放'],
  ['Q / E 或 ← / →', '旋转小岛'],
  ['右键拖动 / Shift+拖动', '旋转小岛'],
  ['双指左右滑动', '旋转小岛（触屏）'],
  ['双指上下滑动', '缩放（触屏）'],
];

export function openSettingsPanel(
  state: GameState,
  syncText: string,
  h: SettingsHandlers,
): void {
  const body = el('div');

  // ---------- 账号分区（置顶） ----------
  const acct = el('div', 'account');
  if (auth.isLoggedIn()) {
    acct.appendChild(el('p', 'hint', '账号'));
    const info = el('div', 'row');
    info.appendChild(el('span', 'tag', `已登录 ${auth.username() ?? ''}`));
    info.appendChild(el('span', 'tag tier', `会员 V${auth.memberTier()}`));
    acct.appendChild(info);
    acct.appendChild(el('p', 'note', '进度自动同步到该账号，换设备登录即可继续。'));
    const logout = el('button', 'btn sm ghost', '退出登录');
    logout.addEventListener('click', () => {
      void h.onLogout();
    });
    acct.appendChild(logout);
  } else {
    acct.appendChild(el('p', 'hint', '账号（进度云同步到账号，换设备可继续）'));
    const uIn = el('input', 'input') as HTMLInputElement;
    uIn.placeholder = '用户名（3-20 位字母/数字/下划线）';
    const pIn = el('input', 'input') as HTMLInputElement;
    pIn.type = 'password';
    pIn.placeholder = '密码（至少 6 位）';
    const err = el('p', 'note err', '');
    const row = el('div', 'row');
    const login = el('button', 'btn sm', '登录');
    const reg = el('button', 'btn sm ghost', '注册');
    async function submit(fn: SettingsHandlers['onLogin'] | SettingsHandlers['onRegister']): Promise<void> {
      const res = await fn(uIn.value.trim(), pIn.value);
      if (typeof res === 'string') err.textContent = res;
      else err.textContent = '';
    }
    login.addEventListener('click', () => void submit(h.onLogin));
    reg.addEventListener('click', () => void submit(h.onRegister));
    row.append(login, reg);
    acct.append(uIn, pIn, row, err);
  }
  body.appendChild(acct);

  const help = el('div', 'help');
  for (const [key, act] of CONTROL_HELP) {
    const row = el('div', 'helprow');
    row.appendChild(el('span', 'key', key));
    row.appendChild(el('span', 'act', act));
    help.appendChild(row);
  }
  body.appendChild(help);

  const chRow = el('div', 'seg');
  const channels: Settings['channel'][] = [
    'citypop',
    'lofi',
    'ambient',
    'guitar',
    'country',
    'jazz',
    'shuffle',
    'radio',
    'off',
  ];
  const labels: Record<Settings['channel'], string> = {
    citypop: 'City Pop',
    lofi: 'Lo-fi',
    ambient: '环境音',
    guitar: '原声吉他',
    country: '乡村',
    jazz: '爵士',
    shuffle: '随机轮流',
    radio: '外接电台',
    off: '静音',
  };
  const chBtns: HTMLButtonElement[] = [];
  for (const c of channels) {
    const b = el('button', `btn sm ${state.settings.channel === c ? 'on' : ''}`.trim(), labels[c]);
    b.addEventListener('click', () => {
      chBtns.forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      h.onChannel(c);
    });
    chBtns.push(b);
    chRow.appendChild(b);
  }
  const chField = el('div', 'field');
  chField.appendChild(el('label', undefined, '背景音乐'));
  chField.appendChild(chRow);
  body.appendChild(chField);

  const radioField = el('div', 'field');
  radioField.appendChild(el('label', undefined, '电台地址（mp3 / m3u8 直链）'));
  const input = el('input');
  input.type = 'text';
  input.value = state.settings.radioUrl;
  input.placeholder = 'https://example.com/stream.mp3';
  input.addEventListener('change', () => h.onRadio(input.value.trim()));
  radioField.appendChild(input);
  body.appendChild(radioField);

  const volField = el('div', 'field');
  volField.appendChild(el('label', undefined, `音量 ${Math.round(state.settings.volume * 100)}%`));
  const vol = el('input');
  vol.type = 'range';
  vol.min = '0';
  vol.max = '100';
  vol.value = String(Math.round(state.settings.volume * 100));
  vol.addEventListener('input', () => h.onVolume(Number(vol.value) / 100));
  volField.appendChild(vol);
  body.appendChild(volField);

  // 画质：省电 / 标准 / 高。默认「标准」，移动端可切省电，桌面强机可开「高」。
  const qField = el('div', 'field');
  qField.appendChild(el('label', undefined, '画质'));
  const qSeg = el('div', 'seg');
  const QLABELS: Record<Settings['quality'], string> = {
    low: '省电',
    standard: '标准',
    high: '高',
  };
  (['low', 'standard', 'high'] as Settings['quality'][]).forEach((q) => {
    const b = el('button', `btn sm${state.settings.quality === q ? ' on' : ''}`, QLABELS[q]);
    b.addEventListener('click', () => {
      qSeg.querySelectorAll('.btn').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      h.onQuality(q);
    });
    qSeg.appendChild(b);
  });
  qField.appendChild(qSeg);
  body.appendChild(qField);

  // 色系：马卡龙 / 奶油水彩 / 果冻糖果 / 晨雾清新。切了会整体重建场景配色
  const cField = el('div', 'field');
  cField.appendChild(el('label', undefined, '色系'));
  const cSeg = el('div', 'seg');
  const cBtns: HTMLButtonElement[] = [];
  for (const sc of SCHEME_LIST) {
    const b = el('button', `btn sm ${state.settings.colorScheme === sc.id ? 'on' : ''}`.trim(), sc.name);
    b.addEventListener('click', () => {
      cBtns.forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      h.onColorScheme(sc.id);
    });
    cBtns.push(b);
    cSeg.appendChild(b);
  }
  cField.appendChild(cSeg);
  body.appendChild(cField);

  const row = el('div', 'row');
  const ps = el('button', 'btn ghost', state.settings.powerSave ? '省电模式：开' : '省电模式：关');
  ps.addEventListener('click', () => {
    const next = !state.settings.powerSave;
    ps.textContent = next ? '省电模式：开' : '省电模式：关';
    h.onPowerSave(next);
  });
  const rot = el('button', 'btn ghost', '旋转视角');
  rot.addEventListener('click', () => {
    h.onRotate();
    closeModal();
  });
  row.append(ps, rot);
  body.appendChild(row);

  // 性能监控：实时 FPS/帧时间/DrawCall 等，掉帧时高亮告警（持续关注性能异常）
  const perfRow = el('div', 'row');
  const perfBtn = el('button', 'btn ghost', state.settings.perfMonitor ? '性能监控：开' : '性能监控：关');
  perfBtn.addEventListener('click', () => {
    const next = !state.settings.perfMonitor;
    perfBtn.textContent = next ? '性能监控：开' : '性能监控：关';
    h.onTogglePerf(next);
  });
  perfRow.appendChild(perfBtn);
  body.appendChild(perfRow);

  body.appendChild(el('p', 'hint', '存档'));
  const saveRow = el('div', 'row');
  const exp = el('button', 'btn sm', '导出存档码');
  exp.addEventListener('click', () => {
    const code = h.onExport();
    void navigator.clipboard?.writeText(code).catch(() => undefined);
    toast('存档码已复制，粘到另一台设备即可');
  });
  const expFile = el('button', 'btn sm', '导出文件');
  expFile.addEventListener('click', () => h.onExportFile());
  const imp = el('button', 'btn sm', '导入存档码');
  imp.addEventListener('click', () => {
    const code = window.prompt('粘贴存档码（也可直接粘贴 .json 文件内容）');
    if (code) h.onImport(code);
  });
  const impFile = el('button', 'btn sm', '导入文件');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      h.onImport(text);
      fileInput.value = '';
    };
    reader.readAsText(f);
  });
  impFile.addEventListener('click', () => fileInput.click());
  const sync = el('button', 'btn sm', '立即同步');
  sync.addEventListener('click', h.onSync);
  const reset = el('button', 'btn sm danger', '重置存档');
  reset.addEventListener('click', () => {
    if (window.confirm('确定清空本地存档、回到初始小岛吗？此操作不可撤销。')) {
      h.onReset();
    }
  });
  saveRow.append(exp, expFile, imp, impFile, fileInput, sync, reset);
  body.appendChild(saveRow);
  body.appendChild(
    el(
      'p',
      'note',
      state.settings.cloudSync
        ? syncText
        : `${syncText}。自动同步默认关闭，手动同步成功一次后会自动打开。`,
    ),
  );

  openModal('设置', '挂着也好听', body);
}

export function openFocusPanel(
  state: GameState,
  now: number,
  ctx: { onStart: (minutes: number) => void; onCancel: () => void },
): void {
  const body = el('div');

  if (isFocusing(state, now)) {
    const remain = focusRemainMs(state, now);
    body.appendChild(el('p', 'hint', '专注中，小镇正在加速运转'));
    const grid = el('div', 'grid');
    grid.appendChild(
      card({
        color: 0xe07a5f,
        name: fmtMMSS(remain),
        meta: '剩余时间',
        onClick: () => closeModal(),
      }),
    );
    body.appendChild(grid);
    const row = el('div', 'row');
    const cancel = el('button', 'btn ghost', '放弃这次专注');
    cancel.addEventListener('click', () => {
      ctx.onCancel();
      closeModal();
    });
    row.appendChild(cancel);
    body.appendChild(row);
    body.appendChild(
      el(
        'p',
        'note',
        `专注期间收益 ×1.5、工厂提速 50%，田里自动收种、工厂自动开工，音乐会自动安静下来。中途放弃按已完成分钟折半结算。\n已自动收了 ${state.focus.harvested} 块地、产出 ${state.focus.produced} 批货、放下 ${state.focus.placed} 处建造。`,
      ),
    );
    openModal('番茄钟', '放下手机，去做点正事', body);
    return;
  }

  const grid = el('div', 'grid');
  for (const m of FOCUS_PRESETS) {
    grid.appendChild(
      card({
        color: 0xe07a5f,
        name: `${m} 分钟`,
        meta: `完成后得 ${Math.max(1, Math.round(m / 12))} 颗专注果实`,
        onClick: () => {
          ctx.onStart(m);
          closeModal();
        },
      }),
    );
  }
  body.appendChild(grid);
  const farmHint = state.lastCrop
    ? `田里会自动收获并补种「${CROPS[state.lastCrop].name}」`
    : '田里会自动打理，但要先种一次作物，小镇才知道该种什么';
  body.appendChild(
    el(
      'p',
      'note',
      `专注期间：订单收益 ×1.5、工厂提速 50% 并自动开工，${farmHint}；小镇还会自动发货、自动建造升级、仓库满分批出售，与热潮可叠加。专注果实能立刻完成一次工厂生产。\n已完成 ${state.stats.focusSessions} 次，累计 ${state.stats.focusMinutes} 分钟。\n（连续 5 分钟不操作，会自动进入 25 分钟专注）`,
    ),
  );
  openModal('番茄钟', '选一段时间，把小镇挂在旁边', body);
}

export function openCodexPanel(state: GameState): void {
  const body = el('div');

  const section = (title: string) => {
    body.appendChild(el('p', 'hint', title));
    const grid = el('div', 'grid');
    body.appendChild(grid);
    return grid;
  };

  const crops = section('作物');
  for (const id of CROP_ORDER) {
    const def = CROPS[id];
    const found = state.codex.crops.includes(id);
    crops.appendChild(
      card({
        color: def.fruit,
        name: found ? def.name : '未发现',
        meta: found ? `${fmtDur(def.growMs)} · ${def.price} 金` : '收获一次即可收录',
        locked: !found,
        onClick: () => closeModal(),
      }),
    );
  }

  const products = section('加工品');
  for (const def of Object.values(PRODUCTS)) {
    const found = state.codex.products.includes(def.id);
    products.appendChild(
      card({
        color: itemColor(def.id),
        name: found ? def.name : '未发现',
        meta: found ? `${def.price} 金` : '工厂产出一次即可收录',
        locked: !found,
        onClick: () => closeModal(),
      }),
    );
  }

  const builds = section('建筑与工厂');
  for (const t of BUILDING_ORDER) {
    const def = BUILDINGS[t];
    const found = state.codex.buildings.includes(t);
    builds.appendChild(
      card({
        color: def.roof,
        name: found ? def.name : '未发现',
        meta: found ? def.desc : '建造一次即可收录',
        locked: !found,
        onClick: () => closeModal(),
      }),
    );
  }
  for (const t of FACTORY_ORDER) {
    const def = FACTORIES[t];
    const found = state.codex.factories.includes(t);
    builds.appendChild(
      card({
        color: def.roof,
        name: found ? def.name : '未发现',
        meta: found ? `${def.unlockLevel} 级解锁` : '建造一次即可收录',
        locked: !found,
        onClick: () => closeModal(),
      }),
    );
  }

  openModal('图鉴', `已收录 ${codexFound(state)} / ${codexTotal()}`, body);
}

export function openAchievementsPanel(state: GameState): void {
  const body = el('div');
  const grid = el('div', 'grid');

  for (const a of ACHIEVEMENTS) {
    const got = state.achievements.includes(a.id);
    grid.appendChild(
      card({
        color: got ? 0xe9b824 : 0xb4b2a9,
        name: got ? a.name : '未解锁',
        meta: got ? `${a.desc} · +${a.coins} 金` : a.desc,
        locked: !got,
        onClick: () => closeModal(),
      }),
    );
  }
  body.appendChild(grid);
  body.appendChild(
    el('p', 'note', '成就只给一次性奖励，不提供持续加成——它负责给你回来的理由，不负责破坏平衡。'),
  );
  openModal('成就', `已达成 ${state.achievements.length} / ${ACHIEVEMENTS.length}`, body);
}

export function openOfflinePanel(report: {
  seconds: number;
  coins: number;
  ripe: number;
  produced: [string, number][];
}): void {
  const body = el('div');

  // 回归演出：先把「你不在的时候小镇替你赚了多少」放大成主角，
  // 其余的成熟地块、工厂产出退成次要信息。
  const hero = el('div', 'offline-hero');
  hero.appendChild(el('div', 'offline-amount', `+${fmt(report.coins)}`));
  hero.appendChild(el('div', 'offline-unit', '金币 · 居民消费与观光收入'));
  body.appendChild(hero);

  const list = el('div', 'grid');

  if (report.ripe > 0) {
    list.appendChild(
      card({
        color: 0x6a994e,
        name: `${report.ripe} 块地熟了`,
        meta: '点「一键收获」收下',
        onClick: () => closeModal(),
      }),
    );
  }
  for (const [name, n] of report.produced) {
    list.appendChild(
      card({
        color: 0x457b9d,
        name: `${name} ×${n}`,
        meta: '工厂在你离开时产出的',
        onClick: () => closeModal(),
      }),
    );
  }

  if (list.childElementCount > 0) body.appendChild(list);
  body.appendChild(el('p', 'note', '小镇一直在自己转，随时回来看看就好。'));

  openModal('欢迎回来', `你离开了 ${fmtDur(report.seconds * 1000)}`, body);
}
