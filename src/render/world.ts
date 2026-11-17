import * as THREE from 'three';
import type { BuildingType, FactoryType, GameState, IslandShape } from '../core/types';
import { GRID_COLS, PLOT_COUNT } from '../core/state';
import { activeIslandMeta, CELL, SQUARE_N } from '../core/island';
import { cellToWorld, footprintCenter, firstFreeCell, occupiedCells, squarePlotCell } from '../core/grid';
import { populationOf } from '../core/economy';
import { Agents, WORKER_RADIUS } from './agents';
import type { AoCaster } from './meshes/terrain';
import { Bubbles, BUBBLE_READY, BUBBLE_RUNNING } from './bubbles';
import { makeCrop, growthScale, type CropMesh } from './meshes/crops';
import { makeBuilding, makeFactory, makeParkBench } from './meshes/structures';
import {
  LAMP_GLASS,
  makeBarrels,
  makeCrateStack,
  makeFenceLine,
  makeHedge,
  makeStall,
  makeFlowerBed,
  makeLamp,
  makeMailbox,
  makePlanter,
  makeSignpost,
  makeWell,
} from './meshes/props';
import {
  bakeGroundAO,
  makeBush,
  makeCloud,
  makeFlowerCluster,
  makeGrassPatch,
  makeGrassTuft,
  makeGroundOverlay,
  makePlaza,
  makeIsland,
  makeSquareIsland,
  makePlot,
  makePlotRing,
  makePond,
  makeRock,
  makeTree,
} from './meshes/terrain';
import { ISLAND_RADIUS, getPalette } from './palette';
import { seasonGrassTint } from '../core/season';
import { makeGrassField } from './grass';
import { bakeStatic } from './bake';
import { matOwn } from './mat';
import { mulberry32, range } from './rng';
import { isRipe, plotProgress } from '../core/simulation';

const FARM_CENTER = new THREE.Vector3(-3.4, 0, 3.3);
/** 矩形农田网格间距：> 田块边长(0.92) 保证相邻田块不重叠 */
const PLOT_GAP = 1.18;
/** 树林区中心：伐木工像农民一样始终在这片林子里巡视打理 */
const FOREST = new THREE.Vector2(5.0, 1.8);
const FOREST_RADIUS = 2.2;
/** 池塘：农田与树林之间嵌一块静态水景，居民会绕开它走 */
const POND = new THREE.Vector2(2.0, 2.5);
const POND_RADIUS = 1.4;

/**
 * 田块位置用规整矩形网格排布，外轮廓是圆角矩形（田块本身是圆角方块）。
 * index→坐标必须稳定（存档按 index 记作物），所以存档兼容。
 * 圆岛：居中在 FARM_CENTER 的矩形簇；方岛：落在网格中心 4×4（与建筑同套格子）。
 */
export function plotPosition(index: number, shape: IslandShape = 'round'): THREE.Vector3 {
  if (shape === 'square') {
    const c = squarePlotCell(index);
    const w = cellToWorld(c.gx, c.gz);
    return new THREE.Vector3(w.x, 0, w.z);
  }
  const c = index % GRID_COLS;
  const r = Math.floor(index / GRID_COLS);
  return new THREE.Vector3(
    FARM_CENTER.x + (c - (GRID_COLS - 1) / 2) * PLOT_GAP,
    0,
    FARM_CENTER.z + (r - (GRID_COLS - 1) / 2) * PLOT_GAP,
  );
}

/**
 * 建筑沿岛后半圈排布，把前半留给农田。
 * 岛屿固定为 ISLAND_RADIUS，不再随建筑扩张，所以这里必须把半径压死在岛缘内，
 * 任何索引都不许超出（否则又会悬空）。圈层内疏外密，超量时在最外圈内侧继续叠，
 * 保证「绝不悬空」——容量上限交给「升多层小屋」而非横向扩岛。
 */
function buildingPos(i: number): THREE.Vector3 {
  const rings = [4.4, 5.8, 7.0, 7.6]; // 各圈半径，全部 < ISLAND_RADIUS-1.3(7.7) 安全半径
  const perRing = [8, 10, 12, 14]; // 内疏外密，共 44 个穴位
  let k = 0;
  let rem = i;
  while (k < rings.length - 1 && rem >= perRing[k]) {
    rem -= perRing[k];
    k++;
  }
  let n = perRing[k];
  let r = rings[k];
  if (k === rings.length - 1 && rem >= n) {
    // 超出预设穴位：继续在最外圈内侧叠加，绝不超出岛缘
    const extra = Math.floor(rem / n);
    rem = rem % n;
    r = Math.max(2.5, r - 0.18 * (extra + 1));
  }
  const a = -Math.PI * 0.86 + (rem / n) * Math.PI * 0.78;
  return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
}

/** 工厂区：前缘右段自成一带。住宅只排后半圈（r≤8.2），永远不会挤过来，
 *  工厂门前没有遮挡；面朝岛外=正对默认镜头，雨棚与门脸一目了然。 */
function factoryPos(i: number): THREE.Vector3 {
  const a = Math.PI * 0.16 + (i % 5) * ((Math.PI * 0.34) / 4);
  const r = 7.9;
  return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
}

export class World {
  root = new THREE.Group();
  plotTiles: THREE.Mesh[] = [];
  pickables: THREE.Object3D[] = [];
  /** 当前激活岛形状：圆岛用极坐标布局，方岛用网格布局 */
  islandShape: IslandShape = 'round';
  /** 取某地块的世界坐标（按当前岛形状映射），供浮层跟随用 */
  plotWorldPos(index: number): THREE.Vector3 {
    return plotPosition(index, this.islandShape);
  }
  /** 方岛可点击落格的透明拾取面（建造模式才可见），main 用它们做射线检测 */
  gridCells: THREE.Mesh[] = [];
  /** 放置模式下的半透明预览体（绿=可放，红=不可放）。main 控制显隐与落点。 */
  private ghost: THREE.Group | null = null;
  private ghostMats: THREE.MeshStandardMaterial[] = [];
  private ghostW = 1;
  private ghostH = 1;

  private scene: THREE.Scene;
  private crops: ({ mesh: CropMesh; crop: string } | null)[] = [];
  private built = new Map<string, THREE.Group>();
  /** 浮空岛本体（整圈可随建筑扩张而重建变大），与 root 分离便于单独重建 */
  private island: THREE.Group | null = null;
  private islandRadius = ISLAND_RADIUS;
  /** 当前岛屿 id：用于给不同岛加专属装饰 */
  private islandId = 'round';
  private factories = new Map<string, THREE.Group>();
  /** 工厂头顶的运转气泡，与工厂一一对应 */
  private bubbles = new Map<string, Bubbles>();
  private clouds: THREE.Group[] = [];
  private hoverRing: THREE.Mesh;
  private ripeRings: THREE.Mesh[] = [];
  private windowLights: THREE.MeshStandardMaterial[] = [];
  /** 路灯的发光玻璃，夜间与窗户一起点亮 */
  private lampLights: THREE.MeshStandardMaterial[] = [];
  /** 刚落成的建筑：从 0.72 弹到 1，给「放下」一个瞬时反馈 */
  private pops: { obj: THREE.Object3D; t: number }[] = [];
  /** 可烘焙 AO 的地面覆盖层与其几何体 */
  private groundMesh: THREE.Mesh | null = null;
  private groundGeo: THREE.BufferGeometry | null = null;
  /** 投影体（树/房/道具），用于烘焙地面遮蔽 */
  private occluders: AoCaster[] = [];
  /** 建筑数量签名：变了才重新烘焙，避免每帧重算 */
  private aoSig = '';
  /** 目的地签名：建筑/工厂变化时重算居民去处 */
  private spotsSig = '';
  /** 自动小径（把散落的建筑串成街区） */
  private pathMesh: THREE.Mesh | null = null;
  private pathCurb: THREE.Mesh | null = null;
  /** 实例化草皮：整片地面只有 1 次绘制 */
  private grass: THREE.InstancedMesh | null = null;
  /** 沿街设施：重建路径时要先清掉旧的，否则每加一栋房子就会重复叠一层 */
  private pathProps: THREE.Object3D[] = [];
  private pathGeo: THREE.BufferGeometry | null = null;
  private pathSig = '';
  private bob = 0;
  private pond: THREE.Group | null = null;
  private lowSpec = false;
  /** 路网签名：任意路块增删都变，变化即让所有路段重算邻接（保证连贯） */
  private lastRoadSig = '';
  /** 随风轻摆的对象（树冠、草丛、作物），每帧给一点正弦旋转 */
  private swayers: { obj: THREE.Object3D; phase: number; amp: number; speed: number }[] = [];

