import './styles/main.css';
import * as THREE from 'three';
import { AudioManager } from './audio';
import {
  build,
  buildFactory,
  harvest,
  harvestAll,
  plant,
  replantAll,
  rushSlot,
  sell,
  startAllSlots,
  startRecipe,
  unlockSlot,
} from './core/actions';
import { checkAchievements } from './core/achievements';
import {
  cloudPull,
  cloudPush,
  describeStatus,
  isPaused,
  resetPause,
  type SyncStatus,
} from './core/cloud';
import { addItem, itemName } from './core/economy';
import { cancelFocus, focusProgress, isFocusing, settleFocus, startFocus } from './core/focus';
import { deliver } from './core/orders';
import { exportCode, getDeviceId, importCode, loadLocal, saveLocal } from './core/save';
import { advance, tick } from './core/simulation';
import { createInitialState } from './core/state';
import type { BuildingType, CropId, FactoryType, ItemId } from './core/types';
import { RECIPE_BY_ID } from './data/factories';
import { randomLine, randomFarmLine, randomLumberLine, randomRanchLine } from './data/lines';
import { plotPosition, World } from './render/world';
import { SceneView } from './render/scene';
import { closeModal, el, floatAt, initUI, toast } from './ui/dom';
import { ActionBar, HUD, OrderBoard } from './ui/hud';
import { SpeechBubble } from './ui/speech';
import {
  openAchievementsPanel,
  openBuildPanel,
  openCodexPanel,
  openFactoryPanel,
  openFocusPanel,
  openInventoryPanel,
  openOfflinePanel,
  openPlantPanel,
  openSettingsPanel,
} from './ui/panels';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

initUI(uiRoot);
const view = new SceneView(canvas);
const world = new World(view.scene);
// 把岛屿包围盒交给镜头，进入专注/点击倒计时条时据此算出「岛屿最大显示不遮挡」的最佳缩放
view.setFitBox(world.fitBox());
const audio = new AudioManager();

const deviceId = getDeviceId();
let state = loadLocal() ?? createInitialState(deviceId);
state.deviceId = deviceId;

let syncStatus: SyncStatus = 'idle';
let dirty = true;
let audioReady = false;

/** 状态一变就要重建场景结构，用脏标记避免每帧 diff */
function markDirty(): void {
  dirty = true;
}

// ---------- 离线结算 ----------
{
  const now = Date.now();
  const away = now - state.savedAt;
  if (away > 60_000) {
    const report = advance(state, now);
    const produced = Object.entries(report.produced) as [ItemId, number][];
    if (report.coins > 0 || produced.length > 0 || report.ripePlots > 0) {
      openOfflinePanel({
        seconds: report.seconds,
        coins: report.coins,
        ripe: report.ripePlots,
        produced: produced.map(([id, n]) => [itemName(id), n]),
      });
    }
  } else {
    state.savedAt = now;
  }
}

// ---------- UI ----------
const hud = new HUD(
  () => openCodexPanel(state),
  () => openAchievementsPanel(state),
  () => openInventoryPanel(state, (id, count) => doSell(id, count)),
);
const board = new OrderBoard();

// 番茄钟进度条贴在屏幕最上沿，专注时才出现
const focusBar = el('div', 'focusbar');
const focusFill = el('div', 'fill');
const focusLabel = el('span', 'label');
focusBar.appendChild(focusFill);
focusBar.appendChild(focusLabel);
focusBar.style.display = 'none';
// 专注中点击倒计时条：无论之前手动调过缩放/角度，都拉回最佳视角并重新自转
focusBar.title = '点击：回到最佳缩放并自动旋转';
focusBar.addEventListener('click', () => {
  if (isFocusing(state, Date.now())) view.startShowcase();
  // 点专注横幅属于「操作专注控件」，立即把 UI 重新藏起来
  hideFocusUi();
});

