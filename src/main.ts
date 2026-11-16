import './styles/main.css';
import * as THREE from 'three';
import { AudioManager } from './audio';
import {
  build,
  buildFactory,
  demolish,
  demolishRefund,
  harvest,
  harvestAll,
  plant,
  replantAll,
  rushSlot,
  sell,
  startAllSlots,
  startRecipe,
  unlockSlot,
  upgradeBuilding,
  BUILDING_MAX_LEVEL,
} from './core/actions';
import { checkAchievements } from './core/achievements';
import {
  cloudPull,
  cloudPush,
  describeStatus,
  isPaused,
  lastSyncError,
  resetPause,
  type SyncStatus,
} from './core/cloud';
import * as auth from './core/auth';
import { addItem, itemName, normalizeProgress } from './core/economy';
import { cancelFocus, focusProgress, isFocusing, settleFocus, startFocus } from './core/focus';
import { autoFocusStep } from './core/autoplay';
import { deliver } from './core/orders';
import { deliverWish } from './core/wishes';
import { ISLAND_BONUS } from './core/islandBonus';
import { clearLocal, exportCode, exportSaveFile, getDeviceId, importCode, loadLocal, saveLocal } from './core/save';
import { canPlace } from './core/grid';
import { advance, tick } from './core/simulation';
import { createInitialState } from './core/state';
import { switchIsland, SQUARE_ID } from './core/island';
import { seedSquareTestLayout } from './core/seed';
import type { BuildingType, CropId, FactoryType, GameState, ItemId } from './core/types';
import { RECIPE_BY_ID } from './data/factories';
import { BUILDINGS, BUILDING_FOOTPRINT } from './data/buildings';
import { CROPS } from './data/crops';
import { randomLine, randomFarmLine, randomLumberLine, randomRanchLine } from './data/lines';
import { plotPosition, World } from './render/world';
import { SceneView } from './render/scene';
import type { PerfSnapshot } from './render/scene';
import { setScheme, getSchemeId } from './render/palette';
import { closeModal, el, floatAt, fmtDur, initUI, openModal, toast } from './ui/dom';
import { ActionBar, HUD, OrderBoard, WishBoard } from './ui/hud';
import { Guide } from './ui/guide';
import { playIntro } from './ui/intro';
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

const deviceId = getDeviceId();
let state = loadLocal() ?? createInitialState(deviceId);
state.deviceId = deviceId;

// 先有 state 再建 World，让首屏地形按当前激活岛（云上町/方舟町）正确形状渲染
const world = new World(view.scene, state);
// 把岛屿包围盒交给镜头，进入专注/点击倒计时条时据此算出「岛屿最大显示不遮挡」的最佳缩放
view.setFitBox(world.fitBox());
const audio = new AudioManager();

// 应用存档里保存的色系：world 已在默认（马卡龙）下建好，
// 若存档选了别的色系就整体重建一次；同时让光照/天空色跟上。
const builtScheme = getSchemeId();
setScheme(state.settings.colorScheme);
view.applyScheme();
if (getSchemeId() !== builtScheme) world.rebuild(state, isNight());

/** 当前存档归属：登录后用 accountId，否则用设备 UUID。local-first 不受影响。 */
function syncOwner(): { ownerId: string; token: string | null } {
  if (auth.isLoggedIn()) {
    return { ownerId: auth.accountId() ?? deviceId, token: auth.getToken() };
  }
  return { ownerId: deviceId, token: null };
}

// 启动恢复登录态：后台回源刷新档案，成功后用账号身份立刻同步一次（迁移设备进度）
void auth.restore().then((p) => {
  if (p) {
    state.settings.cloudSync = true;
    saveLocal(state);
    void syncNow(false);
  }
});

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
const wishBoard = new WishBoard();
const guide = new Guide();
// 订单面板挂到顶部栏「会员等级」芯片之后，随顶栏流式排布，不再悬浮遮挡画面
hud.el.appendChild(board.el);
// 心愿面板挂在左侧、与右侧订单对称，避免顶栏被挤成一条长龙
uiRoot.appendChild(wishBoard.el);
// 手机上默认收起订单面板：三张卡会盖住半个岛屿，点标题头随时展开
if (window.innerWidth <= 560) board.el.classList.add('collapsed');

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

/** 拆除模式：开启后点选建筑会弹「拆除确认」，返还一半建造费用 */
let demolishMode = false;