  private dropSway(obj: THREE.Object3D): void {
    this.swayers = this.swayers.filter((s) => s.obj !== obj);
  }
  private agents = new Agents();

  constructor(scene: THREE.Scene, state?: GameState) {
    this.scene = scene;
    scene.add(this.root);
    this.root.add(this.agents.root);
    // 首屏就按当前激活岛形状建地形，避免存档停在方岛时错配成圆地形
    if (state) {
      this.islandShape = activeIslandMeta(state).shape;
      this.islandId = state.activeIsland;
    }
    this.buildTerrain();
    this.buildFarm();

    this.hoverRing = makePlotRing(1.0, 0xffffff);
    this.hoverRing.visible = false;
    this.root.add(this.hoverRing);
  }

  /**
   * 切换色系时整体重建：释放旧几何体/材质（先摘出常驻居民再 dispose），
   * 重置所有缓存集合，重建地形与农田，重新按当前存档同步并套用昼夜。
   * 色系切换是低频操作，一次轻微闪动可以接受。
   */
  rebuild(state: GameState, isNight: boolean): void {
    this.disposeRoot();
    this.scene.remove(this.root);
    this.root = new THREE.Group();
    this.resetCollections();
    this.scene.add(this.root);
    this.root.add(this.agents.root);
    // 必须在 buildTerrain 之前确定当前岛形状，否则会用上一次的旧形状重建地形
    this.islandShape = activeIslandMeta(state).shape;
    // islandId 必须在 buildTerrain 之前确定：专属装饰依赖它
    this.islandId = state.activeIsland;
    this.buildTerrain();
    this.buildFarm();
    this.hoverRing = makePlotRing(1.0, 0xffffff);
    this.hoverRing.visible = false;
    this.root.add(this.hoverRing);
    this.sync(state, Date.now(), this.lowSpec);
    this.applyTimeOfDay(isNight);
  }