const bar = new ActionBar({
  onHarvestAll: () => {
    const r = harvestAll(state, Date.now());
    if (!r.ok) return toast(r.reason);
    audio.play('harvest');
    floatAtCanvas(`+${r.data.total} 收获`, 'good');
    markDirty();
    saveNow();
  },
  onReplant: () => {
    if (!state.lastCrop) return;
    const r = replantAll(state, state.lastCrop, Date.now());
    if (!r.ok) return toast(r.reason);
    audio.play('plant');
    toast(`补种了 ${r.data.plots} 块地`);
    markDirty();
    saveNow();
  },
  onBuild: () => openBuildPanel(state, { onBuild: doBuild, onBuildFactory: doBuildFactory }),
  onFocus: () =>
    openFocusPanel(state, Date.now(), {
      onStart: (minutes) => {
        startFocus(state, minutes, Date.now());
        audio.setDucking(true);
        toast(`专注 ${minutes} 分钟，去做正事吧`);
        saveNow();
      },
      onCancel: () => {
        const r = cancelFocus(state, Date.now());
        audio.setDucking(false);
        if (!r) return;
        const parts: string[] = [];
        if (r.harvested > 0) parts.push(`收了 ${r.harvested} 块地`);
        if (r.produced > 0) parts.push(`产出 ${r.produced} 批货`);
        const work = parts.length > 0 ? `，${parts.join('、')}` : '';
        toast(
          r.minutes > 0 ? `已专注 ${r.minutes} 分钟，得 ${r.gems} 颗果实${work}` : '放弃了这次专注',
        );
        saveNow();
      },
    }),
  onSettings: () =>
    openSettingsPanel(state, describeStatus(syncStatus), {
      onChannel: (c) => {
        state.settings.channel = c;
        audio.setChannel(c);
      },
      onRadio: (url) => {
        state.settings.radioUrl = url;
        audio.setRadioUrl(url);
      },
      onVolume: (v) => {
        state.settings.volume = v;
        audio.setVolume(v);
      },
      onPowerSave: (on) => {
        state.settings.powerSave = on;
        view.setPowerSave(on);
      },
      onRotate: () => view.rotateBy(Math.PI / 2),
      onExport: () => exportCode(state),
      onImport: (code) => {
        const s = importCode(code);
        if (!s) return toast('存档码无法识别');
        state = s;
        state.deviceId = deviceId;
        saveLocal(state);
        markDirty();
        toast('存档已导入');
        closeModal();
      },
      onSync: () => {
        void syncNow(true).then(() => {
          // 手动同步成功过一次，说明后端是通的，之后才自动同步
          if (syncStatus === 'ok' && !state.settings.cloudSync) {
            state.settings.cloudSync = true;
            saveLocal(state);
          }
        });
      },
    }),
});

uiRoot.append(hud.el, board.el, bar.el, focusBar);
const speech = new SpeechBubble(uiRoot);

function floatAtCanvas(text: string, kind: '' | 'gold' | 'good' = ''): void {
  floatAt(window.innerWidth / 2, window.innerHeight * 0.42, text, kind);
}

function floatAtPlot(index: number, text: string, kind: '' | 'gold' | 'good' = ''): void {
  const p = plotPosition(index).clone();
  p.y += 0.9;
  const s = world.worldToScreen(p, view.camera, canvas);
  floatAt(s.x, s.y, text, kind);
}

// ---------- 玩家动作 ----------
function doPlant(plotId: number, crop: CropId): void {
  const r = plant(state, plotId, crop, Date.now());
  if (!r.ok) {
    audio.play('error');
    return toast(r.reason);
  }
  audio.play('plant');
  markDirty();
  saveNow();
}

function doHarvest(plotId: number): void {
  const r = harvest(state, plotId, Date.now());
  if (!r.ok) {
    audio.play('error');
    return toast(r.reason);
  }
  audio.play('harvest');
  floatAtPlot(plotId, `+${r.data.count} ${itemName(r.data.item)}`, 'good');
  markDirty();
  saveNow();
}

