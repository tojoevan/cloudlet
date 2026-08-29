export type CropId = 'wheat' | 'corn' | 'carrot' | 'strawberry' | 'pumpkin' | 'cotton';
export type ProductId = 'bread' | 'butter' | 'jam' | 'wood' | 'milk';
export type ItemId = CropId | ProductId;
export type FactoryType = 'bakery' | 'dairy' | 'juice' | 'lumber' | 'ranch';
export type BuildingType = 'house' | 'cafe' | 'park' | 'fountain';
export type RecipeId = `${FactoryType}:${string}`;

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
}

export interface Building {
  id: string;
  type: BuildingType;
  /** 外观随机种子。存档只存种子，不存模型。 */
  seed: number;
}

export interface OrderLine {
  id: ItemId;
  count: number;
}

export interface Order {
  id: string;
  lines: OrderLine[];
  coins: number;
  exp: number;
  createdAt: number;
}

export type AudioChannel = 'citypop' | 'lofi' | 'ambient' | 'radio' | 'off';

export interface Settings {
  channel: AudioChannel;
  radioUrl: string;
  volume: number;
  powerSave: boolean;
  /**
   * 云同步开关，默认关闭。
   * 只跑 npm run dev 时后端并不存在，自动同步只会让 console 被 500 刷屏。
   * 用户在设置里手动同步成功一次后自动开启。
   */
  cloudSync: boolean;
}

export interface Stats {
  harvests: number;
  ordersDone: number;
  playSeconds: number;
  bestCombo: number;
  focusSessions: number;
  focusMinutes: number;
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
  /** 最后保存时刻（ms）。回来时用它算离线时长。 */
  savedAt: number;
  level: number;
  exp: number;
  coins: number;
  gems: number;
  plots: Plot[];
  factories: FactoryState[];
  buildings: Building[];
  inventory: Partial<Record<ItemId, number>>;
  orders: Order[];
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
