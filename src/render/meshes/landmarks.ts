import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mat, matOwn, matVC } from '../mat';
import { getPalette } from '../palette';
import { bakeStatic } from '../bake';
import { mulberry32, range } from '../rng';
import { makeFlowerCluster, makeTree } from './terrain';

/**
 * 舞台级地形构件：石径、上层台地、风车。
 *
 * 这三件不是“装饰物”，而是把画面从**平盘上的散点**改成**有高差、有路径、
 * 有主角的微缩舞台**。玩法坐标仍然在 y=0 平面，台地只抬高住宅的显示高度，
 * 农田/池塘/广场/订单交互都不受影响。
 */

const PATH_Y = 0.035;

/**
 * 一条有手绘边缘的土石小径。
 * 用 Catmull-Rom 采样出中心线，再向两侧挤出不等宽的路面；
 * 宽度带一点正弦起伏，边缘因此不会像一条 CAD 画的皮带。
 */
export function makeStonePath(
  points: [number, number][],
  width = 0.66,
  baseY = PATH_Y,
  seed = 1,
  heightAt?: (x: number, z: number) => number,
): THREE.Group {
  const rng = mulberry32(seed);
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    false,
    'catmullrom',
    0.45,
  );
  const len = curve.getLength();
  const N = Math.max(10, Math.ceil(len / 0.24));

  const group = new THREE.Group();
  const build = (w: number, y: number, colBase: number, colEdge: number) => {
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const cBase = new THREE.Color(colBase);
    const cEdge = new THREE.Color(colEdge);
    const tangent = new THREE.Vector3();
    const center = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      curve.getPointAt(t, center);
      curve.getTangentAt(t, tangent);
      const nx = -tangent.z;
      const nz = tangent.x;
      const breathe = 1 + Math.sin(t * 17 + seed) * 0.06 + Math.sin(t * 43 + 1.7) * 0.035;
      const half = (w * breathe) / 2;
      for (let s = 0; s < 2; s++) {
        const sign = s === 0 ? -1 : 1;
        const edge = Math.abs(sign) * 0.5;
        const c = cEdge.clone().lerp(cBase, 0.35 + 0.65 * (1 - edge));
        c.offsetHSL(0, 0, (rng() - 0.5) * 0.045);
        const vx = center.x + nx * half * sign;
        const vz = center.z + nz * half * sign;
        pos.push(vx, y + (heightAt ? heightAt(vx, vz) : 0), vz);
        col.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(
      g,
      matOwn(0xffffff, {
        vertexColors: true,
        roughness: 1,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        side: THREE.DoubleSide,
      }),
    );
    m.receiveShadow = true;
    return m;
  };

  const p = getPalette();
  // 底缘：略宽、略深，给土径一圈被踩实的暗边
  const border = build(width + 0.18, baseY - 0.008, new THREE.Color(p.path).offsetHSL(0, 0, -0.055).getHex(), p.soilDark);
  // 路面：中间亮、两边深，顶点色做出“走出来的路心”
  const surface = build(width, baseY, p.path, new THREE.Color(p.path).offsetHSL(0, -0.01, -0.035).getHex());
  group.add(border, surface);

  // 路边碎石：小、散、稀，只在转弯附近多几颗
  const center = new THREE.Vector3();
  const pebbles: THREE.BufferGeometry[] = [];
  for (let i = 0; i < Math.ceil(len * 2.2); i++) {
    const t = rng();
    curve.getPointAt(t, center);
    const s = range(rng, 0.025, 0.06);
    const g = new THREE.IcosahedronGeometry(s, 0);
    g.scale(1.3, 0.6, 1);
    const side = rng() > 0.5 ? 1 : -1;
    const n = new THREE.Vector3(-curve.getTangentAt(t).z, 0, curve.getTangentAt(t).x).normalize();
    const px = center.x + n.x * (width / 2 + range(rng, 0.08, 0.24)) * side;
    const pz = center.z + n.z * (width / 2 + range(rng, 0.08, 0.24)) * side;
    g.translate(px, baseY + s * 0.25 + (heightAt ? heightAt(px, pz) : 0), pz);
    pebbles.push(g);
  }
  const merged = mergeGeometries(pebbles, false);
  pebbles.forEach((g) => g.dispose());
  if (merged) {
    const rock = getPalette().rock;
    const pm = new THREE.Mesh(merged, mat(rock));
    pm.castShadow = true;
    pm.receiveShadow = true;
    group.add(pm);
  }

  return group;
}

