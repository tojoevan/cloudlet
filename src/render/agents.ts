import * as THREE from 'three';
import { mat } from './mat';
import { getShirts } from './palette';
import { mulberry32, range } from './rng';
import { cellToWorld } from '../core/grid';

const ISLAND_WALK_RADIUS = 7.6;
/** 农田中心，小人绕着走，别踩进地里 */
const FARM = new THREE.Vector2(-3.4, 3.3);
// 与 world.ts 的 POND 保持一致，让居民绕开水塘
const POND = new THREE.Vector2(2.0, 2.5);
const POND_KEEPOUT = 1.8;
/** 农民的活动半径：罩住矩形农田，绕着田块巡视 */
const FARM_RADIUS = 2.6;
/** 厂区工人的活动半径：在自家工厂旁转悠，别跑远 */
export const WORKER_RADIUS = 1.5;

const SKINS = [0xf2d0b8, 0xe8b894, 0xd9a273];

interface Person {
  id: number;
  mesh: THREE.Group;
  /** 不可见的点击体。居民本身太小，直接点太难了 */
  hit: THREE.Mesh;
  pos: THREE.Vector2;
  dir: THREE.Vector2;
  target: THREE.Vector2;
  speed: number;
  phase: number;
  pauseFor: number;
  /** 巡逻中心。农民是农田，伐木工是树林，厂区工人是自家工厂 */
  home: THREE.Vector2;
  /** 巡视半径：农民≈农田，伐木工≈树林，厂区工人≈厂房旁 */
  radius: number;
}

function makePerson(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();

  const shirts = getShirts();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 0.26, 6), mat(shirts[Math.floor(rng() * shirts.length)]));
  body.position.y = 0.13;
  body.castShadow = true;
  g.add(body);

  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.095, 0), mat(SKINS[Math.floor(rng() * SKINS.length)]));
  head.position.y = 0.34;
  head.castShadow = true;
  g.add(head);

  g.scale.setScalar(range(rng, 0.9, 1.12));
  return g;
}

/**
 * 专职农民：和居民区分开——草帽 + 绿背带裤，一眼就知道是下地干活的。
 * 行为也不同：只在农田里转，走走停停像在打理，不会满岛乱逛。
 */
function makeFarmer(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 0.26, 6), mat(0x4f772d));
  body.position.y = 0.13;
  body.castShadow = true;
  g.add(body);

  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.095, 0), mat(SKINS[Math.floor(rng() * SKINS.length)]));
  head.position.y = 0.34;
  head.castShadow = true;
  g.add(head);

  // 草帽：宽檐 + 帽顶，辨识度拉满
  const hatMat = mat(0xd9b15a);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.05, 8), hatMat);
  brim.position.y = 0.43;
  brim.castShadow = true;
  g.add(brim);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.1, 8), hatMat);
  top.position.y = 0.485;
  top.castShadow = true;
  g.add(top);

  g.scale.setScalar(1.05);
  return g;
}

/**
 * 厂区工人（伐木工 / 农场工）：和农民一个路数——专属外观 + 在自家工厂旁巡视打理。
 * 伐木工扛把斧，农场工戴牛仔帽，一眼和居民、农民都分得开。
 */
function makeWorker(kind: 'lumber' | 'ranch', seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const shirt = kind === 'lumber' ? 0xb33b3b : 0x8a6d3b;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 0.26, 6), mat(shirt));
  body.position.y = 0.13;
  body.castShadow = true;
  g.add(body);

  const head = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.095, 0),
    mat(SKINS[Math.floor(rng() * SKINS.length)]),
  );
  head.position.y = 0.34;
  head.castShadow = true;
  g.add(head);

  if (kind === 'lumber') {
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.32, 5), mat(0x6e4a2f));
    handle.position.set(0.13, 0.2, 0);
    handle.rotation.z = 0.5;
    g.add(handle);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.03), mat(0x9aa3ad));
    blade.position.set(0.2, 0.32, 0);
    g.add(blade);
  } else {
    const hatMat = mat(0x6e4a2f);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.05, 8), hatMat);
    brim.position.y = 0.43;
    brim.castShadow = true;
    g.add(brim);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.11, 0.12, 8), hatMat);
    top.position.y = 0.5;
    top.castShadow = true;
    g.add(top);
  }

  g.scale.setScalar(1.05);
  return g;
}

/**
 * 居民在岛上闲逛。纯视觉层，不参与任何玩法计算——
 * 作用是让静止的画面有呼吸感，挂机时像个活着的小镇。
 */