function doDeliver(orderId: string): void {
  const r = deliver(state, orderId, Date.now());
  if (!r) {
    audio.play('error');
    return toast('物品还不够');
  }
  audio.play('deliver');
  floatAtCanvas(`+${r.coins} 金币`, 'gold');
  if (r.fever) {
    audio.play('fever');
    audio.setIntensity(1);
    toast('热潮来了！收益翻倍 30 秒');
  }
  if (r.levelsGained > 0) {
    audio.play('levelup');
    toast(`升到 ${state.level} 级`);
  }
  markDirty();
  saveNow();
}

function doBuild(type: BuildingType): void {
  const r = build(state, type, Date.now());
  if (!r.ok) {
    audio.play('error');
    return toast(r.reason);
  }
  audio.play('coin');
  toast(`${type === 'house' ? '小屋' : '建筑'}落成`);
  markDirty();
  saveNow();
}

function doBuildFactory(type: FactoryType): void {
  const r = buildFactory(state, type, Date.now());
  if (!r.ok) {
    audio.play('error');
    return toast(r.reason);
  }
  audio.play('coin');
  toast('工厂建好了，点它开始生产');
  markDirty();
  saveNow();
}

function doSell(id: ItemId, count: number): void {
  const r = sell(state, id, count);
  if (!r.ok) return toast(r.reason);
  audio.play('coin');
  toast(`卖出 ${count} 个，得 ${r.data.coins} 金币`);
  markDirty();
  saveNow();
}

function openFactory(index: number): void {
  openFactoryPanel(state, index, {
    onStart: (recipeId, slot) => {
      const r = startRecipe(state, index, slot, recipeId, Date.now());
      if (!r.ok) {
        audio.play('error');
        return toast(r.reason);
      }
      audio.play('click');
      markDirty();
      saveNow();
    },
    onStartAll: () => {
      const r = startAllSlots(state, index, Date.now());
      if (!r.ok) {
        audio.play('error');
        return toast(r.reason);
      }
      audio.play('click');
      toast(`已开工 ${r.data.started} 个槽位`);
      markDirty();
      saveNow();
    },
    onUnlock: () => {
      const r = unlockSlot(state, index, Date.now());
      if (!r.ok) {
        audio.play('error');
        return toast(r.reason);
      }
      audio.play('coin');
      markDirty();
      saveNow();
    },
    onCollect: (slot) => {
      const s = state.factories[index]?.slots[slot];
      if (!s?.recipe) return;
      const recipe = RECIPE_BY_ID.get(s.recipe);
      if (!recipe) return;
      const got = addItem(state, recipe.output, 1);
      if (got === 0) return toast('仓库满了，先交付订单');
      s.recipe = null;
      s.readyAt = 0;
      audio.play('coin');
      toast(`收到 ${itemName(recipe.output)}`);
      markDirty();
      saveNow();
    },
    onRush: (slot) => {
      const r = rushSlot(state, index, slot);
      if (!r.ok) {
        audio.play('error');
        return toast(r.reason);
      }
      audio.play('coin');
      toast(`加速完成，得到 ${itemName(r.data.item)}`);
      markDirty();
      saveNow();
    },
  });
}

// ---------- 输入 ----------
let downAt: { x: number; y: number; t: number } | null = null;

// 专注模式下，按钮/发货列表默认隐藏；点击屏幕任意处显示，30s 后自动再隐藏
let focusUiTimer = 0;
function revealFocusUi(): void {
  if (!isFocusing(state, Date.now())) return;
  uiRoot.classList.remove('focus-ui-hidden');
  clearTimeout(focusUiTimer);
  focusUiTimer = window.setTimeout(() => {
    // 仍在专注才重新隐藏，避免刚退出专注又被藏起来
    if (isFocusing(state, Date.now())) uiRoot.classList.add('focus-ui-hidden');
  }, 30_000);
}
// 操作专注控件后，立即把 UI 重新藏起来（沉浸看岛）
function hideFocusUi(): void {
  if (!isFocusing(state, Date.now())) return;
  clearTimeout(focusUiTimer);
  uiRoot.classList.add('focus-ui-hidden');
}
window.addEventListener('pointerdown', revealFocusUi);