const bar = new ActionBar({
  onHarvestAll: () => {
    const r = harvestAll(state, Date.now());
    if (!r.ok) return toast(r.reason);
    audio.play('harvest');
    floatAtCanvas(`+${r.data.total} 收获`, 'good');
    // 仓库满时多余部分折了金币，得让玩家知道「没白收」
    if (r.data.overflowCoins > 0) {
      floatAtCanvas(`仓库已满 · 折现 +${r.data.overflowCoins} 金币`, 'gold');
    }
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
  onBuild: () => {
    // 进入建造面板前先退出拆除模式，避免两种模式叠加造成误操作
    demolishMode = false;
    openBuildPanel(state, {
      onBuild: doBuild,
      onBuildFactory: doBuildFactory,
      onUpgrade: doUpgrade,
      onSwitchIsland: switchIslandTo,
      onSeedTest: seedSquareTest,
      onDemolish: () => {
        demolishMode = true;
        toast('拆除模式：点选要拆除的建筑（再点「建造」可退出）');
      },
    });
  },
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
        if (r.placed > 0) parts.push(`放下 ${r.placed} 处建造`);
        const work = parts.length > 0 ? `，${parts.join('、')}` : '';
        toast(
          r.minutes > 0 ? `已专注 ${r.minutes} 分钟，得 ${r.gems} 颗果实${work}` : '放弃了这次专注',
        );
        saveNow();
      },
    }),
  onSettings: () => openSettings(),
});

/** 打开设置面板（含账号分区）。登录/注册/登出成功后会再次调用本函数重渲染。 */
function openSettings(): void {
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
    onQuality: (q) => {
      state.settings.quality = q;
      view.setQuality(q);
      // 画质切换时同步移轴与天气：低画质不跑全屏后处理，也不跑天气粒子
      const lowEnd = q === 'low' || state.settings.powerSave;
      view.setTilt(!lowEnd);
      if (lowEnd) view.setWeather('clear');
    },
    onColorScheme: (id) => {
      state.settings.colorScheme = id;
      setScheme(id);
      view.applyScheme();
      world.rebuild(state, isNight());
    },
    onTogglePerf: (on) => {
      state.settings.perfMonitor = on;
      applyPerfVisibility();
      markDirty();
      saveNow();
    },
    onRotate: () => view.rotateBy(Math.PI / 2),
    onExport: () => exportCode(state),
    onExportFile: () => exportSaveFile(state),
    onImport: (code) => {
      const s = importCode(code);
      if (!s) return toast('存档码无法识别');
      s.savedAt = Date.now(); // 标为最新，避免被云端旧档在下次同步时反覆盖
      state = s;
      state.deviceId = deviceId;
      saveLocal(state);
      // 导入视作账号迁移：带 ?import=1 走 loose 校验（放开等级跳跃，仍封顶/禁越界），
      // 直接覆盖云端，不走 pull-first，避免被云端旧档反覆盖。
      const { ownerId, token } = syncOwner();
      void cloudPush(ownerId, state, token, { importMode: true });
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
    onReset: () => {
      clearLocal();
      // 云端若开启会在下次启动时重新拉取；本地直接回到初始小岛
      window.location.reload();
    },
    onLogin: async (username, password) => {
      const r = await auth.login(username, password);
      if (!r.ok) return r.error ?? '登录失败';
      state.accountId = r.profile!.accountId;
      state.settings.cloudSync = true;
      saveLocal(state);
      // 把本机进度迁移/同步到账号（首次账号同步服务端宽松放行等级）
      await syncNow(true);
      openSettings();
      return true;
    },
    onRegister: async (username, password) => {
      const r = await auth.register(username, password);
      if (!r.ok) return r.error ?? '注册失败';
      state.accountId = r.profile!.accountId;
      state.settings.cloudSync = true;
      saveLocal(state);
      await syncNow(true);
      openSettings();
      return true;
    },
    onLogout: () => {
      auth.logout();
      state.accountId = undefined;
      saveLocal(state);
      openSettings();
      return true;
    },
  });
}

uiRoot.append(hud.el, bar.el, focusBar);
const speech = new SpeechBubble(uiRoot);

function floatAtCanvas(text: string, kind: '' | 'gold' | 'good' = ''): void {
  floatAt(window.innerWidth / 2, window.innerHeight * 0.42, text, kind);
}

/**
 * 收获物飞向仓库的动效。
 * 纯 DOM 实现（不占 WebGL 绘制），从地块屏幕坐标抛向顶部的仓库 chip，
 * 让"收下"这件事有物理方向感——放置游戏里这类小反馈比数值更重要。
 */
function flyToStore(fromX: number, fromY: number, label: string): void {
  const chip = document.querySelector('.chip.store') as HTMLElement | null;
  const target = chip?.getBoundingClientRect();
  if (!target) {
    floatAt(fromX, fromY, label, 'good');
    return;
  }
  const el2 = document.createElement('div');
  el2.className = 'fly-item';
  el2.textContent = label;
  el2.style.left = `${fromX}px`;
  el2.style.top = `${fromY}px`;
  uiRoot.appendChild(el2);

  const dx = target.left + target.width / 2 - fromX;
  const dy = target.top + target.height / 2 - fromY;
  el2
    .animate(
      [
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0 },
        {
          transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${dy * 0.3 - 46}px)) scale(1.18)`,
          opacity: 1,
          offset: 0.5,
        },
        {
          transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.35)`,
          opacity: 0,
          offset: 1,
        },
      ],
      { duration: 640, easing: 'cubic-bezier(.34,.06,.26,1)' },
    )
    .addEventListener('finish', () => el2.remove());
}