  private disposeRoot(): void {
    // 居民是常驻对象，重建时保留：先从 root 摘出，避免被一并 dispose
    this.root.remove(this.agents.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as unknown as { material?: THREE.Material | THREE.Material[] }).material;
      if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
    });
  }

  private resetCollections(): void {
    this.crops = [];
    this.built = new Map();
    this.factories = new Map();
    this.bubbles = new Map();
    this.clouds = [];
    this.ripeRings = [];
    this.windowLights = [];
    this.lampLights = [];
    this.pops = [];
    this.pathProps = [];
    this.swayers = [];
    this.plotTiles = [];
    this.pickables = [];
    this.gridCells = [];
    this.lastRoadSig = '';
    this.clearGhost();
  }

  private buildTerrain(): void {
    this.occluders = [];
    this.aoSig = '';
    this.buildGroundOverlay();
    if (this.islandShape === 'square') {
      this.buildIslandSquare();
      this.decorateSquare();
    } else {
      this.buildIsland(this.islandRadius);
      this.decorateRound();
    }
    this.decorateFlavor();
    this.buildGrass();
    this.decorateClusters();
  }

  /**
   * 成组植被：树丛 + 灌木 + 花境。
   *
   * 之前树是均匀撒的，看起来像"点阵"；真实村落边缘是**成簇**的——
   * 一片树林、一丛灌木、一摊野花。成组后同样的数量观感密度高一倍，
   * 而且每组烘焙成 1 个网格，绘制次数反而更少。
   */
  private decorateClusters(): void {
    if (this.lowSpec) return;
    const rng = mulberry32(7331);
    const onSquare = this.islandShape === 'square';
    const R = this.islandRadius;
    const half = (SQUARE_N / 2) * CELL;

    const clusters = onSquare ? 10 : 13;
    for (let c = 0; c < clusters; c++) {
      const a = (c / clusters) * Math.PI * 2 + rng() * 0.5;
      let cx: number;
      let cz: number;
      if (onSquare) {
        const r = half + rng() * (8.2 - half) * 0.9;
        cx = Math.cos(a) * r;
        cz = Math.sin(a) * r;
      } else {
        const r = R * (0.55 + rng() * 0.34);
        cx = Math.cos(a) * r;
        cz = Math.sin(a) * r;
        if (Math.hypot(cx - POND.x, cz - POND.y) < POND_RADIUS + 0.9) continue;
        if (Math.hypot(cx - FARM_CENTER.x, cz - FARM_CENTER.z) < 3.2) continue;
      }

      // 整簇先在原点摆好，再整体烘焙成 1 个网格：
      // 一簇树+灌木+花从 10 来次绘制压到 1 次，观感完全不变。
      const cluster = new THREE.Group();
      const trees = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < trees; i++) {
        const ta = rng() * Math.PI * 2;
        const tr = Math.sqrt(rng()) * 1.1;
        const t = makeTree(Math.floor(rng() * 1e9));
        t.position.set(Math.cos(ta) * tr, 0, Math.sin(ta) * tr);
        t.scale.multiplyScalar(0.75 + rng() * 0.5);
        t.rotation.y = rng() * Math.PI * 2;
        cluster.add(t);
        this.shadowAt(cx + t.position.x, cz + t.position.z, 0.85);
      }
      const bushes = 3 + Math.floor(rng() * 4);
      for (let i = 0; i < bushes; i++) {
        const ba = rng() * Math.PI * 2;
        const br = 0.5 + Math.sqrt(rng()) * 1.5;
        const b = makeBush(Math.floor(rng() * 1e9));
        b.position.set(Math.cos(ba) * br, 0, Math.sin(ba) * br);
        b.rotation.y = rng() * Math.PI * 2;
        b.scale.multiplyScalar(0.85 + rng() * 0.4);
        cluster.add(b);
        this.shadowAt(cx + b.position.x, cz + b.position.z, 0.4);
      }
      const flowers = 1 + Math.floor(rng() * 2);
      for (let i = 0; i < flowers; i++) {
        const fa = rng() * Math.PI * 2;
        const fr = 0.4 + rng() * 1.3;
        const f = makeFlowerCluster(Math.floor(rng() * 1e9));
        f.position.set(Math.cos(fa) * fr, 0.02, Math.sin(fa) * fr);
        cluster.add(f);
      }
      bakeStatic(cluster);
      cluster.position.set(cx, 0, cz);
      this.root.add(cluster);
    }
  }

  /**
   * 密集草皮：整片地面 1 次绘制。
   * 它的作用不是"装饰"，而是给地面提供**尺度与高频细节**——
   * 平滑的绿色在等距视角下会显得空，草叶一上去才像"草地"。
   */
  private buildGrass(): void {
    if (this.lowSpec) return;
    if (this.grass) {
      this.root.remove(this.grass);
      this.grass.dispose();
      this.grass = null;
    }
    const rng = mulberry32(9127);
    const pts: { x: number; z: number; s: number }[] = [];
    // 成簇分布：先撒簇心，再在簇心周围撒 8~18 株，比均匀撒更像自然草皮
    const clump = (cx: number, cz: number) => {
      const n = 12 + Math.floor(rng() * 14);
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2;
        const r = Math.sqrt(rng()) * 0.55;
        pts.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, s: 0.75 + rng() * 0.55 });
      }
    };
    if (this.islandShape === 'square') {
      // 方岛内部被路径/农田/建筑占满，草只铺在网格外的岛缘环带
      const half = (SQUARE_N / 2) * CELL;
      const outer = 8.2;
      for (let i = 0; i < 380; i++) {
        const a = rng() * Math.PI * 2;
        const r = half + Math.sqrt(rng()) * (outer - half);
        clump(Math.cos(a) * r, Math.sin(a) * r);
      }
    } else {
      const R = this.islandRadius;
      for (let i = 0; i < 620; i++) {
        const a = rng() * Math.PI * 2;
        const r = Math.sqrt(rng()) * R * 0.95;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (Math.hypot(x - POND.x, z - POND.y) < POND_RADIUS + 0.5) continue;
        if (Math.hypot(x - FARM_CENTER.x, z - FARM_CENTER.z) < 3.0) continue;
        clump(x, z);
      }
    }
    if (pts.length === 0) return;
    this.grass = makeGrassField(pts);
    this.root.add(this.grass);
  }

  /**
   * 每座岛自己的辨识度。
   * 如果解锁出来的新岛长得和主岛一模一样，"开新岛"这件事就没有惊喜；
   * 这里用最省成本的三种手段区分：果树、围栏牧场、岩石与温泉雾气。
   */
  private decorateFlavor(): void {
    if (this.lowSpec) return;
    const R = this.islandRadius;
    switch (this.islandId) {
      case 'orchard': {
        // 果园：一圈结果子的树
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2 + 0.3;
          const r = R * (0.52 + (i % 3) * 0.09);
          const t = makeTree(i * 7717 + 3, 'broadleaf', true);
          t.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
          this.root.add(t);
          this.shadowAt(t.position.x, t.position.z, 0.9);
        }
        break;
      }
      case 'ranch': {
        // 牧场：围出一块草地，摆几个木桶
        // 牧场围在岛的一角，别压到中央农田上
        const cx = -4.4;
        const cz = 4.2;
        const half = 1.9;
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          const len = half * Math.SQRT2;
          this.addProp(makeFenceLine(len), cx + Math.cos(a) * half * 0.7, cz + Math.sin(a) * half * 0.7, -a, 1.2);
        }
        for (const [x, z] of [[cx - 0.9, cz - 1.0], [cx + 1.1, cz + 0.7], [cx + 0.6, cz - 1.2]] as [number, number][]) {
          this.addProp(makeBarrels(500 + Math.abs(x * 31 + z)), x, z, 0, 0.4);
        }
        break;
      }
      case 'onsen': {
        // 温泉：散落的巨石 + 三缕水汽
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2 + 1.1;
          const r = R * (0.35 + (i % 4) * 0.11);
          const rock = makeRock(i * 991);
          rock.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
          rock.scale.setScalar(1.4 + (i % 3) * 0.3);
          this.root.add(rock);
          this.shadowAt(rock.position.x, rock.position.z, 0.7);
        }
        for (let i = 0; i < 3; i++) {
          const steam = new THREE.Mesh(
            new THREE.CylinderGeometry(0.28, 0.5, 1.5, 8, 1, true),
            matOwn(0xffffff, { transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
          );
          steam.position.set(-1.2 + i * 1.2, 0.75, 0.8 + (i % 2) * 0.6);
          this.root.add(steam);
        }
        break;
      }
      case 'summit': {
        // 云顶：低空飘几朵小云
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const cloud = makeCloud(i * 313);
          cloud.position.set(Math.cos(a) * (R * 0.7), 1.6 + (i % 3) * 0.7, Math.sin(a) * (R * 0.7));
          cloud.scale.setScalar(0.55);
          this.root.add(cloud);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * 地面覆盖层：细分网格 + 顶点色，AO 直接烘在里面。
   * 用不透明网格而不是透明贴花，正是为了绕开共面深度冲突。
   */
  private buildGroundOverlay(): void {
    if (this.groundMesh) {
      this.root.remove(this.groundMesh);
      this.groundGeo?.dispose();
      this.groundMesh = null;
      this.groundGeo = null;
    }
    const round = this.islandShape !== 'square';
    const size = round ? this.islandRadius * 0.995 : 8.26;
    const geo = makeGroundOverlay(this.islandShape, size, 2.58, round ? 46 : 40, seasonGrassTint(getPalette().grass));
    const mesh = new THREE.Mesh(
      geo,
      // 材质色必须是白色：vertexColors 是与材质色相乘的，
      // 若这里也填草色，就会变成「草色 × 草色」而整体发暗。
      matOwn(0xffffff, {
        vertexColors: true,
        // 覆盖层的三角面朝向由生成方式决定，直接双面渲染最稳（不会因绕序被剔除）
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );
    mesh.position.y = 0.004; // 略高于岛面，避免与草皮顶盖打架
    mesh.receiveShadow = true;
    this.root.add(mesh);
    this.groundMesh = mesh;
    this.groundGeo = geo;
  }

  /**
   * 自动小径：从农田外圈铺一圈"环路"，再把每栋建筑/工厂用小径接到环路上。
   *
   * 为什么值得做：散落的房子只是"很多房子"，一旦有路把它们连到同一个环，
   * 观者立刻会把它读成"街区"。这是等距视角下最省成本的空间叙事。
   *
   * 渲染上把全部小径格子合并成 1 个几何体（1 个 draw call），每格一块略缩进的
   * 方砖，留出缝隙就是石板路的感觉，也省掉了连通性拼接的复杂度。
   */
  /** 清掉上一次摆的沿街设施（几何体与材质一起释放，避免泄漏） */
  private clearPathProps(): void {
    for (const o of this.pathProps) {
      this.root.remove(o);
      o.traverse((child) => {
        const m = child as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
    }
    this.pathProps = [];
  }

  private rebuildPaths(state: GameState): void {
    this.clearPathProps();
    if (this.pathMesh) {
      this.root.remove(this.pathMesh);
      this.pathGeo?.dispose();
      this.pathMesh = null;
      this.pathGeo = null;
    }
    if (this.pathCurb) {
      this.root.remove(this.pathCurb);
      this.pathCurb.geometry.dispose();
      this.pathCurb = null;
    }
    if (this.islandShape !== 'square') return;

    const start = Math.floor((SQUARE_N - 4) / 2); // 农田 4×4 的左上角
    const lo = start - 1;
    const hi = start + 4;
    const inRing = (gx: number, gz: number) =>
      ((gx === lo || gx === hi) && gz >= lo && gz <= hi) ||
      ((gz === lo || gz === hi) && gx >= lo && gx <= hi);

    const blocked = occupiedCells(state);
    const cells = new Set<string>();

    // 环路：农田外一圈
    for (let gz = lo; gz <= hi; gz++) {
      for (let gx = lo; gx <= hi; gx++) {
        if (inRing(gx, gz) && !blocked.has(`${gx},${gz}`)) cells.add(`${gx},${gz}`);
      }
    }

    // 支路：每栋建筑/工厂 → 环路（先横后纵的 L 形，像真实村落的巷道）
    const anchors: { gx: number; gz: number }[] = [];
    for (const b of state.buildings) {
      if (b.type === 'road') continue;
      if (b.gx != null && b.gz != null) anchors.push({ gx: b.gx, gz: b.gz });
    }
    for (const f of state.factories) {
      if (f.gx != null && f.gz != null) anchors.push({ gx: f.gx, gz: f.gz });
    }
    const clampRing = (v: number) => Math.max(lo, Math.min(hi, v));
    for (const a of anchors) {
      let x = a.gx;
      let z = a.gz;
      const tx = clampRing(x);
      while (x !== tx) {
        x += Math.sign(tx - x);
        if (!blocked.has(`${x},${z}`)) cells.add(`${x},${z}`);
      }
      const tz = clampRing(z);
      while (z !== tz) {
        z += Math.sign(tz - z);
        if (!blocked.has(`${x},${z}`)) cells.add(`${x},${z}`);
      }
    }

    if (cells.size === 0) return;

    // 合并成一块几何体
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    // 路缘：比路面大一圈、压深一档的底色，让铺装与草地之间有明确边界
    const curbPos: number[] = [];
    const curbCol: number[] = [];
    const curbIdx: number[] = [];
    const base = new THREE.Color(getPalette().path);
    const curbBase = base.clone().lerp(new THREE.Color(0x8a8f7a), 0.45);
    const half = CELL * 0.40;
    const curbHalf = half + 0.045;
    let vi = 0;
    let ci = 0;
    for (const key of cells) {
      const [gx, gz] = key.split(',').map(Number);
      const c = cellToWorld(gx, gz);
      const jitterK = 1 + (((gx * 73856093) ^ (gz * 19349663)) % 100) / 900;
      const col = base.clone().multiplyScalar(jitterK);
      positions.push(c.x - half, 0, c.z - half, c.x + half, 0, c.z - half, c.x + half, 0, c.z + half, c.x - half, 0, c.z + half);
      for (let k = 0; k < 4; k++) colors.push(col.r, col.g, col.b);
      indices.push(vi, vi + 2, vi + 1, vi, vi + 3, vi + 2);
      vi += 4;

      const cc = curbBase.clone().multiplyScalar(jitterK);
      curbPos.push(
        c.x - curbHalf, 0, c.z - curbHalf,
        c.x + curbHalf, 0, c.z - curbHalf,
        c.x + curbHalf, 0, c.z + curbHalf,
        c.x - curbHalf, 0, c.z + curbHalf,
      );
      for (let k = 0; k < 4; k++) curbCol.push(cc.r, cc.g, cc.b);
      curbIdx.push(ci, ci + 2, ci + 1, ci, ci + 3, ci + 2);
      ci += 4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geo,
      matOwn(0xffffff, {
        vertexColors: true,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    mesh.position.y = 0.02;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    this.pathMesh = mesh;
    this.pathGeo = geo;

    // 路缘单独一个网格（共 1 次绘制），压在路面下方 6mm
    const curbGeo = new THREE.BufferGeometry();
    curbGeo.setAttribute('position', new THREE.Float32BufferAttribute(curbPos, 3));
    curbGeo.setAttribute('color', new THREE.Float32BufferAttribute(curbCol, 3));
    curbGeo.setIndex(curbIdx);
    curbGeo.computeVertexNormals();
    const curbMesh = new THREE.Mesh(
      curbGeo,
      matOwn(0xffffff, {
        vertexColors: true,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );
    curbMesh.position.y = 0.014;
    curbMesh.receiveShadow = true;
    this.root.add(curbMesh);
    this.pathCurb = curbMesh;

    this.decorateAlongPaths(state, cells, lo, hi, blocked);
  }

  /**
   * 沿街设施：花箱、长椅、木箱、路灯。
   *
   * 参考梦想城镇的画面构成：丰盛感不来自大建筑，而来自**沿街重复出现的小物件**。
   * 这里只在路径外缘按固定节奏摆放，间距规则，才不会显得乱。
   */
  private decorateAlongPaths(
    state: GameState,
    cells: Set<string>,
    lo: number,
    hi: number,
    blocked: Set<string>,
  ): void {
    if (this.lowSpec) return;

    let i = 0;
    for (const key of cells) {
      const [gx, gz] = key.split(',').map(Number);
      // 只在环路外缘摆，避免挡住农田与巷道
      const onRing = (gx === lo || gx === hi || gz === lo || gz === hi);
      if (!onRing) continue;
      const corner = (gx === lo || gx === hi) && (gz === lo || gz === hi);
      if (corner) continue; // 四角留给路灯
      i += 1;
      if (i % 2 !== 0) continue; // 隔一格放一个，节奏才稳

      const c = cellToWorld(gx, gz);
      // 往岛缘方向偏移，让出路面
      const dx = gx === lo ? -1 : gx === hi ? 1 : 0;
      const dz = gz === lo ? -1 : gz === hi ? 1 : 0;
      const ox = c.x + dx * CELL * 0.52;
      const oz = c.z + dz * CELL * 0.52;
      // 偏移点若落在被占用格里就不摆（避免插进房子）
      const nx = gx + dx;
      const nz = gz + dz;
      if (blocked.has(`${nx},${nz}`)) continue;

      if (i % 6 === 2) {
        const bench = makeParkBench(gx * 37 + gz * 11);
        bench.position.set(ox, 0, oz);
        bench.rotation.y = dx !== 0 ? Math.PI / 2 : 0;
        this.root.add(bench);
        this.pathProps.push(bench);
        this.shadowAt(ox, oz, 0.5);
      } else if (i % 6 === 4) {
        const crates = makeCrateStack(gx * 53 + gz * 7);
        crates.position.set(ox, 0, oz);
        this.root.add(crates);
        this.pathProps.push(crates);
        this.shadowAt(ox, oz, 0.35);
      } else {
        const planter = makePlanter(gx * 29 + gz * 13);
        planter.position.set(ox, 0, oz);
        planter.rotation.y = dx !== 0 ? Math.PI / 2 : 0;
        this.root.add(planter);
        this.pathProps.push(planter);
        this.shadowAt(ox, oz, 0.3);
      }
    }

    // 四角路灯
    for (const [gx, gz] of [[lo, lo], [hi, lo], [lo, hi], [hi, hi]] as [number, number][]) {
      if (blocked.has(`${gx},${gz}`)) continue;
      const c = cellToWorld(gx, gz);
      const lamp = makeLamp();
      lamp.position.set(c.x, 0, c.z);
      lamp.rotation.y = Math.PI / 4;
      this.root.add(lamp);
      this.pathProps.push(lamp);
      // 路灯要登记发光材质，夜里才会亮
      lamp.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.name === LAMP_GLASS && m.material) {
          this.lampLights.push(m.material as THREE.MeshStandardMaterial);
        }
      });
      this.shadowAt(c.x, c.z, 0.4);
    }
    void state;
  }

  /**
   * 重算居民的去处：家（住宅）、广场（池畔或农田环路）、农田、工厂。
   * 有了去处，居民的行为才从「随机漫步」变成「上班/回家/逛广场」。
   */
  private rebuildSpots(state: GameState): void {
    const spots: { kind: 'home' | 'plaza' | 'farm' | 'factory'; x: number; z: number }[] = [];
    const onSquare = this.islandShape === 'square';

    state.buildings.forEach((b, i) => {
      if (b.type !== 'house') return;
      if (onSquare) {
        if (b.gx == null || b.gz == null) return;
        const c = footprintCenter(b.gx, b.gz, b.w ?? 1, b.h ?? 1);
        spots.push({ kind: 'home', x: c.x, z: c.z });
      } else {
        const p = buildingPos(i);
        spots.push({ kind: 'home', x: p.x, z: p.z });
      }
    });

    if (!onSquare) {
      spots.push({ kind: 'plaza', x: POND.x, z: POND.y });
    } else {
      const start = Math.floor((SQUARE_N - 4) / 2);
      const lo = start - 1;
      const hi = start + 4;
      for (const [gx, gz] of [[lo, lo], [hi, lo], [lo, hi], [hi, hi]] as [number, number][]) {
        const c = cellToWorld(gx, gz);
        spots.push({ kind: 'plaza', x: c.x, z: c.z });
      }
    }

    // 农田：每 4 块取一个点，避免所有居民挤在同一垄上
    for (let i = 0; i < state.plots.length; i += 4) {
      const p = plotPosition(i, this.islandShape);
      spots.push({ kind: 'farm', x: p.x, z: p.z });
    }

    state.factories.forEach((f, i) => {
      const p = this.factoryWorldPos(f, i, state);
      spots.push({ kind: 'factory', x: p.x, z: p.z });
    });

    this.agents.setSpots(spots);
  }

  /** 重新烘焙地面遮蔽（建筑/工厂数量变化时调用） */
  private rebakeAO(): void {
    if (!this.groundGeo) return;
    bakeGroundAO(this.groundGeo, this.occluders);
  }

  /**
   * 在指定位置放一团接触阴影。
   * 半径用显式参数而不是 Box3：实测 setFromObject 在建场阶段拿到的尺寸偏小且不稳定，
   * 会导致阴影缩成看不见的小点。
   */
  private shadowAt(x: number, z: number, r: number): void {
    // 接触阴影贴花暂时不用（共面深度冲突），改成登记投影体给烘焙 AO 用
    this.occluders.push({ x, z, r: Math.max(0.25, r), k: 1 });
  }

  /** 把一件道具放到世界坐标，并登记其中的可发光材质（路灯玻璃） */
  private addProp(obj: THREE.Object3D, x: number, z: number, rotY = 0, shadowR = 0.55): void {
    obj.position.set(x, 0, z);
    obj.rotation.y = rotY;
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.name === LAMP_GLASS && m.material) {
        this.lampLights.push(m.material as THREE.MeshStandardMaterial);
      }
    });
    this.root.add(obj);
    this.shadowAt(x, z, shadowR);
  }

  /**
   * 方岛生活道具：沿规划网格外的岛缘围一圈栅栏、四角立路灯、入口放路牌与花坛。
   * 网格外只剩约 0.6 单位的边缘，所以这里只用"贴边"的道具，不占可建造格。
   * 低画质/省电模式直接跳过，保住帧率。
   */
  private decorateSquareProps(): void {
    if (this.lowSpec) return;
    const half = (SQUARE_N / 2) * CELL;      // 规划网格半宽 ≈ 7.67
    const edge = half + 0.28;                 // 贴着岛缘内侧 ≈ 7.95
    const arc = half - 2.4;                   // 栅栏只铺直边段，避开圆角
    // 左右两侧 + 后方：围栏；正面留出入口
    for (const [x, z, rot] of [
      [-edge, 0, Math.PI / 2],
      [edge, 0, Math.PI / 2],
      [0, -edge, 0],
    ] as [number, number, number][]) {
      this.addProp(makeFenceLine(arc * 2), x, z, rot);
    }
    // 正面：两侧各一段，中间是入口
    const gate = 3.0;
    for (const x of [-(arc + gate) / 2 - 0.2, (arc + gate) / 2 + 0.2]) {
      this.addProp(makeFenceLine(arc - gate / 2), x, edge, 0);
    }
    // 四角路灯
    for (const [x, z] of [[-edge + 0.15, -arc + 0.6], [edge - 0.15, -arc + 0.6],
      [-edge + 0.15, arc - 0.6], [edge - 0.15, arc - 0.6]]) {
      this.addProp(makeLamp(), x, z, x > 0 ? Math.PI : 0);
    }
    // 入口路牌 + 摊市 + 岛缘花坛：把"入口"做成一个真的能逛的地方
    this.addProp(makeSignpost(), -2.9, edge, Math.PI);
    this.addProp(makeStall(4401), -1.6, edge - 0.35, Math.PI, 0.7);
    this.addProp(makeStall(4402), 1.6, edge - 0.35, Math.PI, 0.7);
    this.addProp(makeFlowerBed(3301), -(arc - 1.2), edge);
    this.addProp(makeFlowerBed(3302), arc - 1.2, edge);
    // 背侧用树篱围出两段"院落"，比纯栅栏更有生活气
    for (const x of [-arc * 0.55, arc * 0.55]) {
      this.addProp(makeHedge(arc * 0.7), x, -edge + 0.35, 0, 0.6);
    }
  }

  /** 圆岛生活道具：井、邮筒、木桶、花坛、路牌，沿农田与树林之间的空地摆放 */
  private decorateRoundProps(): void {
    if (this.lowSpec) return;
    const R = this.islandRadius;
    this.addProp(makeWell(), FARM_CENTER.x + 4.3, FARM_CENTER.z - 1.1);
    this.addProp(makeMailbox(), -1.4, -2.2, Math.PI * 0.15);
    this.addProp(makeFlowerBed(2101), -R * 0.62, -R * 0.42);
    this.addProp(makeFlowerBed(2102), R * 0.5, -R * 0.55);
    this.addProp(makeSignpost(), R * 0.72, -R * 0.18, -Math.PI * 0.35);
    this.addProp(makeBarrels(2201), FOREST.x + 1.4, FOREST.y + 1.6);
    this.addProp(makeBarrels(2202), R * 0.34, R * 0.72);
    this.addProp(makeLamp(), -R * 0.5, R * 0.5, Math.PI * 0.25);
    this.addProp(makeLamp(), R * 0.28, -R * 0.78, -Math.PI * 0.25);
  }

  /** 圆岛装饰：绕岛树木、树林区、岩石、草丛、池塘、云。沿用旧逻辑。 */
  private decorateRound(): void {
    const rng = mulberry32(90210);
    // 树：绕岛一圈，避开农田与建筑位
    for (let i = 0; i < 22; i++) {
      const a = rng() * Math.PI * 2;
      const r = range(rng, ISLAND_RADIUS * 0.55, ISLAND_RADIUS * 0.9);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x - FARM_CENTER.x, z - FARM_CENTER.z) < 2.9) continue; // 矩形农田区
      if (z < 0 && Math.hypot(x, z) < 7.6) continue; // 建筑区
      // 工厂前缘区：右前段岛边留给工厂，树别长在厂门口挡雨棚
      const fa = Math.atan2(z, x);
      if (z > 0 && r > 6.2 && fa > Math.PI * 0.12 && fa < Math.PI * 0.54) continue;
      if (Math.hypot(x - POND.x, z - POND.y) < POND_RADIUS + 0.4) continue; // 池塘区
      const t = makeTree(Math.floor(rng() * 1e9));
      t.position.set(x, 0, z);
      this.root.add(t);
      this.shadowAt(x, z, 0.95);
    }

    // 树林区：在 FOREST 周围集中种一小片树，让伐木工真的在树间巡视
    const frng = mulberry32(55501);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + frng() * 0.5;
      const r = 0.6 + frng() * 1.4;
      const px = FOREST.x + Math.cos(a) * r;
      const pz = FOREST.y + Math.sin(a) * r;
      if (Math.hypot(px - POND.x, pz - POND.y) < POND_RADIUS + 0.6) continue; // 别长进池塘
      const t = makeTree(Math.floor(frng() * 1e9));
      t.position.set(px, 0, pz);
      this.root.add(t);
      this.shadowAt(px, pz, 0.9);
      const foliage = t.userData.foliage as THREE.Object3D | undefined;
      if (foliage) this.swayers.push({ obj: foliage, phase: (px + pz) * 1.7, amp: 0.05, speed: 1.6 });
    }

    for (let i = 0; i < 14; i++) {
      const a = rng() * Math.PI * 2;
      const r = range(rng, 2, ISLAND_RADIUS * 0.92);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x - POND.x, z - POND.y) < POND_RADIUS + 0.4) continue; // 池塘区
      const rock = makeRock(Math.floor(rng() * 1e9));
      rock.position.set(x, 0, z);
      this.root.add(rock);
      this.shadowAt(x, z, 0.5);
    }

    for (let i = 0; i < 40; i++) {
      const a = rng() * Math.PI * 2;
      const r = range(rng, 1.5, ISLAND_RADIUS * 0.95);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x - POND.x, z - POND.y) < POND_RADIUS + 0.4) continue; // 池塘区
      const tuft = makeGrassTuft(Math.floor(rng() * 1e9));
      tuft.position.set(x, 0, z);
      this.root.add(tuft);
      this.swayers.push({ obj: tuft, phase: (x + z) * 2.1, amp: 0.13, speed: 2.6 });
    }

    // 池塘：农田与树林之间嵌一块静态水景，居民会绕开
    const pond = makePond(13579);
    pond.position.set(POND.x, 0, POND.y);
    this.root.add(pond);
    this.pond = pond;

    this.decorateRoundProps();

    // 镇中心广场：把池塘围成硬质铺装的场域，长椅/路灯/花坛沿环排布。
    // 这是"梦想城镇"式画面上最关键的场域线索——有广场才有"镇"。
    const plazaR = 2.65;
    const plaza = makePlaza(plazaR);
    plaza.position.set(POND.x, 0.008, POND.y);
    this.root.add(plaza);
    const ring = plazaR - 0.45;
    // 四张长椅朝内，四个路灯在斜角，花坛填空档
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const bx = POND.x + Math.cos(a) * ring;
      const bz = POND.y + Math.sin(a) * ring;
      const bench = makeParkBench(i * 31 + 7);
      bench.position.set(bx, 0, bz);
      bench.rotation.y = -a + Math.PI / 2;
      this.root.add(bench);
      this.shadowAt(bx, bz, 0.5);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const lx = POND.x + Math.cos(a) * (plazaR - 0.28);
      const lz = POND.y + Math.sin(a) * (plazaR - 0.28);
      this.addProp(makeLamp(), lx, lz, -a + Math.PI / 2, 0.4);
    }
    this.addProp(makeFlowerBed(9101), POND.x - 1.9, POND.y - 1.9, 0, 0.6);
    this.addProp(makeFlowerBed(9102), POND.x + 1.9, POND.y - 1.9, 0, 0.6);

    // 地面色块：把"一整块纯绿"打散成有深浅的草皮
    for (let i = 0; i < 13; i++) {
      const a = rng() * Math.PI * 2;
      const r = range(rng, 2.2, ISLAND_RADIUS * 0.86);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x - POND.x, z - POND.y) < POND_RADIUS + 0.9) continue;
      if (Math.hypot(x - FARM_CENTER.x, z - FARM_CENTER.z) < 3.1) continue;
      const patch = makeGrassPatch(Math.floor(rng() * 1e9), range(rng, 1.3, 2.9), rng() > 0.42);
      patch.position.set(x, 0.012, z);
      this.root.add(patch);
    }
    // 花丛：给草地几处暖色重点
    for (let i = 0; i < 15; i++) {
      const a = rng() * Math.PI * 2;
      const r = range(rng, 2.4, ISLAND_RADIUS * 0.88);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x - POND.x, z - POND.y) < POND_RADIUS + 0.5) continue;
      const f = makeFlowerCluster(Math.floor(rng() * 1e9));
      f.position.set(x, 0.02, z);
      this.root.add(f);
    }

    // 云：绕岛缓慢漂移，让静止画面也有呼吸感
    // 云只留 4 朵并推远：多了会像纸片，抢掉主体的视觉重量
    for (let i = 0; i < 4; i++) {
      const cloud = makeCloud(Math.floor(rng() * 1e9));
      const a = (i / 4) * Math.PI * 2 + 0.6;
      cloud.position.set(Math.cos(a) * range(rng, 16, 23), range(rng, 6.5, 11), Math.sin(a) * range(rng, 16, 23));
      cloud.userData.orbit = a;
      cloud.userData.radius = Math.hypot(cloud.position.x, cloud.position.z);
      cloud.userData.speed = range(rng, 0.008, 0.02);
      this.clouds.push(cloud);
      this.root.add(cloud);
    }
  }

  /** 方岛装饰：沿岛缘种树、点缀岩石草丛，并铺好可点击的网格拾取面（用于落格建造）。 */
  private decorateSquare(): void {
    const rng = mulberry32(20260830);
    const half = (SQUARE_N / 2) * CELL;
    // 沿岛缘种一圈树，留几个缺口透气
    const treeN = 26;
    for (let i = 0; i < treeN; i++) {
      const a = (i / treeN) * Math.PI * 2 + rng() * 0.1;
      const r = half - range(rng, 0.3, 0.9);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      // 别压在规划网格最外圈的农田/建筑上
      if (Math.abs(x) > half - CELL || Math.abs(z) > half - CELL) {
        if (rng() < 0.5) continue;
      }
      const t = makeTree(Math.floor(rng() * 1e9));
      t.position.set(x, 0, z);
      this.root.add(t);
    }
    for (let i = 0; i < 12; i++) {
      const a = rng() * Math.PI * 2;
      const r = range(rng, 2, half - CELL);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const rock = makeRock(Math.floor(rng() * 1e9));
      rock.position.set(x, 0, z);
      this.root.add(rock);
    }
    for (let i = 0; i < 30; i++) {
      const x = range(rng, -half + CELL, half - CELL);
      const z = range(rng, -half + CELL, half - CELL);
      const tuft = makeGrassTuft(Math.floor(rng() * 1e9));
      tuft.position.set(x, 0, z);
      this.root.add(tuft);
      this.swayers.push({ obj: tuft, phase: (x + z) * 2.1, amp: 0.1, speed: 2.4 });
    }
    // 云
    for (let i = 0; i < 6; i++) {
      const cloud = makeCloud(Math.floor(rng() * 1e9));
      const a = (i / 6) * Math.PI * 2;
      cloud.position.set(Math.cos(a) * range(rng, 12, 18), range(rng, 5, 10), Math.sin(a) * range(rng, 12, 18));
      cloud.userData.orbit = a;
      cloud.userData.radius = Math.hypot(cloud.position.x, cloud.position.z);
      cloud.userData.speed = range(rng, 0.008, 0.02);
      this.clouds.push(cloud);
      this.root.add(cloud);
    }
    this.decorateSquareProps();

    // 方岛的草地同样需要色块与花丛，否则网格线内是一张纯绿图纸
    const srng = mulberry32(31337);
    const halfSq = (SQUARE_N / 2) * CELL;
    for (let i = 0; i < 14; i++) {
      const a = srng() * Math.PI * 2;
      const r = range(srng, 1.5, halfSq * 0.95);
      const patch = makeGrassPatch(Math.floor(srng() * 1e9), range(srng, 1.2, 2.6), srng() > 0.42);
      patch.position.set(Math.cos(a) * r, 0.012, Math.sin(a) * r);
      this.root.add(patch);
    }
    for (let i = 0; i < 16; i++) {
      const a = srng() * Math.PI * 2;
      const r = range(srng, 3.2, halfSq * 0.96);
      const f = makeFlowerCluster(Math.floor(srng() * 1e9));
      f.position.set(Math.cos(a) * r, 0.02, Math.sin(a) * r);
      this.root.add(f);
    }
    this.buildGridCells();
  }

  /** 方岛：在每格中心放一块透明拾取面，建造模式下点击它即可落格。 */
  private buildGridCells(): void {
    this.gridCells = [];
    const outer = (SQUARE_N / 2) * CELL;
    for (let gz = 0; gz < SQUARE_N; gz++) {
      for (let gx = 0; gx < SQUARE_N; gx++) {
        const { x, z } = cellToWorld(gx, gz);
        const plane = new THREE.Mesh(
          new THREE.PlaneGeometry(CELL * 0.96, CELL * 0.96),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
        );
        plane.rotation.x = -Math.PI / 2;
        plane.position.set(x, 0.06, z);
        plane.userData.cell = { gx, gz };
        plane.visible = false; // 仅建造模式可见/可点
        this.root.add(plane);
        this.gridCells.push(plane);
      }
    }
    void outer;
  }

  private buildIslandSquare(): void {
    if (this.island) {
      this.root.remove(this.island);
      this.island.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = (m as unknown as { material?: THREE.Material | THREE.Material[] }).material;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
      });
    }
    this.island = makeSquareIsland(20260829);
    this.root.add(this.island);
    this.pond = null;
  }

  /** 单独重建浮空岛本体（保留树/石/池塘等其余地形）。建筑往外排时整圈放大。 */
  private buildIsland(radius: number): void {
    if (this.island) {
      this.root.remove(this.island);
      this.island.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = (m as unknown as { material?: THREE.Material | THREE.Material[] }).material;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
      });
    }
    this.islandRadius = radius;
    this.island = makeIsland(20260829, radius);
    this.root.add(this.island);
  }

  // 岛屿固定为原始大小（ISLAND_RADIUS），不再随建筑扩张——
  // 扩岛不好看，容量改由「升级房屋成多层小屋」提供（见 structures.makeHouse）。

  private buildFarm(): void {
    for (let i = 0; i < PLOT_COUNT; i++) {
      const tile = makePlot(i);
      tile.position.copy(plotPosition(i, this.islandShape));
      this.root.add(tile);
      this.plotTiles.push(tile);
      this.pickables.push(tile);
      this.crops.push(null);
      this.ripeRings.push(null as unknown as THREE.Mesh);
    }
  }

  /** 结构同步：只在增删时重建，不每帧跑 */
  sync(state: GameState, now: number, lowSpec = false): void {
    this.lowSpec = lowSpec;
    this.islandShape = activeIslandMeta(state).shape;
    this.islandId = state.activeIsland;
    this.syncCrops(state);
    this.syncBuildings(state);
    this.syncFactories(state);
    this.agents.sync(populationOf(state), lowSpec);

    // 建筑/工厂数量变化才重烘：装饰在建场时已登记完，之后只需补建筑
    const sig = `${state.buildings.length}:${state.factories.length}`;
    if (sig !== this.spotsSig) {
      this.spotsSig = sig;
      this.rebuildSpots(state);
    }
    if (sig !== this.aoSig) {
      this.aoSig = sig;
      this.rebakeAO();
    }
    // 小径跟着建筑走：位置变了才重建（比 AO 多一个坐标签名）
    const pathSig = `${sig}|${state.buildings.map((b) => `${b.gx},${b.gz}`).join(';')}`;
    if (pathSig !== this.pathSig) {
      this.pathSig = pathSig;
      this.rebuildPaths(state);
    }
    this.agents.syncFarmer();

    // 伐木工：像农民一样始终在树林区巡视打理，不依赖是否建了伐木场工厂。
    // 这样没解锁工厂也能在林子里看到一个守林人，更像一个活着的镇子。
    this.agents.syncWorker('lumber', FOREST, FOREST_RADIUS);

    // 畜牧工：建了牧场工厂才派，仍守在厂房旁的草地上
    let ranchCenter: THREE.Vector2 | null = null;
    state.factories.forEach((f, i) => {
      if (f.type !== 'ranch') return;
      const p = this.factoryWorldPos(f, i);
      // 朝岛心方向偏移 1.8，把工人放到厂房和岛心之间的草地上
      const inward = new THREE.Vector2(-p.x, -p.z).normalize().multiplyScalar(1.8);
      ranchCenter = new THREE.Vector2(p.x, p.z).add(inward);
    });
    if (ranchCenter) this.agents.syncWorker('ranch', ranchCenter, WORKER_RADIUS);

    // 把当前岛的活动范围与道路网格交给居民系统（方岛在方格内走、沿路散步）
    const roadCells = state.buildings
      .filter((b) => b.type === 'road' && b.gx != null && b.gz != null)
      .map((b) => ({ gx: b.gx as number, gz: b.gz as number }));
    this.agents.configure(this.islandShape, (SQUARE_N / 2) * CELL, roadCells);
    void now;
  }

  /** 工厂的世界坐标：方岛走网格，圆岛走极坐标 */
  private factoryWorldPos(f: { gx?: number; gz?: number }, i: number, state?: GameState): THREE.Vector3 {
    if (this.islandShape === 'square') {
      if (f.gx == null || f.gz == null) {
        const spot = state ? firstFreeCell(state, 2, 2) : null;
        if (spot) {
          f.gx = spot.gx;
          f.gz = spot.gz;
        }
      }
      if (f.gx != null && f.gz != null) {
        const { x, z } = footprintCenter(f.gx, f.gz, 2, 2);
        return new THREE.Vector3(x, 0, z);
      }
    }
    return factoryPos(i);
  }

  private syncCrops(state: GameState): void {
    for (let i = 0; i < state.plots.length; i++) {
      const plot = state.plots[i];
      const slot = this.crops[i];
      const wantCrop = plot.crop;

      if (!wantCrop) {
        if (slot) {
          this.root.remove(slot.mesh.group);
          this.dropSway(slot.mesh.group);
          this.crops[i] = null;
        }
        continue;
      }
      if (slot && slot.crop === wantCrop) continue;
      if (slot) {
        this.root.remove(slot.mesh.group);
        this.dropSway(slot.mesh.group);
      }

      const mesh = makeCrop(wantCrop, i * 7919 + 13);
      const pos = plotPosition(i, this.islandShape);
      mesh.group.position.copy(pos);
      mesh.group.position.y = 0.07; // 作物略高于田面，避免与地块 z-fighting
      this.root.add(mesh.group);
      this.crops[i] = { mesh, crop: wantCrop };
      this.swayers.push({ obj: mesh.group, phase: (i * 1.3) % (Math.PI * 2), amp: 0.07, speed: 2.0 });
    }
  }

  private syncBuildings(state: GameState): void {
    const seen = new Set<string>();
    const onSquare = this.islandShape === 'square';

    // 方岛：先收集所有路格，用于自动拼接（十字/T/拐弯/直路）。
    const roadCells = new Set<string>();
    if (onSquare) {
      for (const b of state.buildings) {
        if (b.type === 'road' && b.gx != null && b.gz != null) roadCells.add(`${b.gx},${b.gz}`);
      }
    }
    // 路网签名变化（增删任意路块）→ 让所有已建路段重算邻接，保证整网连贯
    const roadSig = [...roadCells].sort().join('|');
    if (roadSig !== this.lastRoadSig) {
      for (const [id, group] of this.built) {
        const b = state.buildings.find((x) => x.id === id);
        if (b && b.type === 'road') {
          this.root.remove(group);
          // 仅释放几何体；颜色材质是 mat() 共享缓存，跨路段复用，不能 dispose
          group.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.geometry) m.geometry.dispose();
          });
          const pi = this.pickables.indexOf(group);
          if (pi >= 0) this.pickables.splice(pi, 1);
          this.built.delete(id);
        }
      }
      this.lastRoadSig = roadSig;
    }

    state.buildings.forEach((b, i) => {
      seen.add(b.id);
      const existing = this.built.get(b.id);
      if (existing) {
        // 数组下标会因删除而变，每次同步都刷新标注，保证拾取索引始终对应当前建筑
        existing.userData.buildingId = i;
        return;
      }
      const w = b.w ?? 1;
      const h = b.h ?? 1;
      // 方岛道路：按上下左右邻居算出自动拼接 mask（N=1 E=2 S=4 W=8）
      let roadMask = -1;
      if (b.type === 'road' && onSquare && b.gx != null && b.gz != null) {
        let m = 0;
        if (roadCells.has(`${b.gx},${b.gz - 1}`)) m |= 1;
        if (roadCells.has(`${b.gx + 1},${b.gz}`)) m |= 2;
        if (roadCells.has(`${b.gx},${b.gz + 1}`)) m |= 4;
        if (roadCells.has(`${b.gx - 1},${b.gz}`)) m |= 8;
        roadMask = m;
      }
      const { group, lights } = makeBuilding(b.type, b.seed, b.level ?? 1, w, h, onSquare, roadMask);
      let pos: THREE.Vector3;
      if (onSquare) {
        // 方岛：按网格坐标落位；缺少坐标（理论上不会）则就地打包补上
        if (b.gx == null || b.gz == null) {
          const spot = firstFreeCell(state, w, h);
          if (spot) {
            b.gx = spot.gx;
            b.gz = spot.gz;
          }
        }
        const gx = b.gx ?? 0;
        const gz = b.gz ?? 0;
        const c = footprintCenter(gx, gz, w, h);
        pos = new THREE.Vector3(c.x, 0, c.z);
        group.rotation.y = (b.rot ?? 0) * (Math.PI / 2);
      } else {
        pos = buildingPos(i);
        group.lookAt(0, group.position.y, 0);
        group.rotation.x = 0;
        group.rotation.z = 0;
      }
      group.position.copy(pos);
      // 标注建筑在 buildings 数组中的下标，供点击拾取回溯到具体建筑
      group.userData.buildingId = i;
      this.root.add(group);
      this.shadowAt(pos.x, pos.z, Math.max(w, h) * 0.95);
      this.built.set(b.id, group);
      // 新建的建筑弹一下：从 0.72 放大到 1（重建时会整体重弹一次，可接受）
      group.scale.setScalar(0.72);
      this.pops.push({ obj: group, t: 0 });
      // 建筑可拾取：拆除模式下射线命中后能回溯到具体建筑（factory 同样处理）
      this.pickables.push(group);
      this.windowLights.push(...lights);
    });

    for (const [id, group] of this.built) {
      if (seen.has(id)) continue;
      this.root.remove(group);
      const pi = this.pickables.indexOf(group);
      if (pi >= 0) this.pickables.splice(pi, 1);
      this.built.delete(id);
    }
  }

  /** 某栋建筑外观变了（如升级），摘掉旧模型，下一轮 sync 会用新等级重建 */
  refreshBuilding(id: string): void {
    const g = this.built.get(id);
    if (!g) return;
    const pi = this.pickables.indexOf(g);
    if (pi >= 0) this.pickables.splice(pi, 1);
    this.root.remove(g);
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as unknown as { material?: THREE.Material | THREE.Material[] }).material;
      if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
    });
    this.built.delete(id);
  }

  private syncFactories(state: GameState): void {
    const seen = new Set<string>();
    const onSquare = this.islandShape === 'square';
    state.factories.forEach((f, i) => {
      const id = `f_${f.type}`;
      seen.add(id);
      if (this.factories.has(id)) return;
      const { group, lights, chimneyTop } = makeFactory(f.type, i * 104729 + 7);
      const pos = this.factoryWorldPos(f, i, state);
      group.position.copy(pos);
      if (onSquare) {
        // 方岛：缩放到 2×2 网格占地
        const fw = (2 * CELL * 0.84) / 1.5;
        const fd = (2 * CELL * 0.84) / 1.4;
        group.scale.set(fw, 1, fd);
        group.rotation.y = 0;
      } else {
        // 面朝岛外：前缘工厂背靠岛边，正对默认镜头，雨棚不被任何建筑遮挡
        group.lookAt(pos.x * 2, pos.y, pos.z * 2);
        group.rotation.x = 0;
        group.rotation.z = 0;
      }
      group.userData.factoryIndex = i;

      // 气泡挂在工厂里，跟着工厂一起摆位；有烟囱就从烟囱口冒
      const bubbles = new Bubbles(
        { origin: chimneyTop, count: 4, spread: 0.11 },
        i * 7919 + 31,
      );
      group.add(bubbles.group);
      this.bubbles.set(id, bubbles);

      this.root.add(group);
      this.shadowAt(group.position.x, group.position.z, 1.25);
      this.pickables.push(group);
      this.factories.set(id, group);
      this.windowLights.push(...lights);
    });

    for (const [id, group] of this.factories) {
      if (seen.has(id)) continue;
      this.root.remove(group);
      this.factories.delete(id);
      this.bubbles.get(id)?.dispose();
      this.bubbles.delete(id);
      const idx = this.pickables.indexOf(group);
      if (idx >= 0) this.pickables.splice(idx, 1);
    }
  }

  /** 根据生产状态驱动气泡：开工就冒，有产出待收取则变金色 */
  private updateBubbles(state: GameState, now: number, dt: number): void {
    for (const f of state.factories) {
      const id = `f_${f.type}`;
      const bubbles = this.bubbles.get(id);
      if (!bubbles) continue;

      const running = f.slots.some((s) => s.recipe);
      const ready = f.slots.some((s) => s.recipe && s.readyAt <= now);

      bubbles.setActive(running);
      if (running) bubbles.setColor(ready ? BUBBLE_READY : BUBBLE_RUNNING);
      bubbles.update(dt);
    }
  }

  /** 每帧：只改 scale / visible / 位置，不重建几何体 */
  update(state: GameState, now: number, dt: number, lowSpec = false): void {
    for (let i = 0; i < state.plots.length; i++) {
      const plot = state.plots[i];
      const slot = this.crops[i];
      if (!slot || !plot.crop) continue;

      slot.mesh.stem.scale.setScalar(growthScale(plotProgress(plot, now)));

      const ripe = isRipe(plot, now);
      for (const f of slot.mesh.fruits) f.visible = ripe;
      if (ripe) {
        slot.mesh.group.position.y = 0.07 + Math.sin(now / 320 + i) * 0.025;
      }

      this.setRipeRing(i, ripe);
    }

    this.bob += dt;
    // 落成的回弹动画（easeOutBack）：0.3 秒内从 0.72 放大到 1，略微冲过头再收回
    if (this.pops.length > 0) {
      const c1 = 1.25;
      const c3 = c1 + 1;
      for (let i = this.pops.length - 1; i >= 0; i--) {
        const p = this.pops[i];
        p.t += Math.max(0, dt);
        // 进度与缩放都夹紧：即便外部传进异常 dt，也不会把建筑放大成怪物
        const k = Math.min(1, Math.max(0, p.t / 0.3));
        const e = k >= 1 ? 1 : 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
        p.obj.scale.setScalar(Math.min(1.12, Math.max(0.7, 0.72 + 0.28 * e)));
        if (k >= 1) {
          p.obj.scale.setScalar(1);
          this.pops.splice(i, 1);
        }
      }
    }
    for (const c of this.clouds) {
      c.userData.orbit += c.userData.speed * dt * 0.06;
      const r = c.userData.radius;
      c.position.x = Math.cos(c.userData.orbit) * r;
      c.position.z = Math.sin(c.userData.orbit) * r;
    }

    this.updateBubbles(state, now, dt);

    // 植被随风轻摆：树冠/草丛/作物给一点正弦旋转，错相位避免整齐划一
    for (const s of this.swayers) {
      const a = Math.sin(this.bob * s.speed + s.phase) * s.amp;
      s.obj.rotation.z = a;
      s.obj.rotation.x = Math.cos(this.bob * s.speed * 0.8 + s.phase) * s.amp * 0.5;
    }

    // 池塘：水面起伏 + 扩散水波 + 中心喷泉，静态水景也活起来
    if (this.pond) {
      const ud = this.pond.userData;
      if (ud.water) {
        const w = ud.water as THREE.Mesh;
        const base = ud.waterBaseY as number;
        w.position.y = base + Math.sin(this.bob * 0.8) * 0.012;
      }
      const ripples = ud.ripples as THREE.Mesh[] | undefined;
      if (ripples) {
        const cyc = 4.5; // 每个波环的周期（秒）
        for (let i = 0; i < ripples.length; i++) {
          const p = (((this.bob * 0.45) + (i * cyc) / ripples.length) % cyc) / cyc;
          const scale = 0.4 + p * 4.2;
          ripples[i].scale.set(scale, scale, scale);
          (ripples[i].material as THREE.MeshBasicMaterial).opacity = (1 - p) * 0.32;
        }
      }
      const f = ud.fountain as
        | { points: THREE.Points; pos: Float32Array; vel: Float32Array; n: number; baseY: number; spawn: (i: number) => void }
        | undefined;
      if (f) {
        const g = 3.0 * dt; // 重力
        for (let i = 0; i < f.n; i++) {
          f.vel[i * 3 + 1] -= g;
          f.pos[i * 3] += f.vel[i * 3] * dt;
          f.pos[i * 3 + 1] += f.vel[i * 3 + 1] * dt;
          f.pos[i * 3 + 2] += f.vel[i * 3 + 2] * dt;
          if (f.pos[i * 3 + 1] < f.baseY) f.spawn(i);
        }
        (f.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      }
    }

    // 省电模式下降低居民更新频率，省一点是一点
    if (lowSpec) {
      this.agentTick = (this.agentTick ?? 0) + dt;
      if (this.agentTick >= 0.05) {
        this.agents.update(this.agentTick);
        this.agentTick = 0;
      }
    } else {
      this.agents.update(dt);
    }
  }

  private agentTick = 0;

  private setRipeRing(i: number, ripe: boolean): void {
    const has = this.ripeRings[i];
    if (ripe && !has) {
      const ring = makePlotRing(1.05, 0xffd166);
      ring.position.copy(plotPosition(i, this.islandShape));
      ring.position.y = 0.09;
      this.root.add(ring);
      this.ripeRings[i] = ring;
    } else if (!ripe && has) {
      this.root.remove(has);
      this.ripeRings[i] = null as unknown as THREE.Mesh;
    }
  }

  /** 所有可点击对象：地块、工厂，以及走动中的居民 */
  get allPickables(): THREE.Object3D[] {
    return [...this.pickables, ...this.agents.hitTargets];
  }

  agentPosition(id: number): THREE.Vector3 | null {
    return this.agents.positionOf(id);
  }

  /** 岛屿内容的世界包围盒（排除天上的云朵），用于「最佳视图」动态贴合 */
  fitBox(): THREE.Box3 {
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    for (const child of this.root.children) {
      if (child.userData && child.userData.orbit !== undefined) continue; // 云不计入
      tmp.setFromObject(child);
      if (tmp.isEmpty()) continue;
      // 浮岛水下底盘延伸到 y<0，正常看不到，钳到地面避免把镜头拉远
      if (tmp.min.y < 0) tmp.min.y = 0;
      box.union(tmp);
    }
    return box;
  }

  /** 农民头顶位置，用于点击说话的气泡锚点 */
  farmerPosition(id: number): THREE.Vector3 | null {
    return this.agents.positionOf(id);
  }

  /** 随机一个居民的 id，用于自动闲聊 */
  randomAgentId(): number | null {
    return this.agents.randomId();
  }

  setHover(plotIndex: number | null): void {
    if (plotIndex === null) {
      this.hoverRing.visible = false;
      return;
    }
    this.hoverRing.visible = true;
    this.hoverRing.position.copy(plotPosition(plotIndex, this.islandShape));
    this.hoverRing.position.y = 0.1;
  }

  /**
   * 进入放置预览：按 w×h 占地造一个半透明预览体，跟随光标在格子上移动。
   * 工厂在方岛是 2×2，需要额外缩放到网格占地（与 syncFactories 一致）。
   */
  beginPlacement(type: BuildingType | FactoryType, isFactory: boolean, w: number, h: number): void {
    this.clearGhost();
    this.ghostW = w;
    this.ghostH = h;
    const mesh = isFactory
      ? makeFactory(type as FactoryType, 104729)
      : makeBuilding(type as BuildingType, 104729, 1, w, h, true);
    const g = mesh.group;
    if (isFactory) {
      const fw = (2 * CELL * 0.84) / 1.5;
      const fd = (2 * CELL * 0.84) / 1.4;
      g.scale.set(fw, 1, fd);
    }
    this.ghostMats = [];
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.material) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const clones = mats.map((mm) => mm.clone());
      m.material = Array.isArray(m.material) ? clones : clones[0];
      for (const c of clones) {
        if (c instanceof THREE.MeshStandardMaterial) {
          c.transparent = true;
          c.opacity = 0.6;
          c.depthWrite = false;
          this.ghostMats.push(c);
        }
      }
      m.castShadow = false;
    });
    this.ghost = g;
    this.root.add(g);
  }

  /** 把预览体移到 (gx,gz) 锚点格，并按可放性染绿/红。 */
  moveGhost(gx: number, gz: number, valid: boolean): void {
    if (!this.ghost) return;
    const c = footprintCenter(gx, gz, this.ghostW, this.ghostH);
    this.ghost.position.set(c.x, 0, c.z);
    const hex = valid ? 0x4fd16b : 0xe0584f;
    for (const m of this.ghostMats) m.emissive.setHex(hex);
  }

  /** 退出放置预览，移除预览体。 */
  clearGhost(): void {
    if (this.ghost) {
      this.root.remove(this.ghost);
      this.ghost.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = (m as unknown as { material?: THREE.Material | THREE.Material[] }).material;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
      });
      this.ghost = null;
    }
    this.ghostMats = [];
  }

  /** 昼夜：夜间点亮窗户、压暗环境光 */
  applyTimeOfDay(isNight: boolean): void {
    // 夜里居民往家走，白天出门——换班时立刻重选目标
    this.agents.setNight(isNight);
    const intensity = isNight ? 1.15 : 0;
    for (const m of this.windowLights) {
      m.emissive = new THREE.Color(0xffd98a);
      m.emissiveIntensity = intensity;
    }
    // 路灯：夜里更亮一点，衬出"小镇有人住"的感觉
    for (const m of this.lampLights) {
      m.emissive = new THREE.Color(0xffd070);
      m.emissiveIntensity = isNight ? 1.7 : 0;
    }
  }

  worldToScreen(v: THREE.Vector3, camera: THREE.Camera, canvas: HTMLCanvasElement): { x: number; y: number } {
    const p = v.clone().project(camera);
    return {
      x: ((p.x + 1) / 2) * canvas.clientWidth,
      y: ((-p.y + 1) / 2) * canvas.clientHeight,
    };
  }
}
