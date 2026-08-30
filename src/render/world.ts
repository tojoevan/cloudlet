import * as THREE from 'three';
import type { BuildingType, FactoryType, GameState, IslandShape } from '../core/types';
import { GRID_COLS, PLOT_COUNT } from '../core/state';
import { activeIslandMeta, CELL, SQUARE_N } from '../core/island';
import { cellToWorld, footprintCenter, firstFreeCell, squarePlotCell } from '../core/grid';
import { populationOf } from '../core/economy';
import { Agents, WORKER_RADIUS } from './agents';
import { Bubbles, BUBBLE_READY, BUBBLE_RUNNING } from './bubbles';
import { makeCrop, growthScale, type CropMesh } from './meshes/crops';
import { makeBuilding, makeFactory } from './meshes/structures';
import {
  makeCloud,
  makeGrassTuft,
  makeIsland,
  makeSquareIsland,
  makePlot,
  makePlotRing,
  makePond,
  makeRock,
  makeTree,
} from './meshes/terrain';
import { ISLAND_RADIUS } from './palette';
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
 */
export function plotPosition(index: number): THREE.Vector3 {
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
  private factories = new Map<string, THREE.Group>();
  /** 工厂头顶的运转气泡，与工厂一一对应 */
  private bubbles = new Map<string, Bubbles>();
  private clouds: THREE.Group[] = [];
  private hoverRing: THREE.Mesh;
  private ripeRings: THREE.Mesh[] = [];
  private windowLights: THREE.MeshStandardMaterial[] = [];
  private bob = 0;
  private pond: THREE.Group | null = null;
  private lowSpec = false;
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
    if (state) this.islandShape = activeIslandMeta(state).shape;
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
    this.swayers = [];
    this.plotTiles = [];
    this.pickables = [];
    this.gridCells = [];
    this.clearGhost();
  }

  private buildTerrain(): void {
    if (this.islandShape === 'square') {
      this.buildIslandSquare();
      this.decorateSquare();
    } else {
      this.buildIsland(this.islandRadius);
      this.decorateRound();
    }
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

    // 云：绕岛缓慢漂移，让静止画面也有呼吸感
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
      tile.position.copy(plotPosition(i));
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
    this.syncCrops(state);
    this.syncBuildings(state);
    this.syncFactories(state);
    this.agents.sync(populationOf(state), lowSpec);
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
      const pos =
        this.islandShape === 'square'
          ? (() => {
              const c = squarePlotCell(i);
              const w = cellToWorld(c.gx, c.gz);
              return new THREE.Vector3(w.x, 0.07, w.z);
            })()
          : plotPosition(i);
      mesh.group.position.copy(pos);
      this.root.add(mesh.group);
      this.crops[i] = { mesh, crop: wantCrop };
      this.swayers.push({ obj: mesh.group, phase: (i * 1.3) % (Math.PI * 2), amp: 0.07, speed: 2.0 });
    }
  }

  private syncBuildings(state: GameState): void {
    const seen = new Set<string>();
    const onSquare = this.islandShape === 'square';
    state.buildings.forEach((b, i) => {
      seen.add(b.id);
      if (this.built.has(b.id)) return;
      const w = b.w ?? 1;
      const h = b.h ?? 1;
      const { group, lights } = makeBuilding(b.type, b.seed, b.level ?? 1, w, h, onSquare);
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
      this.root.add(group);
      this.built.set(b.id, group);
      this.windowLights.push(...lights);
    });

    for (const [id, group] of this.built) {
      if (seen.has(id)) continue;
      this.root.remove(group);
      this.built.delete(id);
    }
  }

  /** 某栋建筑外观变了（如升级），摘掉旧模型，下一轮 sync 会用新等级重建 */
  refreshBuilding(id: string): void {
    const g = this.built.get(id);
    if (!g) return;
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
      ring.position.copy(plotPosition(i));
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
    this.hoverRing.position.copy(plotPosition(plotIndex));
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
    const intensity = isNight ? 0.85 : 0;
    for (const m of this.windowLights) {
      m.emissive = new THREE.Color(0xffd98a);
      m.emissiveIntensity = intensity;
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
