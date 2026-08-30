import * as THREE from 'three';
import type { GameState } from '../core/types';
import { GRID_COLS, PLOT_COUNT } from '../core/state';
import { populationOf } from '../core/economy';
import { Agents, WORKER_RADIUS } from './agents';
import { Bubbles, BUBBLE_READY, BUBBLE_RUNNING } from './bubbles';
import { makeCrop, growthScale, type CropMesh } from './meshes/crops';
import { makeBuilding, makeFactory } from './meshes/structures';
import {
  makeCloud,
  makeGrassTuft,
  makeIsland,
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

/** 建筑沿岛后半圈排布，把前半留给农田 */
function buildingPos(i: number): THREE.Vector3 {
  const ring = Math.floor(i / 10);
  const idx = i % 10;
  const a = -Math.PI * 0.86 + (idx / 10) * Math.PI * 0.78;
  const r = 4.4 + ring * 1.9;
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
  readonly root = new THREE.Group();
  readonly plotTiles: THREE.Mesh[] = [];
  readonly pickables: THREE.Object3D[] = [];

  private crops: ({ mesh: CropMesh; crop: string } | null)[] = [];
  private built = new Map<string, THREE.Group>();
  private factories = new Map<string, THREE.Group>();
  /** 工厂头顶的运转气泡，与工厂一一对应 */
  private bubbles = new Map<string, Bubbles>();
  private clouds: THREE.Group[] = [];
  private hoverRing: THREE.Mesh;
  private ripeRings: THREE.Mesh[] = [];
  private windowLights: THREE.MeshStandardMaterial[] = [];
  private bob = 0;
  private pond: THREE.Group | null = null;
  private agents = new Agents();

  constructor(scene: THREE.Scene) {
    scene.add(this.root);
    this.root.add(this.agents.root);
    this.buildTerrain();
    this.buildFarm();

    this.hoverRing = makePlotRing(1.0, 0xffffff);
    this.hoverRing.visible = false;
    this.root.add(this.hoverRing);
  }

  private buildTerrain(): void {
    this.root.add(makeIsland());

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
      const p = factoryPos(i);
      // 朝岛心方向偏移 1.8，把工人放到厂房和岛心之间的草地上
      const inward = new THREE.Vector2(-p.x, -p.z).normalize().multiplyScalar(1.8);
      ranchCenter = new THREE.Vector2(p.x, p.z).add(inward);
    });
    if (ranchCenter) this.agents.syncWorker('ranch', ranchCenter, WORKER_RADIUS);
    void now;
  }

  private syncCrops(state: GameState): void {
    for (let i = 0; i < state.plots.length; i++) {
      const plot = state.plots[i];
      const slot = this.crops[i];
      const wantCrop = plot.crop;

      if (!wantCrop) {
        if (slot) {
          this.root.remove(slot.mesh.group);
          this.crops[i] = null;
        }
        continue;
      }
      if (slot && slot.crop === wantCrop) continue;
      if (slot) this.root.remove(slot.mesh.group);

      const mesh = makeCrop(wantCrop, i * 7919 + 13);
      mesh.group.position.copy(plotPosition(i));
      mesh.group.position.y = 0.07;
      this.root.add(mesh.group);
      this.crops[i] = { mesh, crop: wantCrop };
    }
  }

  private syncBuildings(state: GameState): void {
    const seen = new Set<string>();
    state.buildings.forEach((b, i) => {
      seen.add(b.id);
      if (this.built.has(b.id)) return;
      const { group, lights } = makeBuilding(b.type, b.seed);
      group.position.copy(buildingPos(i));
      // 面朝岛心
      group.lookAt(0, group.position.y, 0);
      group.rotation.x = 0;
      group.rotation.z = 0;
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

  private syncFactories(state: GameState): void {
    const seen = new Set<string>();
    state.factories.forEach((f, i) => {
      const id = `f_${f.type}`;
      seen.add(id);
      if (this.factories.has(id)) return;
      const { group, lights, chimneyTop } = makeFactory(f.type, i * 104729 + 7);
      group.position.copy(factoryPos(i));
      // 面朝岛外：前缘工厂背靠岛边，正对默认镜头，雨棚不被任何建筑遮挡
      group.lookAt(group.position.x * 2, group.position.y, group.position.z * 2);
      group.rotation.x = 0;
      group.rotation.z = 0;
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

    // 池塘水面轻轻起伏，静态水景也有呼吸感
    if (this.pond?.userData.water) {
      const w = this.pond.userData.water as THREE.Mesh;
      const base = this.pond.userData.waterBaseY as number;
      w.position.y = base + Math.sin(this.bob * 0.8) * 0.012;
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