function flyAtPlot(index: number, label: string): void {
  const p = plotPosition(index).clone();
  p.y += 0.55;
  const s = world.worldToScreen(p, view.camera, canvas);
  flyToStore(s.x, s.y, label);
}

function floatAtPlot(index: number, text: string, kind: '' | 'gold' | 'good' = ''): void {
  const p = plotPosition(index).clone();
  p.y += 0.9;
  const s = world.worldToScreen(p, view.camera, canvas);
  floatAt(s.x, s.y, text, kind);
}

// ---------- 农田信息浮层：点生长中的地块，显示作物名 + 实时剩余成熟时间 ----------
interface PlotTip {
  id: number;
  node: HTMLElement;
  name: HTMLElement;
  time: HTMLElement;
  until: number;
}
let plotTip: PlotTip | null = null;

function showPlotTip(plotId: number): void {
  const plot = state.plots[plotId];
  if (!plot || !plot.crop) return;
  if (!plotTip) {
    const node = el('div', 'plot-tip');
    const name = el('div', 'plot-tip-name');
    const time = el('div', 'plot-tip-time');
    node.appendChild(name);
    node.appendChild(time);
    uiRoot.appendChild(node);
    plotTip = { id: plotId, node, name, time, until: 0 };
  }
  plotTip.node.classList.add('show');
  plotTip.id = plotId;
  plotTip.name.textContent = CROPS[plot.crop].name;
  plotTip.until = Date.now() + 6000;
  updatePlotTip(Date.now());
}

function hidePlotTip(): void {
  if (plotTip) {
    plotTip.node.classList.remove('show');
    plotTip.node.remove();
    plotTip = null;
  }
}

function updatePlotTip(now: number): void {
  if (!plotTip) return;
  if (now > plotTip.until) {
    hidePlotTip();
    return;
  }
  const plot = state.plots[plotTip.id];
  // 地块被清空/收获 → 关掉
  if (!plot || !plot.crop) {
    hidePlotTip();
    return;
  }
  const remain = Math.max(0, plot.readyAt - now);
  plotTip.time.textContent = remain > 0 ? `预计 ${fmtDur(remain)} 后成熟` : '已成熟，点击收获';
  // 跟随镜头：把地块世界坐标投到屏幕（按当前岛形状映射，方岛才对得上）
  const p = world.plotWorldPos(plotTip.id).clone();
  p.y += 1.0;
  const s = world.worldToScreen(p, view.camera, canvas);
  plotTip.node.style.left = `${s.x}px`;
  plotTip.node.style.top = `${s.y}px`;
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
  if (r.data.count > 0) flyAtPlot(plotId, `+${r.data.count}`);
  if (r.data.overflow > 0) floatAtPlot(plotId, `仓满折现`, 'gold');
  markDirty();
  saveNow();
}

/**
 * 新手引导：三步（种 → 收 → 交）。
 * 只在有存档但未完成时出现；打开弹窗时自动让位，不打断玩家。
 */
function updateGuide(): void {
  if (state.guideDone) {
    guide.hide();
    return;
  }
  const modalOpen = !!document.querySelector('.scrim');
  const focusing = isFocusing(state, Date.now());
  const planted = state.plots.some((p) => p.crop);
  const harvested = state.stats.harvests > 0;
  const delivered = state.stats.ordersDone > 0;

  if (planted && harvested && delivered) {
    state.guideDone = true;
    guide.hide();
    guide.highlight(board.el, false);
    toast('你已经会种地啦，小镇交给你了！');
    saveNow();
    return;
  }
  if (modalOpen || focusing) {
    guide.hide();
    guide.highlight(board.el, false);
    return;
  }

  const now2 = Date.now();
  const ripeIdx = state.plots.findIndex((p) => p.crop && p.readyAt <= now2);
  const emptyIdx = state.plots.findIndex((p) => !p.crop);
  const focusIdx = ripeIdx >= 0 ? ripeIdx : emptyIdx >= 0 ? emptyIdx : 0;
  const shape = state.islands.find((i) => i.id === state.activeIsland)?.shape ?? 'round';
  const wp = plotPosition(focusIdx, shape);
  wp.y += 0.2;
  const sp = world.worldToScreen(wp, view.camera, canvas);

  if (!harvested) {
    guide.show(planted ? '等它长大…成熟后会发光，点它收获' : '先点一块空地，种下你的第一颗种子');
    guide.pointAt(sp.x, sp.y);
    guide.highlight(board.el, false);
  } else if (!delivered) {
    guide.show('把货物交给村民的订单，点右侧的「发货」');
    guide.pointAt(sp.x, sp.y);
    guide.highlight(board.el, true);
  }
}

