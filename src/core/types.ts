export type CropId = 'wheat' | 'corn' | 'carrot' | 'strawberry' | 'pumpkin' | 'cotton';
export type ProductId = 'bread' | 'butter' | 'jam' | 'wood' | 'milk';
export type ItemId = CropId | ProductId;
export type FactoryType = 'bakery' | 'dairy' | 'juice' | 'lumber' | 'ranch';
export type BuildingType =
  | 'house'
  | 'cafe'
  | 'park'
  | 'fountain'
  | 'road'
  | 'post'
  | 'garden'
  | 'flower'
  | 'school'
  | 'hall'
  | 'bench'
  | 'lamp'
  | 'planter'
  | 'statue';
/** 岛屿形状：圆岛（极坐标布局）与方岛（网格布局）。以后可扩展更多空岛形态 */
export type IslandShape = 'round' | 'square';
export type RecipeId = `${FactoryType}:${string}`;

/** 一座岛的元信息（用于切换列表与渲染时判断形状） */
export interface IslandMeta {
  id: string;
  shape: IslandShape;
  name: string;
  /** 解锁所需繁荣度（缺省 0 = 一开始就有） */
  reqProsperity?: number;
  /** 一句话说明这座岛有什么 */
  desc?: string;
}

/** 单座岛自带的玩法数据。顶层 GameState 的 buildings/plots/factories 始终指向「当前激活岛」，
 *  其余岛的数据暂存在 islandData 仓库里，切换时整体交换。 */
export interface IslandData {
  buildings: Building[];
  plots: Plot[];
  factories: FactoryState[];
}

export interface Plot {
  id: number;
  crop: CropId | null;
  /** 播种时刻（ms）。用于计算生长阶段动画。 */
  plantedAt: number;
  /** 成熟时刻（ms）。绝对时间戳，天然支持离线结算。 */
  readyAt: number;
}

export interface FactorySlot {
  recipe: string | null;
  /** 产出时刻（ms）。null recipe 表示空闲。 */
  readyAt: number;
}

export interface FactoryState {
  type: FactoryType;
  slots: FactorySlot[];
  /** 方岛网格放置：锚点格(gx,gz)。生产型建筑占地 2×2。圆岛忽略，用 factoryPos 按序排。 */
  gx?: number;
  gz?: number;
}

export interface Building {
  id: string;
  type: BuildingType;
  /** 外观随机种子。存档只存种子，不存模型。 */
  seed: number;
  /** 等级 1..BUILDING_MAX_LEVEL。升级已有房屋比新建更省空间，人口/繁荣随等级放大。对住宅也代表楼层数。 */
  level: number;
  /** 方岛网格放置：锚点格(gx,gz)、占地(w×h 格，默认 1×1)、朝向(0/1/2/3 = 0/90/180/270°)。
   *  圆岛忽略这些字段，改用极坐标按序排布。新建建筑若在方岛则必填 gx/gz。 */
  gx?: number;
  gz?: number;
  w?: number;
  h?: number;
  rot?: 0 | 1 | 2 | 3;
  /** 建造时实际支付的金币（含 costGrowth 加成）。拆除时按它的一半返还；旧档无此字段则按基础价估算。 */
  cost?: number;
}

export interface OrderLine {
  id: ItemId;
  count: number;
}

/**
 * 居民心愿：比订单更轻、更私人——一个人想要某件东西，
 * 满足后给金币 + 宝石。宝石原本只能靠番茄钟获得，心愿让它成为"玩出来的货币"。
 */
export interface Wish {
  id: string;
  villager: string;
  item: ItemId;
  count: number;
  coins: number;
  gems: number;
  createdAt: number;
}

export interface Order {
  id: string;
  lines: OrderLine[];
  coins: number;
  exp: number;
  createdAt: number;
  /** 委托人：有名字的订单比"系统派单"更像一个小镇在跟你讲话 */
  villager?: string;
}

export type AudioChannel =
  | 'citypop'
  | 'lofi'
  | 'ambient'
  | 'guitar'
  | 'country'
  | 'jazz'
  | 'shuffle'
  | 'radio'
  | 'off';