/** 居民会去的地方：家 / 广场 / 农田 / 工厂 */
export interface AgentSpot {
  kind: 'home' | 'plaza' | 'farm' | 'factory';
  x: number;
  z: number;
}

export class Agents {
  readonly root = new THREE.Group();
  private people: Person[] = [];
  private farmer: Person | null = null;
  private lumber: Person | null = null;
  private ranch: Person | null = null;
  private nextId = 1;
  /** 当前岛形态：圆岛用极坐标漫步，方岛在方格范围内走、并偏好道路 */
  private shape: 'round' | 'square' = 'round';
  private squareHalf = 7.6;
  private roadCells: { gx: number; gz: number }[] = [];
  /** 目的地池：让居民有去处，而不是纯随机漫步 */
  private spots: AgentSpot[] = [];
  private night = false;

  /** 切换岛屿时由 World 调用，告知居民新的活动范围与道路网格 */
  configure(shape: 'round' | 'square', half: number, roadCells: { gx: number; gz: number }[]): void {
    this.shape = shape;
    this.squareHalf = half;
    this.roadCells = roadCells;
  }

  /**
   * 设置目的地池。World 在建筑/工厂/广场变化时调用。
   * 居民的行为因此从「随机漫步」变成「有去处」——这是小镇看起来"活的"的关键。
   */
  setSpots(spots: AgentSpot[]): void {
    this.spots = spots;
  }

  /** 昼夜换班：夜里往家走，白天出门 */
  setNight(night: boolean): void {
    if (night === this.night) return;
    this.night = night;
    for (const p of this.people) this.newTarget(p);
  }

  /** 按昼夜挑一个偏好目的地 */
  private pickSpot(): AgentSpot | null {
    if (this.spots.length === 0) return null;
    const pref = this.night
      ? this.spots.filter((s) => s.kind === 'home')
      : this.spots.filter((s) => s.kind !== 'home');
    const pool = pref.length > 0 ? pref : this.spots;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** 射线检测用。居民在移动，所以每次取都要现算 */
  get hitTargets(): THREE.Object3D[] {
    const list = this.people.map((p) => p.hit);
    if (this.farmer) list.push(this.farmer.hit);
    if (this.lumber) list.push(this.lumber.hit);
    if (this.ranch) list.push(this.ranch.hit);
    return list;
  }

  /** 随机挑一个居民用于自动闲聊。岛上没人时返回 null（农民不算，他不自动闲聊） */
  randomId(): number | null {
    if (this.people.length === 0) return null;
    return this.people[Math.floor(Math.random() * this.people.length)].id;
  }

  /** 气泡锚点：头顶偏上一点 */
  positionOf(id: number): THREE.Vector3 | null {
    const p =
      this.people.find((x) => x.id === id) ??
      (this.farmer?.id === id ? this.farmer : null) ??
      (this.lumber?.id === id ? this.lumber : null) ??
      (this.ranch?.id === id ? this.ranch : null);
    if (!p) return null;
    return new THREE.Vector3(p.mesh.position.x, 0.72, p.mesh.position.z);
  }

  /** 保证有且只有一名专职农民在田里。农民不随人口增减，始终在 */
  syncFarmer(): void {
    if (this.farmer) return;
    const seed = 91173;
    const mesh = makeFarmer(seed);

    // 点击体同样不可见，且用 farmerId 区分于居民的 agentId
    const hit = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 1.15, 6),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    hit.position.y = 0.55;
    const id = this.nextId++;
    hit.userData.farmerId = id;
    mesh.add(hit);

    const p: Person = {
      id,
      mesh,
      hit,
      pos: FARM.clone(),
      dir: new THREE.Vector2(1, 0),
      target: FARM.clone(),
      speed: 0,
      phase: 0,
      pauseFor: 0,
      home: FARM.clone(),
      radius: FARM_RADIUS,
    };
    this.patrolTarget(p, FARM, FARM_RADIUS);
    mesh.position.set(p.pos.x, 0, p.pos.y);
    this.root.add(mesh);
    this.farmer = p;
  }

  /** 保证某类厂区工人存在（建了对应工厂才有），并把巡逻中心设到工厂旁 */
  syncWorker(kind: 'lumber' | 'ranch', center: THREE.Vector2, radius: number): void {
    const existing = kind === 'lumber' ? this.lumber : this.ranch;
    if (existing) {
      existing.home.copy(center);
      return;
    }
    const seed = kind === 'lumber' ? 41717 : 82731;
    const mesh = makeWorker(kind, seed);
    const hit = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 1.15, 6),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    hit.position.y = 0.55;
    const id = this.nextId++;
    hit.userData[kind === 'lumber' ? 'lumberId' : 'ranchId'] = id;
    mesh.add(hit);