export interface Terrace {
  group: THREE.Group;
  height: number;
  contains(x: number, z: number): boolean;
}

/** 上层台地：一条微微起伏的前缘 + 后半个岛的高台。 */
export function makeUpperTerrace(): Terrace {
  const H = 0.72;
  const frontZ = -3.05;
  const halfW = 7.15;
  const contour: THREE.Vector2[] = [];

  // 前缘：从左到右，带一点手作起伏（不是一条直尺线）
  const frontN = 22;
  for (let i = 0; i <= frontN; i++) {
    const x = -halfW + (2 * halfW * i) / frontN;
    // 端点不起伏，保证与后半圈严丝合缝，避免多边形自交
    const taper = Math.sin((i / frontN) * Math.PI);
    const z = frontZ + taper * (0.24 * Math.sin((x / halfW) * Math.PI * 1.6) + 0.07 * Math.sin(x * 1.7));
    contour.push(new THREE.Vector2(x, z));
  }
  // 后半圈：从右前端点绕到左前端点。半径取端点实际半径，首尾重合。
  const arcN = 28;
  const a0 = Math.atan2(frontZ, halfW);
  const a1 = Math.PI - a0;
  const rArc = Math.hypot(halfW, frontZ);
  for (let i = 1; i <= arcN; i++) {
    const a = a0 + ((a1 - a0) * i) / arcN;
    contour.push(new THREE.Vector2(Math.cos(a) * rArc, Math.sin(a) * rArc));
  }
  // 去重，保证三角化稳定
  const clean: THREE.Vector2[] = [];
  for (const p of contour) {
    if (clean.length === 0 || clean[clean.length - 1].distanceTo(p) > 0.02) clean.push(p);
  }
  if (clean.length > 2 && clean[0].distanceTo(clean[clean.length - 1]) < 0.02) clean.pop();

  const group = new THREE.Group();

  // 顶面：顶点色草甸 + 三角化
  const tris = THREE.ShapeUtils.triangulateShape(clean, []);
  const topPos: number[] = [];
  const topCol: number[] = [];
  const grass = new THREE.Color(getPalette().grass);
  const pushTop = (x: number, z: number) => {
    const k = 0.93 + 0.1 * (0.5 + 0.5 * Math.sin(x * 2.1 + z * 1.7));
    topPos.push(x, H, z);
    topCol.push(grass.r * k, grass.g * k, grass.b * k);
  };
  for (const t of tris) {
    for (const vi of t) {
      const p = clean[vi];
      pushTop(p.x, p.y);
    }
  }
  const topGeo = new THREE.BufferGeometry();
  topGeo.setAttribute('position', new THREE.Float32BufferAttribute(topPos, 3));
  topGeo.setAttribute('color', new THREE.Float32BufferAttribute(topCol, 3));
  topGeo.computeVertexNormals();
  const top = new THREE.Mesh(topGeo, matOwn(0xffffff, { vertexColors: true, roughness: 1 }));
  top.receiveShadow = true;
  group.add(top);

  // 侧壁：竖向切成几道石层，颜色交替，像干砌石挡土墙
  const wallPos: number[] = [];
  const wallCol: number[] = [];
  const wallIdx: number[] = [];
  const stoneA = new THREE.Color(getPalette().rock);
  const stoneB = new THREE.Color(getPalette().rockDark);
  const bands = [0, 0.14, 0.3, 0.47, 0.65, H];
  for (let bi = 0; bi < bands.length; bi++) {
    const c = (bi % 2 === 0 ? stoneA : stoneB).clone().offsetHSL(0, 0, (bi % 3 === 0 ? 0.012 : -0.008));
    const n = clean.length;
    for (let i = 0; i < n; i++) {
      const p = clean[i];
      const y = bands[bi];
      wallPos.push(p.x, y, p.y);
      const ao = 0.8 + (y / H) * 0.2;
      wallCol.push(c.r * ao, c.g * ao, c.b * ao);
    }
  }
  for (let bi = 0; bi < bands.length - 1; bi++) {
    const n = clean.length;
    const a0 = bi * n;
    const b0 = (bi + 1) * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      wallIdx.push(a0 + i, b0 + i, a0 + j, a0 + j, b0 + i, b0 + j);
    }
  }
  const wallGeo = new THREE.BufferGeometry();
  wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
  wallGeo.setAttribute('color', new THREE.Float32BufferAttribute(wallCol, 3));
  wallGeo.setIndex(wallIdx);
  wallGeo.computeVertexNormals();
  const wall = new THREE.Mesh(wallGeo, matVC());
  wall.castShadow = true;
  wall.receiveShadow = true;
  group.add(wall);

  // 前缘压顶石：一条浅色窄带，把草皮和石墙分开
  const crown = new THREE.Mesh(
    new THREE.BoxGeometry(halfW * 2 + 0.08, 0.07, 0.16),
    mat(getPalette().path),
  );
  crown.position.set(0, H + 0.005, frontZ);
  crown.castShadow = true;
  group.add(crown);

  // 石阶：两处上山，留出主路径的入口
  const stairs = (sx: number) => {
    const steps: THREE.Object3D[] = [];
    const n = 5;
    for (let i = 0; i < n; i++) {
      const h = (H * (i + 1)) / n;
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, h, 0.25),
        mat(i % 2 ? getPalette().rock : new THREE.Color(getPalette().rock).offsetHSL(0, 0, 0.025).getHex()),
      );
      // 从台地前缘往低处伸：z 越大越低
      step.position.set(sx, h / 2, frontZ + 0.2 + (n - 1 - i) * 0.22);
      step.castShadow = true;
      step.receiveShadow = true;
      steps.push(step);
    }
    // 两侧矮墙
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.4, 1.25),
        mat(getPalette().rockDark),
      );
      rail.position.set(sx + side * 0.82, 0.45, frontZ + 0.7);
      rail.rotation.x = -0.55;
      rail.castShadow = true;
      steps.push(rail);
    }
    for (const s of steps) group.add(s);
  };
  stairs(-4.15);
  stairs(2.6);

  // 台地前缘的木栏杆：不连续，留两处上下口
  const railParts: THREE.BufferGeometry[] = [];
  const railSegs: [number, number][] = [[-7.0, -5.2], [-3.0, 1.55], [3.65, 6.9]];
  for (const [x0, x1] of railSegs) {
    const n = Math.max(2, Math.round((x1 - x0) / 0.62));
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const z = frontZ + 0.26 * Math.sin((x / halfW) * Math.PI * 1.6) + 0.08 * Math.sin(x * 1.7);
      const post = new THREE.BoxGeometry(0.055, 0.34, 0.055);
      post.translate(x, H + 0.17, z - 0.1);
      railParts.push(post);
    }
    const z0 = frontZ + 0.26 * Math.sin((x0 / halfW) * Math.PI * 1.6) + 0.08 * Math.sin(x0 * 1.7);
    const z1 = frontZ + 0.26 * Math.sin((x1 / halfW) * Math.PI * 1.6) + 0.08 * Math.sin(x1 * 1.7);
    const rail = new THREE.BoxGeometry(x1 - x0, 0.05, 0.05);
    const midZ = (z0 + z1) / 2;
    rail.translate((x0 + x1) / 2, H + 0.33, midZ - 0.1);
    railParts.push(rail);
  }
  const railGeo = mergeGeometries(railParts, false);
  railParts.forEach((g) => g.dispose());
  if (railGeo) {
    const rail = new THREE.Mesh(railGeo, mat(0x9c7443));
    rail.castShadow = true;
    group.add(rail);
  }

  // 台地上的石板路：把两处台阶与住宅门前连起来
  group.add(makeStonePath([[-4.15, frontZ + 0.35], [-3.4, -3.6], [-2.6, -4.0]], 0.58, H + 0.025, 77));
  group.add(makeStonePath([[2.6, frontZ + 0.35], [2.1, -3.7], [2.8, -4.3]], 0.58, H + 0.025, 78));

  return {
    group,
    height: H,
    contains(x: number, z: number): boolean {
      // 只认台地前缘以内、半宽以内的点；用前缘函数做边界，和几何保持一致
      if (Math.abs(x) > halfW || z > frontZ + 0.4) return false;
      return true;
    },
  };
}