function doWish(id: string): void {
  const r = deliverWish(state, id, Date.now());
  if (!r) {
    audio.play('error');
    return toast('物品还不够');
  }
  audio.play('deliver');
  floatAtCanvas(`+${r.coins} 金币 · +${r.gems} 宝石`, 'gold');
  toast(`${r.villager} 很开心！`);
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
  // 方岛：进入点击落格的放置模式（圆岛仍旧地自动打包）
  if (world.islandShape === 'square') {
    const fp = BUILDING_FOOTPRINT[type];
    beginPlacement(type, false, fp.w, fp.h);
    return;
  }
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

function switchIslandTo(id: string): void {
  // 切换岛屿前，若在放置模式则静默退出（不再弹回建造面板）
  if (placing) endPlacement(false);
  const changed = switchIsland(state, id);
  if (!changed) return;
  // 方岛首次进入且为空，随机铺一层测试内容，方便看运行效果
  if (state.activeIsland === SQUARE_ID && state.buildings.length === 0 && state.factories.length === 0) {
    seedSquareTestLayout(state);
  }
  // 整岛重建：圆岛/方岛地形与建筑布局都不同
  world.rebuild(state, isNight());
  const meta = state.islands.find((x) => x.id === id);
  const bonusNote = ISLAND_BONUS[state.activeIsland]?.note;
  toast(`已切换到${meta?.name ?? '岛屿'}${bonusNote ? ` · ${bonusNote}` : ''}`);
  markDirty();
  saveNow();
}

/** 测试便捷：清空方岛现有布局并随机重铺一层内容（建筑/道路/工厂/作物）。 */
function seedSquareTest(): void {
  if (placing) endPlacement(false);
  state.buildings = [];
  state.factories = [];
  for (const p of state.plots) {
    p.crop = null;
    p.plantedAt = 0;
    p.readyAt = 0;
  }
  seedSquareTestLayout(state, Date.now());
  world.rebuild(state, isNight());
  toast('方舟町已随机重铺');
  markDirty();
  saveNow();
}

function doUpgrade(type: BuildingType): void {
  // 选当前等级最低的那一栋来升，让整体更均衡
  const candidates = state.buildings.filter((b) => b.type === type && (b.level ?? 1) < BUILDING_MAX_LEVEL);
  if (candidates.length === 0) return toast('没有可升级的建筑');
  const target = candidates.reduce((a, b) => ((b.level ?? 1) < (a.level ?? 1) ? b : a));
  const r = upgradeBuilding(state, target.id, Date.now());
  if (!r.ok) {
    audio.play('error');
    return toast(r.reason);
  }
  audio.play('coin');
  const what = r.data.expanded ? '扩建了占地' : `升到 ${r.data.level} 级`;
  toast(`${BUILDINGS[type].name}${what}`);
  // 升级后房子外形变了，重建对应模型
  world.refreshBuilding(target.id);
  markDirty();
  saveNow();
}

function doBuildFactory(type: FactoryType): void {
  // 方岛：工厂是 2×2，也走点击落格
  if (world.islandShape === 'square') {
    beginPlacement(type, true, 2, 2);
    return;
  }
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

// ---------- 方岛放置模式 ----------
/**
 * 方岛建造走「点击落格」：点开建造面板选一种建筑/工厂后进入本模式，
 * 半透明预览体跟随光标，绿=可放/红=不可放，点格子即落定（道路可连点铺一排）。
 * 圆岛没有网格，仍用旧的自动打包。
 */
type Placing = { type: BuildingType | FactoryType; isFactory: boolean; w: number; h: number };
let placing: Placing | null = null;

const placeBanner = el('div', 'place-banner');
placeBanner.style.display = 'none';
placeBanner.innerHTML = '<span>放置中 · 点格子放下</span><b>Esc / 点此取消</b>';
placeBanner.addEventListener('click', () => endPlacement(true));
uiRoot.append(placeBanner);

function beginPlacement(type: BuildingType | FactoryType, isFactory: boolean, w: number, h: number): void {
  placing = { type, isFactory, w, h };
  world.beginPlacement(type, isFactory, w, h);
  closeModal();
  placeBanner.style.display = '';
}

/** 退出放置模式。reopen=true 时重新打开建造面板，方便再选一种。 */
function endPlacement(reopen: boolean): void {
  if (!placing) return;
  placing = null;
  world.clearGhost();
  placeBanner.style.display = 'none';
  if (reopen) {
    openBuildPanel(state, {
      onBuild: doBuild,
      onBuildFactory: doBuildFactory,
      onUpgrade: doUpgrade,
      onSwitchIsland: switchIslandTo,
      onSeedTest: seedSquareTest,
      onDemolish: () => {
        demolishMode = true;
        toast('拆除模式：点选要拆除的建筑（再点「建造」可退出）');
      },
    });
  }
}

/** 把预览体对齐到点击的格子（2×2 以光标格为中心锚定），并校验能否放下 */
function ghostAt(cell: { gx: number; gz: number }): boolean {
  if (!placing) return false;
  const { w, h } = placing;
  const gx = cell.gx - Math.floor((w - 1) / 2);
  const gz = cell.gz - Math.floor((h - 1) / 2);
  const ok = canPlace(state, gx, gz, w, h);
  world.moveGhost(gx, gz, ok);
  return ok;
}

function commitPlacement(cell: { gx: number; gz: number }): void {
  if (!placing) return;
  const { w, h } = placing;
  const gx = cell.gx - Math.floor((w - 1) / 2);
  const gz = cell.gz - Math.floor((h - 1) / 2);
  if (!canPlace(state, gx, gz, w, h)) {
    audio.play('error');
    return toast('这里放不下');
  }
  const r = placing.isFactory
    ? buildFactory(state, placing.type as FactoryType, Date.now(), { gx, gz })
    : build(state, placing.type as BuildingType, Date.now(), { gx, gz, rot: 0 });
  if (!r.ok) {
    audio.play('error');
    return toast(r.reason);
  }
  audio.play('coin');
  const name =
    placing.type === 'road' ? '道路' : placing.isFactory ? '工厂' : placing.type === 'house' ? '小屋' : '建筑';
  toast(`${name}已放置`);
  markDirty();
  saveNow();
  // 保持放置模式，方便连铺（尤其道路）；刷新一下落点合法性
  world.moveGhost(gx, gz, true);
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

  // 放置模式：射线只打网格落格，点中即落定
  if (placing) {
    const gHit = view.pick(e.clientX, e.clientY, world.gridCells);
    const cell = gHit ? (gHit.object.userData as { cell?: { gx: number; gz: number } }).cell : undefined;
    if (cell) commitPlacement(cell);
    return;
  }

  const hit = view.pick(e.clientX, e.clientY, world.allPickables);
  // 任何点击先收起农田浮层（下方若点到生长中的地块会重新弹出）
  hidePlotTip();
  if (!hit) return;

  // 拆除模式：点选建筑弹「拆除确认」（返还一半费用）；点非建筑则退出模式
  if (demolishMode) {
    const bId = findFlag(hit.object, 'buildingId');
    if (bId !== undefined && state.buildings[bId]) {
      confirmDemolish(bId);
    } else {
      demolishMode = false;
    }
    return;
  }

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
    return showPlotTip(plotId); // 生长中：弹出作物名 + 剩余成熟时间
  }

  const factoryIndex = findFlag(hit.object, 'factoryIndex');
  if (factoryIndex !== undefined) openFactory(factoryIndex);
});