canvas.addEventListener('pointerdown', (e) => {
  audioReady = ensureAudio();
  downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
});

canvas.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  const held = performance.now() - downAt.t;
  downAt = null;
  if (moved > 10 || held > 600) return; // 当作拖拽或长按

  const hit = view.pick(e.clientX, e.clientY, world.allPickables);
  if (!hit) return;

  // 居民优先：他们的碰撞体比地块高，射线本来就先命中
  const agentId = findFlag(hit.object, 'agentId');
  if (agentId !== undefined) return talkToAgent(agentId);

  // 专职农民：田里那个戴草帽的，点了他聊农事
  const farmerId = findFlag(hit.object, 'farmerId');
  if (farmerId !== undefined) return talkToFarmer(farmerId);

  // 厂区工人：伐木工、农场工，点了他聊各自的活儿
  const lumberId = findFlag(hit.object, 'lumberId');
  if (lumberId !== undefined) return talkToLumber(lumberId);

  const ranchId = findFlag(hit.object, 'ranchId');
  if (ranchId !== undefined) return talkToRanch(ranchId);

  const plotId = findFlag(hit.object, 'plotId');
  if (plotId !== undefined) {
    const plot = state.plots[plotId];
    const now = Date.now();
    if (!plot.crop) return openPlantPanel(state, plotId, (c) => doPlant(plotId, c));
    if (plot.readyAt <= now) return doHarvest(plotId);
    return toast(`还要 ${Math.ceil((plot.readyAt - now) / 1000)} 秒`);
  }

  const factoryIndex = findFlag(hit.object, 'factoryIndex');
  if (factoryIndex !== undefined) openFactory(factoryIndex);
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || downAt) return;
  const hit = view.pick(e.clientX, e.clientY, world.pickables);
  world.setHover(hit ? (findFlag(hit.object, 'plotId') ?? null) : null);
});

/** 居民自动闲聊的间隔 */
const CHATTER_MS = 10_000;
let nextChatterAt = Date.now() + CHATTER_MS;

/**
 * 没人点的时候，居民自己偶尔冒一句话。
 * 刻意不出声——十秒响一次的点击音效会很烦人。
 */
function autoChatter(now: number): void {
  // 只有贴近小岛（近景）居民才闲聊，拉远看全岛时不打扰
  if (!view.isNearView()) return;
  if (now < nextChatterAt) return;
  nextChatterAt = now + CHATTER_MS;

  const id = world.randomAgentId();
  if (id === null) return; // 岛上还没人
  speech.sayAt(() => world.agentPosition(id), randomLine(), now);
}

/** 点居民：说一句随机日常用语，不消耗任何东西，纯粹是让小岛有点人味 */
function talkToAgent(agentId: number): void {
  // 远景下居民只是小点，不响应点击说话
  if (!view.isNearView()) return;
  audio.play('click');
  // 刚手动聊过，自动闲聊先让让路
  nextChatterAt = Date.now() + CHATTER_MS;
  // 传回调而不是坐标，气泡才能跟着走动的居民跑
  speech.sayAt(() => world.agentPosition(agentId), randomLine(), Date.now());
}

/** 点农民：说一句跟农田有关的台词，同样只在近景才响应 */
function talkToFarmer(farmerId: number): void {
  if (!view.isNearView()) return;
  audio.play('click');
  // 顺手让居民的自动闲聊也让让路
  nextChatterAt = Date.now() + CHATTER_MS;
  speech.sayAt(() => world.farmerPosition(farmerId), randomFarmLine(), Date.now());
}