export interface Windmill {
  group: THREE.Group;
  blades: THREE.Object3D;
  lights: THREE.MeshStandardMaterial[];
}

/** 风车：画面的第一视觉焦点。石基、抹灰塔身、木平台、四片格子帆。 */
export function makeWindmill(seed = 4711): Windmill {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const lights: THREE.MeshStandardMaterial[] = [];
  const wood = 0x9a6a43;
  const woodDark = 0x6f4a2f;
  const plaster = 0xf4e7cf;
  const roof = 0xb8563d;

  // 草丘：让风车站在一个自然的高点上，而不是插在平地
  const mound = new THREE.Mesh(
    new THREE.CylinderGeometry(1.45, 1.75, 0.34, 14),
    mat(getPalette().grassDark),
  );
  mound.position.y = 0.17;
  mound.receiveShadow = true;
  mound.castShadow = true;
  g.add(mound);
  const stoneRing = new THREE.Mesh(
    new THREE.CylinderGeometry(1.5, 1.52, 0.1, 14),
    mat(getPalette().rock),
  );
  stoneRing.position.y = 0.05;
  stoneRing.receiveShadow = true;
  g.add(stoneRing);

  const baseY = 0.3;
  // 石基
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.63, 0.76, 0.5, 8), mat(getPalette().rock));
  base.position.y = baseY + 0.25;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);

  // 塔身：下宽上窄的八棱柱，抹灰面
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.58, 2.25, 8), mat(plaster));
  tower.position.y = baseY + 1.6;
  tower.castShadow = true;
  tower.receiveShadow = true;
  g.add(tower);

  // 木箍：三道，打破抹灰面的单调
  for (const [y, r] of [[baseY + 0.75, 0.56], [baseY + 1.55, 0.48], [baseY + 2.3, 0.42]] as const) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.07, 8), mat(woodDark));
    ring.position.y = y;
    ring.castShadow = true;
    g.add(ring);
  }

  // 木平台 + 一圈栏杆
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(0.73, 0.73, 0.09, 8), mat(wood));
  deck.position.y = baseY + 1.05;
  deck.castShadow = true;
  g.add(deck);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.28, 0.035), mat(woodDark));
    post.position.set(Math.cos(a) * 0.66, baseY + 1.23, Math.sin(a) * 0.66);
    g.add(post);
  }
  const rail = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.018, 4, 20), mat(wood));
  rail.rotation.x = Math.PI / 2;
  rail.position.y = baseY + 1.37;
  g.add(rail);

  // 门与窗：门朝岛心，窗是夜里会亮的暖黄
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.48, 0.06), mat(woodDark));
  door.position.set(0, baseY + 0.25, 0.65);
  g.add(door);
  const winMat = matOwn(0xffe7a8);
  lights.push(winMat);
  for (const [x, y, z] of [[0.26, baseY + 1.22, 0.44], [-0.3, baseY + 0.9, 0.48]] as const) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.2, 0.05), winMat);
    win.position.set(x, y, z);
    win.userData.noBake = true;
    g.add(win);
  }

  // 屋顶
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.58, 0.58, 8), mat(roof));
  cap.position.y = baseY + 2.85;
  cap.castShadow = true;
  g.add(cap);
  const finial = new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 0), mat(0xf2c14e));
  finial.position.y = baseY + 3.18;
  g.add(finial);

  // 风车轴与四片帆：叶片绕 z 轴旋转
  const hub = new THREE.Group();
  hub.position.set(0, baseY + 2.28, 0.56);
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.22, 8), mat(woodDark));
  axle.rotation.x = Math.PI / 2;
  axle.position.z = 0.08;
  hub.add(axle);
  const spin = new THREE.Group();
  spin.position.z = 0.17;
  hub.add(spin);
  for (let b = 0; b < 4; b++) {
    const blade = new THREE.Group();
    blade.rotation.z = (b / 4) * Math.PI * 2;
    const spar = new THREE.Mesh(new THREE.BoxGeometry(0.055, 1.55, 0.035), mat(woodDark));
    spar.position.y = 0.78;
    blade.add(spar);
    // 帆面：细木条 + 米白帆布，格子感来自四条横档
    const sail = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 1.3, 0.02),
      mat(0xf6edd8),
    );
    sail.position.set(0.19, 0.82, -0.015);
    blade.add(sail);
    for (let i = 0; i < 4; i++) {
      const batten = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.035, 0.03), mat(wood));
      batten.position.set(0.19, 0.32 + i * 0.3, 0.005);
      blade.add(batten);
    }
    blade.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
    spin.add(blade);
  }
  g.add(hub);

  // 门口的小道具：麻袋与木桶，给“有人劳作”一点证据
  for (let i = 0; i < 2; i++) {
    const sack = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.1, 0.16, 3, 6),
      mat(0xd9c39c),
    );
    sack.position.set(-0.52 + i * 0.23, baseY + 0.14, 0.66 + range(rng, -0.06, 0.06));
    sack.rotation.z = range(rng, -0.2, 0.2);
    sack.castShadow = true;
    g.add(sack);
  }
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.14, 0.32, 8), mat(wood));
  barrel.position.set(0.62, baseY + 0.16, 0.5);
  barrel.castShadow = true;
  g.add(barrel);

  bakeStatic(g);
  // bakeStatic 会把所有静态件合并；叶片必须保留独立层级以持续旋转
  // 因此这里把 spin 从 g 的合并结果中排除：先把 spin 摘出再烘，然后放回。
  // 简化做法：bakeStatic 之前 spin 已被 add 到 hub，hub 的网格会被烘进 g，
  // 于是旋转失效。这里直接重建一个独立叶片组，保证动画。
  g.remove(hub);
  const hub2 = new THREE.Group();
  hub2.position.copy(hub.position);
  const axle2 = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.22, 8), mat(woodDark));
  axle2.rotation.x = Math.PI / 2;
  axle2.position.z = 0.08;
  hub2.add(axle2);
  const spin2 = new THREE.Group();
  spin2.position.z = 0.17;
  hub2.add(spin2);
  for (let b = 0; b < 4; b++) {
    const blade = new THREE.Group();
    blade.rotation.z = (b / 4) * Math.PI * 2;
    const spar = new THREE.Mesh(new THREE.BoxGeometry(0.055, 1.55, 0.035), mat(woodDark));
    spar.position.y = 0.78;
    blade.add(spar);
    const sail = new THREE.Mesh(new THREE.BoxGeometry(0.32, 1.3, 0.02), mat(0xf6edd8));
    sail.position.set(0.19, 0.82, -0.015);
    blade.add(sail);
    for (let i = 0; i < 4; i++) {
      const batten = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.035, 0.03), mat(wood));
      batten.position.set(0.19, 0.32 + i * 0.3, 0.005);
      blade.add(batten);
    }
    blade.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
    spin2.add(blade);
  }
  g.add(hub2);

  g.userData.lights = lights;
  return { group: g, blades: spin2, lights };
}