/** 拆除确认弹窗：展示建筑名与返还金币，确认后执行 demolish 并反馈 */
function confirmDemolish(index: number): void {
  const b = state.buildings[index];
  if (!b) {
    demolishMode = false;
    return;
  }
  const def = BUILDINGS[b.type];
  const refund = demolishRefund(state, b.id);
  const body = el('div');
  body.appendChild(el('p', 'hint', `拆除「${def.name}」将返还 ${refund} 金币（原价的 50%）。`));
  const row = el('div', 'row');
  const ok = el('button', 'btn danger', `拆除 · 返还 ${refund} 金`);
  ok.addEventListener('click', () => {
    const r = demolish(state, b.id);
    if (r.ok) {
      audio.play('coin');
      toast(`已拆除 ${r.data.name}，返还 ${r.data.refund} 金`);
      markDirty();
      saveNow();
    }
    demolishMode = false;
    closeModal();
  });
  const cancel = el('button', 'btn ghost', '取消');
  cancel.addEventListener('click', () => closeModal());
  row.append(ok, cancel);
  body.appendChild(row);
  openModal('拆除确认', `确定拆除 ${def.name}？`, body);
}

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || downAt) return;
  // 放置模式：预览体跟随光标，实时显示可放/不可放
  if (placing) {
    const gHit = view.pick(e.clientX, e.clientY, world.gridCells);
    const cell = gHit ? (gHit.object.userData as { cell?: { gx: number; gz: number } }).cell : undefined;
    if (cell) ghostAt(cell);
    return;
  }
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
/** 同步状态文案；「未连接」时附带真实错误原因，便于定位是缓存/拦截还是网络。 */
function syncMsg(s: SyncStatus): string {
  const base = describeStatus(s);
  if (s === 'unavailable' && lastSyncError()) return `${base}（${lastSyncError()}）`;
  return base;
}

function saveNow(): void {
  normalizeProgress(state); // 推送前规整，避免越界经验被云端以「等级异常」拒绝
  saveLocal(state);
  const { ownerId, token } = syncOwner();
  void cloudPush(ownerId, state, token).then((s) => {
    syncStatus = s;
  });
}

/** 本地是否还是一份「刚开局、没玩过」的空白档（不应覆盖云端真实进度）。 */
function isFreshLocal(s: GameState): boolean {
  const freshPlots = s.plots.every((p) => p.crop === null && p.plantedAt === 0);
  return (
    s.level === 1 &&
    s.exp === 0 &&
    s.coins === 300 &&
    s.gems === 0 &&
    s.stats.playSeconds === 0 &&
    s.factories.length === 0 &&
    freshPlots
  );
}