/** 点伐木工：说一句跟伐木备料有关的台词，同样只在近景才响应 */
function talkToLumber(lumberId: number): void {
  if (!view.isNearView()) return;
  audio.play('click');
  nextChatterAt = Date.now() + CHATTER_MS;
  speech.sayAt(() => world.agentPosition(lumberId), randomLumberLine(), Date.now());
}

/** 点农场工：说一句跟畜牧饲养有关的台词，同样只在近景才响应 */
function talkToRanch(ranchId: number): void {
  if (!view.isNearView()) return;
  audio.play('click');
  nextChatterAt = Date.now() + CHATTER_MS;
  speech.sayAt(() => world.agentPosition(ranchId), randomRanchLine(), Date.now());
}

function findFlag(obj: THREE.Object3D, key: string): number | undefined {
  let o: THREE.Object3D | null = obj;
  while (o) {
    if (o.userData[key] !== undefined) return o.userData[key] as number;
    o = o.parent;
  }
  return undefined;
}

function ensureAudio(): boolean {
  if (audioReady) return true;
  audio.unlock();
  audio.setVolume(state.settings.volume);
  audio.setRadioUrl(state.settings.radioUrl);
  audio.setChannel(state.settings.channel);
  return true;
}

// ---------- 存档与云同步 ----------
function saveNow(): void {
  saveLocal(state);
  void cloudPush(deviceId, state).then((s) => {
    syncStatus = s;
  });
}

async function syncNow(manual: boolean): Promise<void> {
  // 后端没起来时会自动退避，别让定时器一直空转
  if (!manual && isPaused()) {
    syncStatus = 'paused';
    return;
  }
  if (manual) resetPause();
  syncStatus = 'syncing';
  const r = await cloudPull(deviceId);
  if (r.status !== 'ok') {
    syncStatus = r.status;
    if (manual) toast(describeStatus(r.status));
    return;
  }
  if (r.doc && r.doc.savedAt > state.savedAt + 5_000) {
    const take = window.confirm('云端有更新的进度，要切换到云端存档吗？（选「取消」保留本机进度并覆盖云端）');
    if (take) {
      state = r.doc;
      state.deviceId = deviceId;
      saveLocal(state);
      markDirty();
      if (manual) toast('已切换到云端存档');
    }
  }
  syncStatus = await cloudPush(deviceId, state);
  if (manual) toast(describeStatus(syncStatus));
}

setInterval(() => saveLocal(state), 30_000);
// 云同步默认关，只有用户手动成功过一次才自动跑，避免 console 被 500 刷屏
setInterval(() => {
  if (state.settings.cloudSync) void syncNow(false);
}, 120_000);
window.addEventListener('beforeunload', () => saveLocal(state));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveLocal(state);
});
window.addEventListener('resize', () => view.resize());

// Q/E 或左右方向键转视角。右键拖拽太隐蔽，键盘是最容易发现的入口
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
  // 30°：一下就能看出变化，又不会太跳
  const step = Math.PI / 6;
  if (e.key === 'q' || e.key === 'Q' || e.key === 'ArrowLeft') view.rotateBy(-step);
  else if (e.key === 'e' || e.key === 'E' || e.key === 'ArrowRight') view.rotateBy(step);
});

// ---------- 昼夜 ----------
let nightNow = isNight();
world.applyTimeOfDay(nightNow);
setInterval(() => {
  const n = isNight();
  if (n === nightNow) return;
  nightNow = n;
  world.applyTimeOfDay(n);
  view.scene.background = new THREE.Color(n ? 0x2b3a67 : 0xbde0fe);
  const fog = view.scene.fog as THREE.Fog | null;
  if (fog) fog.color.set(n ? 0x2b3a67 : 0xbde0fe);
}, 30_000);

function isNight(): boolean {
  const h = new Date().getHours();
  return h >= 19 || h < 6;
}

// ---------- 主循环 ----------
let last = performance.now();
let feverOn = false;
let focusOn = false;