/** 主岛到拓荒小岛的绳桥：木板 + 两侧绳索，短短一段，强调“锚定”而不抢戏。 */
export function makeRopeBridge(
  ax: number, az: number, bx: number, bz: number,
): THREE.Group {
  const g = new THREE.Group();
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  const angle = Math.atan2(dz, dx);
  const midX = (ax + bx) / 2;
  const midZ = (az + bz) / 2;
  g.position.set(midX, 0.11, midZ);
  g.rotation.y = -angle;

  const planks = Math.max(4, Math.round(len / 0.42));
  const wood = mat(0xa9794f);
  const dark = mat(0x7a5738);
  for (let i = 0; i <= planks; i++) {
    const x = -len / 2 + (len * i) / planks;
    const plank = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.045, 0.46), wood);
    plank.position.set(x, 0, 0);
    plank.rotation.y = (i % 2 ? 1 : -1) * 0.02;
    plank.castShadow = true;
    g.add(plank);
  }
  for (const side of [-1, 1]) {
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, len, 4), mat(0xe0caa4));
    rope.rotation.z = Math.PI / 2;
    rope.position.set(0, 0.2, side * 0.24);
    g.add(rope);
    for (const x of [-len / 2 + 0.1, len / 2 - 0.1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.48, 0.05), dark);
      post.position.set(x, 0.16, side * 0.24);
      post.castShadow = true;
      g.add(post);
    }
  }
  return g;
}