async function syncNow(manual: boolean): Promise<void> {
  // 后端没起来时会自动退避，别让定时器一直空转
  if (!manual && isPaused()) {
    syncStatus = 'paused';
    return;
  }
  if (manual) resetPause();
  syncStatus = 'syncing';
  try {
    const { ownerId, token } = syncOwner();
    const r = await cloudPull(ownerId, token);
    if (r.status !== 'ok') {
      syncStatus = r.status;
      if (manual) toast(syncMsg(r.status));
      return;
    }
    if (r.doc) {
      // 本地还是「刚开局、没玩过」的空白档，或云端进度更新时，采用云端存档。
      // 注意：这里不能用 window.confirm —— 它会阻塞主线程，在移动端 WebView 中
      // 静默挂起，导致「同步中」永久卡死。云同步语义本就以云端为准。
      const fresh = isFreshLocal(state);
      // 与「上次和云端同步一致的版本」比较，而非本地 savedAt（本地自动存档会刷新 savedAt，
      // 若用它判断，本地永远比云端新 → 从不下载、反把云端覆盖掉）。
      const cloudNewer = r.doc.savedAt > (state.syncedAt ?? 0) + 5_000;
      if (fresh || cloudNewer) {
        state = r.doc;
        state.deviceId = deviceId;
        if (auth.isLoggedIn()) state.accountId = auth.accountId() ?? state.accountId;
        state.syncedAt = r.doc.savedAt; // 标记已与云端此版本同步
        saveLocal(state);
        markDirty();
        if (manual) toast(fresh ? '已从云端同步进度' : '已采用云端更新的进度');
      }
    }
    normalizeProgress(state); // 推送前规整，避免越界经验被云端拒绝
    syncStatus = await cloudPush(ownerId, state, token);
    // 推送成功后，本地版本即为云端最新版本
    state.syncedAt = state.savedAt;
    // 会员等级刷新是「锦上添花」，绝不能阻塞同步主流程：
    // /api/auth/me 是 GET，在部分会缓存 GET 的 CDN 上可能挂起，
    // 一旦 await 卡在这里，syncNow 永远停不下来 →「同步中」永久卡死。
    // 改为 fire-and-forget，等级徽章会在下次登录/恢复时自然更新。
    if (auth.isLoggedIn()) void auth.refresh();
    if (manual) toast(syncMsg(syncStatus));
  } catch {
    // 任何意外都不该让状态永久停在「同步中」而卡死 UI
    syncStatus = 'error';
  }
}

setInterval(() => saveLocal(state), 30_000);
// 云同步默认关，只有用户手动成功过一次才自动跑，避免 console 被 500 刷屏
setInterval(() => {
  if (state.settings.cloudSync) void syncNow(false);
}, 60_000);
window.addEventListener('beforeunload', () => saveLocal(state));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveLocal(state);
});
window.addEventListener('resize', () => view.resize());

// 测量移动端浏览器工具栏（地址栏/底部导航）遮挡高度，写入 --toolbar-b。
// actionbar / toasts / perf 据此上移，避免被工具栏盖住。100dvh 在某些浏览器
// 仍会被工具栏吃掉，这里用 VisualViewport 实测，更稳。
function installToolbarInset(): void {
  const apply = () => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!vv) {
      root.style.setProperty('--toolbar-b', '0px');
      return;
    }
    // 底部被浏览器 UI 吃掉的高度 = 布局视口 - (视觉视口顶偏移 + 视觉视口高)
    const inset = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
    root.style.setProperty('--toolbar-b', `${Math.round(inset)}px`);
  };
  apply();
  window.visualViewport?.addEventListener('resize', apply);
  window.visualViewport?.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', apply);
}
installToolbarInset();