function frame(t: number): void {
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  const now = Date.now();

  for (const ev of tick(state, now)) {
    if (ev.kind === 'factory' && ev.item) {
      // 专注模式下静默：不弹 toast、不飘字、不出金币音，避免打扰学习。
      // 产出计数走 simulation 里的 state.focus.produced，与这里的解耦，统计不受影响。
      if (!isFocusing(state, now)) {
        audio.play('coin');
        toast(`工厂产出 ${itemName(ev.item)}`);
      }
      markDirty(); // 产出可能点亮图鉴，进而触发成就
    }
    // 专注期间的自动农活刻意静默——弹提示就打扰人学习了
    if (ev.kind === 'autofarm') markDirty();
  }

  const lowSpec = view.isPowerSave;
  if (dirty) {
    world.sync(state, now, lowSpec);
    // 新建筑也要跟上当前昼夜，否则夜间建的房窗户不亮
    world.applyTimeOfDay(isNight());
    const gained = checkAchievements(state);
    if (gained.length > 0) {
      for (const a of gained) {
        toast(`成就达成 · ${a.name}${a.coins > 0 ? ` +${a.coins} 金` : ''}`);
      }
      audio.play('levelup');
      saveNow(); // 成就是一次性事件，立刻落盘，别等 30 秒的自动保存
    }
    dirty = false;
  }
  world.update(state, now, dt, lowSpec);
  view.update(dt);

  const fever = now < state.feverUntil;
  if (fever !== feverOn) {
    feverOn = fever;
    audio.setIntensity(fever ? 1 : 0);
  }

  // 番茄钟：进度条 + 到点结算
  const focusing = isFocusing(state, now);
  if (focusing !== focusOn) {
    focusOn = focusing;
    audio.setDucking(focusing);
    // 进入专注即把镜头切到最佳缩放并缓缓自转（当动态壁纸陪伴）；
    // 退出专注（取消或自然完成）则交还控制权
    if (focusing) view.startShowcase();
    else view.stopShowcase();
    hud.el.classList.toggle('focusing', focusing);
    // 专注模式：默认隐藏按钮栏与发货列表，沉浸看岛；退出则恢复常显
    uiRoot.classList.toggle('focus-ui-hidden', focusing);
    if (!focusing) clearTimeout(focusUiTimer);
  }
  if (focusing) {
    focusBar.style.display = '';
    focusFill.style.width = `${focusProgress(state, now) * 100}%`;
    const remain = Math.max(0, state.focus.until - now);
    const s = Math.ceil(remain / 1000);
    const mm = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    focusLabel.textContent = `专注中 · 剩 ${mm}:${ss} · 点我回到最佳视角`;
  } else {
    focusBar.style.display = 'none';
  }
  const reward = settleFocus(state, now);
  if (reward) {
    audio.play('levelup');
    const parts: string[] = [];
    if (reward.harvested > 0) parts.push(`收了 ${reward.harvested} 块地`);
    if (reward.produced > 0) parts.push(`产出 ${reward.produced} 批货`);
    const work = parts.length > 0 ? `，${parts.join('、')}` : '';
    toast(`专注完成 · ${reward.minutes} 分钟，得 ${reward.gems} 颗果实${work}`);
    markDirty();
    saveNow();
  }

  hud.update(state, now);
  board.update(state, doDeliver);
  bar.update(state, now);
  autoChatter(now);
  speech.update(view.camera, canvas, now);

  view.render();
  requestAnimationFrame(frame);
}

const lowSpecInit = view.isPowerSave;
world.sync(state, Date.now(), lowSpecInit);
world.applyTimeOfDay(isNight());
checkAchievements(state);
dirty = false;
view.setPowerSave(state.settings.powerSave);
view.resize();
requestAnimationFrame(frame);

if (state.stats.harvests === 0 && state.stats.ordersDone === 0) {
  setTimeout(() => toast('点一下田地，种点什么吧'), 700);
}

// 默认不自动同步：只跑 dev 时后端并不存在，请求只会污染 console
if (state.settings.cloudSync) void syncNow(false);