export interface Settings {
  channel: AudioChannel;
  radioUrl: string;
  volume: number;
  powerSave: boolean;
  /** 画质档位：low=省电关阴影 / standard=默认 / high=2048 阴影（桌面强机） */
  quality: 'low' | 'standard' | 'high';
  /** 色系：马卡龙/奶油水彩/果冻糖果/晨雾清新，对应 palette.ts 的 SCHEMES id */
  colorScheme: string;
  /**
   * 云同步开关，默认关闭。
   * 只跑 npm run dev 时后端并不存在，自动同步只会让 console 被 500 刷屏。
   * 用户在设置里手动同步成功一次后自动开启。
   */
  cloudSync: boolean;
  /** 性能监控浮层：实时 FPS/帧时间/DrawCall/三角面/内存，掉帧时高亮告警。默认开启，便于持续关注性能异常。 */
  perfMonitor: boolean;
}

export interface Stats {
  harvests: number;
  ordersDone: number;
  playSeconds: number;
  bestCombo: number;
  focusSessions: number;
  focusMinutes: number;
  /** 累计满足的心愿数（老档可能没有，读取时按 0 处理） */
  wishesDone?: number;
}

/** 番茄钟。专注期间小镇产能提升，把「陪你学习」变成游戏机制。 */
export interface FocusState {
  /** 结束时刻（ms），0 表示未在专注 */
  until: number;
  startedAt: number;
  totalMs: number;
  /** 本次专注里自动运转的战果，结束时一并汇报 */
  harvested: number;
  planted: number;
  produced: number;
  /** 本次专注里自动放下/升级的建造处数 */
  placed: number;
}

/** 收集图鉴。记录见过的东西，是长线时长的主要抓手。 */
export interface Codex {
  crops: CropId[];
  products: ProductId[];
  buildings: BuildingType[];
  factories: FactoryType[];
}

export interface GameState {
  version: number;
  deviceId: string;
  /** 绑定的账号 id（登录后写入），未登录为空。仅作归属标记，等级/会员以服务端为准。 */
  accountId?: string;
  /** 已解锁的岛屿列表。每座岛是独立空间，各有自己的建筑/农田/工厂。 */
  islands: IslandMeta[];
  /** 当前正在查看的岛屿 id。顶层 buildings/plots/factories 始终等于该岛的数据。 */
  activeIsland: string;
  /** 非激活岛屿的数据仓库：id → { buildings, plots, factories }。切换时与顶层字段交换。 */
  islandData: Record<string, IslandData>;
  /** 最后保存时刻（ms）。回来时用它算离线时长。 */
  savedAt: number;
  /** 上次与云端同步一致的存档版本时间戳（ms）。同步的「是否下载云端」判断以它为准，
   *  不受本地自动存档刷新 savedAt 的影响，避免「本地永远比云端新→从不下载、反覆盖云端」。 */
  syncedAt?: number;
  /** 在线被动收益的上次结算时刻（ms）。放置游戏「看着它转也有进账」靠它按帧累加。 */
  lastYieldAt?: number;
  /** 被动收益的小数进位，避免每帧取整把零头丢光。 */
  yieldCarry?: number;
  level: number;
  exp: number;
  coins: number;
  gems: number;
  plots: Plot[];
  factories: FactoryState[];
  buildings: Building[];
  inventory: Partial<Record<ItemId, number>>;
  orders: Order[];
  /** 居民心愿（最多 WISH_SLOTS 条） */
  wishes: Wish[];
  /** 新手引导是否已完成（完成一次后不再打扰） */
  guideDone?: boolean;
  stats: Stats;
  settings: Settings;
  /** Fever 结束时刻（ms），期间收益翻倍。 */
  feverUntil: number;
  combo: number;
  comboUntil: number;
  /** 上次种植的作物，供一键补种使用 */
  lastCrop: CropId | null;
  focus: FocusState;
  codex: Codex;
  /** 已达成成就的 id */
  achievements: string[];
}

export interface OfflineReport {
  seconds: number;
  /** 离线期间工厂自动完成的产出（作物只成熟不自动收，留给玩家回来点）。 */
  produced: Partial<Record<ItemId, number>>;
  /** 离线经营收入（金币） */
  coins: number;
  ripePlots: number;
  capped: boolean;
}

export interface TickEvent {
  kind: 'factory' | 'levelup' | 'autofarm';
  item?: ItemId;
  level?: number;
  /** autofarm 时的收获/补种块数 */
  harvested?: number;
  planted?: number;
}