export interface SatelliteIslet {
  group: THREE.Group;
  center: { x: number; z: number };
}

/**
 * 拓荒小岛：主岛的缩小版，同一套草地/岩壁/树语言。
 * 未解锁时是一座发白的“云中荒岛”，解锁后才铺田、接桥。
 * 每座岛只放 4 块田，刚好是“多一块地”的尺度，不会把主岛挤成卫星。
 */
export function makeSatelliteIslet(
  def: { name: string; center: { x: number; z: number } },
  unlocked: boolean,
  seed = 8801,
): SatelliteIslet {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  g.position.set(def.center.x, 0, def.center.z);
  const R = 2.35;
  const grass = unlocked ? getPalette().grass : 0x9dbf83;
  const soil = unlocked ? getPalette().soilDark : 0xb9b3a2;
  const rock = unlocked ? getPalette().rock : 0xc3c6c4;

  // 顶面：草皮略高于主岛，田块才能贴住
  const top = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.98, 0.22, 14), mat(grass));
  top.position.y = -0.11;
  top.receiveShadow = true;
  g.add(top);
  // 草皮翻边
  const lip = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.02, R * 0.96, 0.09, 14), mat(unlocked ? getPalette().grassDark : 0x9eae94));
  lip.position.y = -0.18;
  g.add(lip);
  // 土层 + 岩层 + 底尖
  const soilMesh = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.93, R * 0.72, 0.7, 12), mat(soil));
  soilMesh.position.y = -0.55;
  soilMesh.receiveShadow = true;
  g.add(soilMesh);
  const rockMesh = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.72, R * 0.45, 1.1, 10), mat(rock));
  rockMesh.position.y = -1.45;
  g.add(rockMesh);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(R * 0.45, 1.2, 10), mat(unlocked ? getPalette().rockDark : 0x9da3a1));
  tip.rotation.x = Math.PI;
  tip.position.y = -2.55;
  g.add(tip);

  // 岛缘碎岩与灌木，保持和主岛同一套边界语言
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rng() * 0.4;
    const s = 0.12 + rng() * 0.12;
    const r = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), mat(rock));
    r.position.set(Math.cos(a) * R * 0.92, -0.05 - rng() * 0.2, Math.sin(a) * R * 0.92);
    r.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    g.add(r);
  }
  // 两棵树常驻：荒岛也是岛，只是还没被经营；别让它读成一块石头。
  for (const [a, kind] of [[0.55, 'broadleaf'], [2.4, 'pine']] as const) {
    const t = makeTree(seed + a * 100, kind);
    t.position.set(Math.cos(a) * R * 0.72, 0, Math.sin(a) * R * 0.72);
    t.scale.setScalar(unlocked ? 0.72 : 0.58);
    g.add(t);
  }
  if (unlocked) {
    for (let i = 0; i < 7; i++) {
      const a = rng() * Math.PI * 2;
      const f = makeFlowerCluster(seed + i * 37);
      f.position.set(Math.cos(a) * R * 0.82, 0.01, Math.sin(a) * R * 0.82);
      f.scale.setScalar(0.85);
      g.add(f);
    }
  } else {
    // 荒岛：几团贴地的雾，别用白色多面体（会读成石头）
    for (let i = 0; i < 3; i++) {
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(0.5 + rng() * 0.3, 8, 5),
        matOwn(0xffffff, { transparent: true, opacity: 0.18, depthWrite: false, roughness: 1 }),
      );
      puff.scale.y = 0.4;
      puff.position.set((rng() - 0.5) * 2.4, 0.15 + rng() * 0.2, (rng() - 0.5) * 1.6);
      g.add(puff);
    }
  }

  // 小旗：解锁后用暖珊瑚色，锁定用灰蓝
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.95, 5), mat(0x8d6a45));
  pole.position.set(0.35, 0.47, -1.55);
  pole.castShadow = true;
  g.add(pole);
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.3),
    matOwn(unlocked ? 0xd96f4f : 0xaab6ba, { side: THREE.DoubleSide }),
  );
  flag.position.set(0.62, 0.78, -1.55);
  flag.rotation.y = -0.2;
  g.add(flag);

  return { group: g, center: def.center };
}