// Q/E 或左右方向键转视角。右键拖拽太隐蔽，键盘是最容易发现的入口
window.addEventListener('keydown', (e) => {
  // 放置模式优先吃 Esc，无论焦点在哪
  if (e.key === 'Escape' && placing) {
    endPlacement(true);
    return;
  }
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

/** 把当前时刻的天空/光线/灯光一起刷新（每分钟一次，跨时段才有可见变化） */
function syncTimeOfDay(): void {
  const d = new Date();
  // ?hour=18.6 可预览任意时段的光色（调试/截图用，不影响存档）
  // 注意：没有该参数时必须当"没传"，不能 Number(null)——那是 0，会被当成午夜。
  const rawHour = new URLSearchParams(location.search).get('hour');
  const forced = rawHour === null ? NaN : Number(rawHour);
  const hour = Number.isFinite(forced) && forced >= 0 && forced <= 24
    ? forced
    : d.getHours() + d.getMinutes() / 60;
  view.applyHour(hour);
  const n = hour >= 19 || hour < 6;
  if (n !== nightNow) {
    nightNow = n;
    world.applyTimeOfDay(n);
    audio.setDayNight(!n);
    // 换班提示：让玩家知道夜里换了节奏，而不是单纯变暗
    toast(n ? '入夜了 · 作物生长 +15%，居民收入 +20%' : '天亮了 · 居民出门上工');
  }
}
syncTimeOfDay();
setInterval(syncTimeOfDay, 60_000);

// ---------- 天气 ----------
// 自动轮换：晴天为主，偶尔下雨/下雪/落樱。玩家不用管，它自己变——
// 这是"世界活着"的廉价来源，也让长时间挂机不至于一直同一张图。
type WeatherKind = 'clear' | 'rain' | 'snow' | 'sakura';
const WEATHER_NAMES: Record<WeatherKind, string> = {
  clear: '放晴了',
  rain: '下起了小雨',
  snow: '飘起了雪',
  sakura: '樱花瓣在飘',
};
function pickWeather(): WeatherKind {
  const r = Math.random();
  if (r < 0.52) return 'clear';
  if (r < 0.72) return 'sakura';
  if (r < 0.89) return 'rain';
  return 'snow';
}
let weatherNow: WeatherKind = 'clear';
function applyWeather(kind: WeatherKind, announce: boolean): void {
  weatherNow = kind;
  view.setWeather(kind);
  audio.setRain(kind === 'rain' ? 1 : 0);
  if (announce) toast(WEATHER_NAMES[kind]);
}
setInterval(() => {
  // 低画质/省电模式下不跑天气粒子，省掉每帧几百个点的更新
  if (state.settings.quality === 'low' || state.settings.powerSave) return;
  const next = pickWeather();
  if (next === weatherNow) return;
  applyWeather(next, true);
}, 4 * 60_000);

// ?panel=codex|ach|build 直接打开对应面板（调试/截图用）
{
  const panel = new URLSearchParams(location.search).get('panel');
  if (panel) {
    setTimeout(() => {
      if (panel === 'codex') openCodexPanel(state);
      else if (panel === 'ach') openAchievementsPanel(state);
      else if (panel === 'build') bar.el.querySelector<HTMLButtonElement>('.btn.primary, .btn')?.click();
    }, 700);
  }
}

// ?weather=rain|snow|sakura|clear 可指定天气（调试/预览用，不影响存档）
{
  const raw = new URLSearchParams(location.search).get('weather');
  if (raw === 'rain' || raw === 'snow' || raw === 'sakura' || raw === 'clear') {
    applyWeather(raw, false);
  }
}

function isNight(): boolean {
  const h = new Date().getHours();
  return h >= 19 || h < 6;
}

// ---------- 主循环 ----------
let last = performance.now();
let feverOn = false;
let focusOn = false;
/** 最近一次玩家操作时刻；超过 5 分钟无操作则自动进入 25 分钟专注 */
let lastActivity = Date.now();
function bumpActivity(): void {
  lastActivity = Date.now();
}
window.addEventListener('pointerdown', bumpActivity);
window.addEventListener('keydown', bumpActivity);
window.addEventListener('wheel', bumpActivity, { passive: true });
/** 自动经营步进的节流点：专注中每约 1 秒跑一次，别每秒 60 次空转 */
let autoStepAt = 0;

// ---------- 性能监控浮层 ----------
// 实时采样 FPS / 帧时间 / DrawCall / 三角面 / GPU 资源 / JS 堆；
// 掉帧或卡顿尖刺时整块高亮告警，并节流向 console.warn，方便「持续关注性能异常」。
const PERF_WARN_FPS = 45;
const PERF_WARN_MS = 50;
let perfEl: HTMLDivElement | null = null;
const perfFps = el('span', 'perf-val');
const perfMs = el('span', 'perf-val');
const perfCalls = el('span', 'perf-val');
const perfTri = el('span', 'perf-val');
const perfGeo = el('span', 'perf-val');
const perfHeap = el('span', 'perf-val');
let perfFrames = 0;
let perfAccumMs = 0;
let perfLastWarnLog = 0;

function buildPerfEl(): HTMLDivElement {
  const root = el('div', 'perf') as HTMLDivElement;
  const mk = (k: string, v: HTMLElement) => {
    const row = el('div', 'perf-row');
    row.appendChild(el('span', 'perf-key', k));
    row.appendChild(v);
    return row;
  };
  root.appendChild(mk('FPS', perfFps));
  root.appendChild(mk('帧', perfMs));
  root.appendChild(mk('Draw', perfCalls));
  root.appendChild(mk('三角', perfTri));
  root.appendChild(mk('几何/纹', perfGeo));
  root.appendChild(mk('JS堆', perfHeap));
  root.style.display = state.settings.perfMonitor ? '' : 'none';
  uiRoot.appendChild(root);
  return root;
}

function perfSample(frameMs: number, snap: PerfSnapshot): void {
  if (!perfEl) perfEl = buildPerfEl();
  perfFrames += 1;
  perfAccumMs += frameMs;
  if (perfAccumMs < 500) return; // 每半秒汇总一次，数字稳定可读
  const avgFps = perfFrames / (perfAccumMs / 1000);
  const avgMs = perfAccumMs / perfFrames;
  const warn = avgFps < PERF_WARN_FPS || frameMs > PERF_WARN_MS;
  perfFps.textContent = avgFps.toFixed(0);
  perfMs.textContent = `${avgMs.toFixed(1)}ms`;
  perfCalls.textContent = String(snap.calls);
  perfTri.textContent = snap.triangles >= 1000 ? `${(snap.triangles / 1000).toFixed(1)}k` : String(snap.triangles);
  perfGeo.textContent = `${snap.geometries}/${snap.textures}`;
  perfHeap.textContent = snap.jsHeap > 0 ? `${(snap.jsHeap / 1048576).toFixed(0)}MB` : 'n/a';
  perfEl.classList.toggle('warn', warn);
  if (warn) {
    const now = Date.now();
    if (now - perfLastWarnLog > 3000) {
      perfLastWarnLog = now;
      console.warn(`[perf] 性能异常 avgFPS=${avgFps.toFixed(1)} frameMs=${frameMs.toFixed(1)} calls=${snap.calls} tris=${snap.triangles}`);
    }
  }
  perfFrames = 0;
  perfAccumMs = 0;
}

/** 按设置开关切换浮层显隐（懒创建：开启时才建 DOM） */
function applyPerfVisibility(): void {
  if (!perfEl) {
    if (state.settings.perfMonitor) perfEl = buildPerfEl();
    return;
  }
  perfEl.style.display = state.settings.perfMonitor ? '' : 'none';
}

function frame(t: number): void {
  const rawInterval = Math.min(1000, t - last); // 真实帧间隔(ms)，不 clamp，供性能监控
  // dt 必须有下限：rAF 的时间戳偶尔会小于上一帧记录值（首帧、标签页恢复），
  // 负 dt 会让所有基于 dt 的动画倒放——落成弹跳的 ease 曲线在负值域会算出巨大的缩放。
  const dt = Math.max(0, Math.min(0.05, rawInterval / 1000));
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

  // 5 分钟无操作 → 自动进入 25 分钟专注（用户要求：自动只进 25 分钟这一档）
  if (!isFocusing(state, now) && now - lastActivity > 5 * 60_000) {
    demolishMode = false;
    startFocus(state, 25, now);
    toast('专注模式已自动开启（25 分钟）');
  }
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
  audio.updateAmbient(dt);
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
    else {
      view.stopShowcase();
      // 退出专注后重新计 5 分钟无操作，避免一退出就又被自动拉进专注
      lastActivity = Date.now();
    }
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

    // 专注自动经营：满足发货要求就自动发货、自动建造/升级、仓库满分批卖
    if (now - autoStepAt > 1000) {
      autoStepAt = now;
      autoFocusStep(state, now);
      markDirty();
    }
  } else {
    focusBar.style.display = 'none';
  }
  const reward = settleFocus(state, now);
  if (reward) {
    audio.play('levelup');
    const parts: string[] = [];
    if (reward.harvested > 0) parts.push(`收了 ${reward.harvested} 块地`);
    if (reward.produced > 0) parts.push(`产出 ${reward.produced} 批货`);
    if (reward.placed > 0) parts.push(`放下 ${reward.placed} 处建造`);
    const work = parts.length > 0 ? `，${parts.join('、')}` : '';
    toast(`专注完成 · ${reward.minutes} 分钟，得 ${reward.gems} 颗果实${work}`);
    markDirty();
    saveNow();
  }

  updateGuide();
  hud.update(state, now, auth.memberTier());
  board.update(state, doDeliver);
  wishBoard.update(state, doWish);
  bar.update(state, now);
  autoChatter(now);
  speech.update(view.camera, canvas, now);
  updatePlotTip(now); // 农田浮层：跟随镜头 + 实时倒计时

  view.render();
  if (state.settings.perfMonitor) perfSample(rawInterval, view.perf);
  requestAnimationFrame(frame);
}

const lowSpecInit = view.isPowerSave;
// 首屏若停在方岛且为空，先随机铺测试内容再同步
if (state.activeIsland === SQUARE_ID && state.buildings.length === 0 && state.factories.length === 0) {
  seedSquareTestLayout(state);
}
world.sync(state, Date.now(), lowSpecInit);
world.applyTimeOfDay(isNight());
checkAchievements(state);
dirty = false;
view.setQuality(state.settings.quality);
// 低画质或省电模式关掉移轴后处理，省一次全屏 pass
const lowEndInit = state.settings.quality === 'low' || state.settings.powerSave;
view.setTilt(!lowEndInit);
if (lowEndInit) view.setWeather('clear');
view.setPowerSave(state.settings.powerSave);
// 注意：这里不要再手动 view.setSky(isNight())——时段光色已由 syncTimeOfDay 统一负责，
// 用真实时钟覆盖会把 ?hour= 预览和凌晨启动的配色一起打回夜间。
// 老玩家（已经交过订单）不再走新手引导，避免打开就被塞一张提示卡
if (state.stats.ordersDone > 0) state.guideDone = true;

view.resize();

// 首次进入：镜头推近 + 标题卡（?intro=1 可重新播放）
{
  const forced = new URLSearchParams(location.search).get('intro') === '1';
  const seen = localStorage.getItem('cloudlet.intro');
  if (forced || !seen) {
    view.playIntro();
    playIntro(() => localStorage.setItem('cloudlet.intro', '1'));
  }
}

requestAnimationFrame(frame);

if (state.stats.harvests === 0 && state.stats.ordersDone === 0) {
  setTimeout(() => toast('点一下田地，种点什么吧'), 700);
}

// 默认不自动同步：只跑 dev 时后端并不存在，请求只会污染 console
if (state.settings.cloudSync) void syncNow(false);