    const p: Person = {
      id,
      mesh,
      hit,
      pos: center.clone(),
      dir: new THREE.Vector2(1, 0),
      target: center.clone(),
      speed: 0,
      phase: 0,
      pauseFor: 0,
      home: center.clone(),
      radius,
    };
    this.patrolTarget(p, center, radius);
    mesh.position.set(p.pos.x, 0, p.pos.y);
    this.root.add(mesh);
    if (kind === 'lumber') this.lumber = p;
    else this.ranch = p;
  }

  /** 按人口调整人数。人口越多街上越热闹。 */
  sync(population: number, lowSpec: boolean): void {
    const per = lowSpec ? 8 : 4;
    const cap = lowSpec ? 6 : 14;
    const want = Math.min(cap, Math.floor(population / per));

    while (this.people.length < want) {
      const seed = (this.people.length + 1) * 2654435761;
      const mesh = makePerson(seed);

      // opacity 0 而不是 visible=false：不可见对象不保证还能被射线命中
      const hit = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.4, 1.15, 6),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      );
      hit.position.y = 0.55;
      const id = this.nextId++;
      hit.userData.agentId = id;
      mesh.add(hit);

      const p: Person = {
        id,
        mesh,
        hit,
        pos: new THREE.Vector2(0, 0),
        dir: new THREE.Vector2(1, 0),
        target: new THREE.Vector2(0, 0),
        speed: 0,
        phase: 0,
        pauseFor: 0,
        home: new THREE.Vector2(0, 0),
        radius: 0,
      };
      const rng = mulberry32(seed);
      const a = rng() * Math.PI * 2;
      const r = range(rng, 2, 6);
      p.pos.set(Math.cos(a) * r, Math.sin(a) * r);
      this.newTarget(p, rng);
      mesh.position.set(p.pos.x, 0, p.pos.y);
      this.root.add(mesh);
      this.people.push(p);
    }

    while (this.people.length > want) {
      const p = this.people.pop();
      if (p) this.root.remove(p.mesh);
    }
  }

  private newTarget(p: Person, rng: () => number = Math.random): void {
    // 有目的地就去目的地附近（带一点随机偏移，避免所有人叠在同一个点）
    const spot = this.pickSpot();
    if (spot) {
      p.target.set(spot.x + (rng() - 0.5) * 0.9, spot.z + (rng() - 0.5) * 0.9);
      p.speed = range(rng, 0.32, 0.62);
      // 到了目的地会多停一会儿：像真的在办事/聊天
      p.pauseFor = rng() < 0.55 ? range(rng, 1.6, 5.5) : 0;
      this.faceTarget(p);
      return;
    }
    if (this.shape === 'square') {
      let x: number;
      let z: number;
      // 有道路就优先沿路走，让散步有「规划感」
      if (this.roadCells.length > 0 && rng() < 0.6) {
        const c = this.roadCells[Math.floor(rng() * this.roadCells.length)];
        const w = cellToWorld(c.gx, c.gz);
        x = w.x;
        z = w.z;
      } else {
        const h = this.squareHalf - 0.5;
        x = range(rng, -h, h);
        z = range(rng, -h, h);
      }
      p.target.set(x, z);
      p.speed = range(rng, 0.35, 0.75);
      p.pauseFor = rng() < 0.35 ? range(rng, 1.5, 5) : 0;
      this.faceTarget(p);
      return;
    }
    for (let i = 0; i < 12; i++) {
      const a = rng() * Math.PI * 2;
      const r = range(rng, 1.6, ISLAND_WALK_RADIUS);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      // 农田可自由进入（农民要进去打理）；只绕开水池，别走到岛外
      if (Math.hypot(x - POND.x, z - POND.y) < POND_KEEPOUT) continue;
      p.target.set(x, z);
      p.speed = range(rng, 0.35, 0.75);
      p.pauseFor = rng() < 0.35 ? range(rng, 1.5, 5) : 0;
      this.faceTarget(p);
      return;
    }
    p.target.set(0, 0);
    p.speed = 0.4;
    this.faceTarget(p);
  }

  private faceTarget(p: Person): void {
    const d = p.target.clone().sub(p.pos);
    if (d.lengthSq() < 1e-6) return;
    p.dir.copy(d).normalize();
  }

  /**
   * 每帧把候选落点推出水池禁区。这样即使「当前点→目标点」的连线
   * 穿过水池，小人也只会沿水塘边缘绕行，而不会笔直穿过去。
   * 农田不阻挡，农民需要进去打理。
   */
  private pushOut(pos: THREE.Vector2): void {
    const dp = pos.clone().sub(POND);
    const pl = dp.length();
    if (pl < POND_KEEPOUT) {
      if (pl < 1e-6) dp.set(1, 0);
      else dp.setLength(POND_KEEPOUT + 0.02);
      pos.copy(POND).add(dp);
    }
  }

  /** 在给定中心周围巡逻打理：大部分时候走到外围，偶尔去中心转一圈 */
  private patrolTarget(p: Person, center: THREE.Vector2, radius: number): void {
    const rng = Math.random;
    if (rng() < 0.7) {
      const a = rng() * Math.PI * 2;
      const r = 0.5 + rng() * (radius - 0.5);
      p.target.set(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r);
    } else {
      const a = rng() * Math.PI * 2;
      const r = rng() * 0.8;
      p.target.set(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r);
    }
    p.speed = 0.3 + rng() * 0.25;
    p.pauseFor = rng() < 0.6 ? 1.5 + rng() * 3 : 0;
    this.faceTarget(p);
  }

  update(dt: number): void {
    for (const p of this.people) {
      const moving = p.pauseFor <= 0;
      if (!moving) {
        // 站着聊会儿天：轻微呼吸缩放，避免全员匀速巡逻的机械感
        p.pauseFor -= dt;
        p.phase += dt * 2.2;
        p.mesh.position.set(p.pos.x, 0, p.pos.y);
        p.mesh.scale.y = 1 + Math.sin(p.phase) * 0.03;
        p.mesh.rotation.z = 0;
        continue;
      }

      const step = p.speed * dt;
      p.pos.addScaledVector(p.dir, step);
      this.pushOut(p.pos);

      if (p.pos.distanceTo(p.target) < 0.16) {
        this.newTarget(p);
      } else if (this.shape === 'square') {
        const h = this.squareHalf - 0.5;
        if (Math.abs(p.pos.x) > h || Math.abs(p.pos.y) > h) {
          p.target.set(range(Math.random, -h, h), range(Math.random, -h, h));
          this.faceTarget(p);
        }
      } else if (p.pos.length() > ISLAND_WALK_RADIUS) {
        // 兜底：万一走出边界就掉头回岛心
        p.target.set(0, 0);
        this.faceTarget(p);
      }

      p.mesh.position.set(p.pos.x, 0, p.pos.y);
      if (p.dir.lengthSq() > 1e-6) p.mesh.rotation.y = Math.atan2(p.dir.x, p.dir.y);

      // 走路：上下小颠 + 左右轻摆，比单纯上下更有生命力
      p.phase += dt * 9;
      p.mesh.position.y = Math.sin(p.phase) * 0.03 + 0.015;
      p.mesh.rotation.z = Math.sin(p.phase) * 0.09;
      p.mesh.scale.y = 1;
    }

    // 农民与厂区工人：都在各自 home 周围巡视打理
    for (const w of [this.farmer, this.lumber, this.ranch]) {
      if (!w) continue;
      const radius = w.radius;
      const moving = w.pauseFor <= 0;
      if (!moving) {
        w.pauseFor -= dt;
        w.phase += dt * 2.2;
        w.mesh.position.set(w.pos.x, 0, w.pos.y);
        w.mesh.scale.y = 1 + Math.sin(w.phase) * 0.03;
        w.mesh.rotation.z = 0;
        continue;
      }
      const step = w.speed * dt;
      w.pos.addScaledVector(w.dir, step);
      this.pushOut(w.pos);

      if (w.pos.distanceTo(w.target) < 0.16) {
        this.patrolTarget(w, w.home, radius);
      } else if (w.pos.distanceTo(w.home) > radius) {
        // 兜底：别走出活动范围
        w.target.copy(w.home);
        this.faceTarget(w);
      }

      w.mesh.position.set(w.pos.x, 0, w.pos.y);
      if (w.dir.lengthSq() > 1e-6) w.mesh.rotation.y = Math.atan2(w.dir.x, w.dir.y);

      // 同款走路摆动
      w.phase += dt * 9;
      w.mesh.position.y = Math.sin(w.phase) * 0.03 + 0.015;
      w.mesh.rotation.z = Math.sin(w.phase) * 0.09;
      w.mesh.scale.y = 1;
    }
  }
}
