import * as THREE from 'three';
import { mat, matOwn } from '../mat';
import { ISLAND_RADIUS, PALETTE } from '../palette';
import { mulberry32, pick, range } from '../rng';

/** 全部扰动共用一个种子：层与层的交界环才能算出相同偏移 */
const JITTER_SEED = 0x51ed270b;

/**
 * 对几何体顶点做随机扰动，做出手凿岩石的手感。
 * 偏移由「量化后的顶点坐标」哈希决定，而不是按调用顺序抽随机数——
 * 分属不同几何体、但坐标完全相同的顶点（各层交界环、非索引几何体里
 * 共点的面片角）会得到相同偏移：接缝严丝合缝，面片不会撕开。
 * 岛屿各层因此先把几何体平移到世界坐标再扰动（见 makeIsland）。
 */
export function jitter(
  geo: THREE.BufferGeometry,
  amount: number,
  flatTopY?: number,
): THREE.BufferGeometry {
  if (amount <= 0) return geo;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // 顶面保持水平，建筑与作物才不会歪
    if (flatTopY !== undefined && Math.abs(y - flatTopY) < 1e-4) continue;
    let h = (Math.imul(Math.round(x * 512), 0x85ebca6b) ^
      Math.imul(Math.round(y * 512), 0xc2b2ae35) ^
      Math.imul(Math.round(z * 512), 0x27d4eb2f) ^ JITTER_SEED) >>> 0;
    h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) ^ (h >>> 12)) >>> 0;
    const r1 = h / 0x100000000;
    h = (Math.imul(h ^ (h >>> 15), 0x297a2d39) ^ (h >>> 12)) >>> 0;
    const r2 = h / 0x100000000;
    h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) ^ (h >>> 12)) >>> 0;
    const r3 = h / 0x100000000;
    pos.setXYZ(
      i,
      x + (r1 - 0.5) * amount,
      y + (r2 - 0.5) * amount * 0.35,
      z + (r3 - 0.5) * amount,
    );
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** 浮空岛：草皮 + 土层 + 扰动过的岩锥，底部收成尖 */
export function makeIsland(seed = 20260829): THREE.Group {
  const rng = mulberry32(seed);
  const R = ISLAND_RADIUS;
  const g = new THREE.Group();

  const topH = 0.7;
  const soilH = 1.3;
  const rockH = 2.2;
  const tipH = 3.6;
  // 各层交界高度（世界坐标）。交界环两侧顶点必须完全重合，
  // 段数统一 16 + 等量扰动 + 坐标哈希，三层之间才能严丝合缝。
  const ySoil = -topH; // 草皮/土层
  const yRock = -topH - soilH; // 土层/岩层
  const yTip = yRock - rockH; // 岩层/底尖

  // 几何体一律先平移到世界坐标再扰动：哈希按「同一个点」匹配偏移
  const top = new THREE.Mesh(
    jitter(new THREE.CylinderGeometry(R, R * 0.97, topH, 16).translate(0, -topH / 2, 0), 0),
    mat(PALETTE.grass),
  );
  top.receiveShadow = true;
  g.add(top);

  // 顶环不扰动：草皮底环没扰动，土层顶环保持原位才能对齐（顶面藏在草皮下）
  const soil = new THREE.Mesh(
    jitter(
      new THREE.CylinderGeometry(R * 0.97, R * 0.82, soilH, 16).translate(0, ySoil - soilH / 2, 0),
      0.5,
      ySoil,
    ),
    mat(PALETTE.soilDark),
  );
  g.add(soil);

  const rock = new THREE.Mesh(
    jitter(
      new THREE.CylinderGeometry(R * 0.82, R * 0.5, rockH, 16).translate(0, yRock - rockH / 2, 0),
      0.5,
    ),
    mat(PALETTE.rock),
  );
  g.add(rock);

  // 底尖：顶环 R*0.5 与岩层底环重合、向下收成一点。
  // 用 (R*0.5→0) 的圆柱而不是翻转的 Cone——rotateX(π) 会把交界环
  // 在 z 向镜像（z→-z），段数对齐也对不上，缝就是这么来的。
  const tip = new THREE.Mesh(
    jitter(new THREE.CylinderGeometry(R * 0.5, 0, tipH, 16).translate(0, yTip - tipH / 2, 0), 0.5),
    mat(PALETTE.rockDark),
  );
  g.add(tip);

  // 岛缘一圈小岩块，打破完美圆形的呆板
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rng() * 0.5;
    const r = R * range(rng, 0.86, 0.94);
    const s = range(rng, 0.18, 0.34);
    const chunk = new THREE.Mesh(jitter(new THREE.IcosahedronGeometry(s, 0), s * 0.4), mat(PALETTE.rock));
    chunk.position.set(Math.cos(a) * r, -range(rng, 0.1, 0.45), Math.sin(a) * r);
    chunk.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    g.add(chunk);
  }

  return g;
}

export type TreeKind = 'pine' | 'broadleaf';

export function makeTree(seed: number, kind?: TreeKind): THREE.Group {
  const rng = mulberry32(seed);
  const k = kind ?? pick(rng, ['pine', 'broadleaf'] as const);
  const g = new THREE.Group();
  const scale = range(rng, 0.85, 1.25);

  const trunkH = range(rng, 0.45, 0.7);
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(range(rng, 0.06, 0.09), range(rng, 0.1, 0.14), trunkH, 6),
    mat(PALETTE.trunk),
  );
  trunk.position.y = trunkH / 2;
  trunk.castShadow = true;
  g.add(trunk);

  // 树冠单独拎进一个 subgroup，方便整体随风轻摆（树干不动）
  const foliage = new THREE.Group();
  g.add(foliage);
  g.userData.foliage = foliage;

  if (k === 'pine') {
    let y = trunkH * 0.75;
    let r = range(rng, 0.42, 0.55);
    for (let i = 0; i < 3; i++) {
      const h = range(rng, 0.45, 0.6);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), mat(i % 2 ? PALETTE.leafDeep : PALETTE.leafGreen));
      cone.position.y = y + h / 2;
      cone.castShadow = true;
      foliage.add(cone);
      y += h * 0.55;
      r *= 0.72;
    }
  } else if (k === 'broadleaf') {
    const blobs = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < blobs; i++) {
      const r = range(rng, 0.3, 0.46);
      const blob = new THREE.Mesh(
        jitter(new THREE.IcosahedronGeometry(r, 0), r * 0.18),
        mat(i % 2 ? PALETTE.leafGreen : PALETTE.leafLight),
      );
      blob.position.set(range(rng, -0.25, 0.25), trunkH + range(rng, 0.05, 0.4), range(rng, -0.25, 0.25));
      blob.castShadow = true;
      foliage.add(blob);
    }
  }

  g.scale.setScalar(scale);
  return g;
}

export function makeRock(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const s = range(rng, 0.16, 0.38);
  const rock = new THREE.Mesh(
    jitter(new THREE.IcosahedronGeometry(s, 0), s * 0.5),
    mat(rng() > 0.5 ? PALETTE.rock : PALETTE.rockDark),
  );
  rock.rotation.set(rng() * 3, rng() * 3, rng() * 3);
  rock.position.y = s * 0.55;
  rock.castShadow = true;
  g.add(rock);
  return g;
}

export function makeGrassTuft(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const h = range(rng, 0.14, 0.28);
    const blade = new THREE.Mesh(new THREE.ConeGeometry(0.05, h, 4), mat(rng() > 0.5 ? PALETTE.grassDark : PALETTE.leafLight));
    blade.position.set(range(rng, -0.1, 0.1), h / 2, range(rng, -0.1, 0.1));
    blade.rotation.z = range(rng, -0.25, 0.25);
    g.add(blade);
  }
  return g;
}

/** 池塘：嵌在草地里的静态水景。土色浅盆承着半透明水面，再点缀几片睡莲。
 * 水面 mesh 存在 userData.water，基准 y 在 userData.waterBaseY，方便每帧轻轻起伏。 */
export function makePond(seed = 13579): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const R = 1.4;

  // 土岸：环形（外圈 R+0.3，内圈 R），围出中间的水面。
  // 必须用空心环，否则实心土盘会把水完全包住，只看到棕色。
  const bankShape = new THREE.Shape();
  bankShape.absarc(0, 0, R + 0.3, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, R, 0, Math.PI * 2, true);
  bankShape.holes.push(hole);

  const bed = new THREE.Mesh(
    new THREE.ExtrudeGeometry(bankShape, { depth: 0.12, bevelEnabled: false, steps: 1 }),
    mat(PALETTE.soilDark),
  );
  // ExtrudeGeometry 沿 z 轴挤出，旋转后平铺在 xz 平面
  bed.rotation.x = -Math.PI / 2;
  bed.position.y = 0.02; // 岸底略高于草地，避免 z-fighting
  bed.receiveShadow = true;
  g.add(bed);

  // 水：填在环心，半透明蓝，略高于草地
  const water = new THREE.Mesh(
    new THREE.CylinderGeometry(R, R, 0.16, 28),
    matOwn(PALETTE.water, { transparent: true, opacity: 0.92 }),
  );
  const waterBaseY = 0.06; // 顶面 ≈ +0.14，与土岸顶齐平
  water.position.y = waterBaseY;
  water.receiveShadow = true;
  g.add(water);
  g.userData.water = water;
  g.userData.waterBaseY = waterBaseY;

  // 几片睡莲点缀，水不至于太死板
  const pads = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < pads; i++) {
    const a = rng() * Math.PI * 2;
    const r = rng() * (R - 0.4);
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 0.04, 8),
      mat(PALETTE.leafLight),
    );
    pad.position.set(Math.cos(a) * r, waterBaseY + 0.08, Math.sin(a) * r);
    g.add(pad);
  }

  // —— 活水感：扩散水波 + 中心喷泉粒子 ——
  // 三层错位的圆环，周期性放大并淡出，像水面被风或鱼轻轻搅动
  const ripples: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.24, 24),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = waterBaseY + 0.11;
    g.add(ring);
    ripples.push(ring);
  }

  // 中心小喷泉：一束向上的水珠粒子，受重力回落、循环复用
  const FN = 46;
  const fpos = new Float32Array(FN * 3);
  const fvel = new Float32Array(FN * 3);
  const frng = mulberry32(seed ^ 0x9e3779b9);
  const fountainBaseY = waterBaseY + 0.12;
  const spawn = (i: number) => {
    const a = frng() * Math.PI * 2;
    const spread = 0.18 + frng() * 0.18;
    fpos[i * 3] = Math.cos(a) * 0.06;
    fpos[i * 3 + 1] = fountainBaseY;
    fpos[i * 3 + 2] = Math.sin(a) * 0.06;
    fvel[i * 3] = Math.cos(a) * spread * frng();
    fvel[i * 3 + 1] = 1.1 + frng() * 0.9;
    fvel[i * 3 + 2] = Math.sin(a) * spread * frng();
  };
  for (let i = 0; i < FN; i++) {
    spawn(i);
    // 错开初始高度，避免所有粒子同时起落
    fpos[i * 3 + 1] = fountainBaseY + frng() * 0.5;
  }
  const fgeo = new THREE.BufferGeometry();
  fgeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
  const fountain = new THREE.Points(
    fgeo,
    new THREE.PointsMaterial({
      color: 0xbfefff,
      size: 0.07,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    }),
  );
  g.add(fountain);

  g.userData.water = water;
  g.userData.waterBaseY = waterBaseY;
  g.userData.ripples = ripples;
  g.userData.fountain = { points: fountain, pos: fpos, vel: fvel, n: FN, baseY: fountainBaseY, spawn };

  return g;
}

export function makeCloud(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const r = range(rng, 0.5, 1.1);
    const puff = new THREE.Mesh(
      jitter(new THREE.IcosahedronGeometry(r, 0), r * 0.2),
      new THREE.MeshStandardMaterial({
        color: PALETTE.cloud,
        flatShading: true,
        roughness: 0.92,
        metalness: 0,
        transparent: true,
        opacity: 0.96,
        // 白色自发光提亮背光面：Lambert 下球体侧面只吃到半天空光，
        // 会读成灰蓝；加自发光后整朵云才「白」得起来（顶面本就过曝纯白）
        emissive: 0xffffff,
        emissiveIntensity: 0.35,
      }),
    );
    puff.position.set(range(rng, -1.4, 1.4), range(rng, -0.2, 0.3), range(rng, -0.5, 0.5));
    g.add(puff);
  }
  g.scale.setScalar(range(rng, 0.8, 1.4));
  return g;
}

/** 农田地块。带 userData.plotId，射线检测后据此定位逻辑对象。 */
/** 在 Shape/Path 上画一个圆角矩形路径（俯视 XY 平面） */
function roundedRectPath(s: THREE.Path, x: number, y: number, w: number, h: number, r: number): void {
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
}

export function makePlot(plotId: number, size = 0.92): THREE.Mesh {
  const half = size / 2;
  const radius = size * 0.3; // 圆角，柔和不生硬
  const shape = new THREE.Shape();
  roundedRectPath(shape, -half, -half, size, size, radius);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2); // 厚度从 +Z 转到 +Y，地块平铺在草地上
  geo.translate(0, -0.07, 0); // 让地块一半埋进草面，与原方块一致
  const tile = new THREE.Mesh(geo, mat(PALETTE.tilled));
  tile.userData.plotId = plotId;
  tile.receiveShadow = true;
  return tile;
}

/**
 * 地块高亮圈：选中与可收获时给反馈。
 * 改成与地块同款的「圆角矩形描边」——外圈圆角矩形掏一个内圈圆角矩形，
 * 形成一圈等宽描边，套在地块外围，比原来的圆环更贴合方块田地、更精致。
 */
export function makePlotRing(size = 1.0, color = 0xffffff): THREE.Mesh {
  const outer = size;
  const thickness = 0.09;
  const inner = outer - thickness * 2;
  const rOuter = outer * 0.3; // 与地块（圆角 0.3）同曲率
  const rInner = Math.max(0.02, rOuter - thickness); // 等距内缩，避免转角夹死
  const shape = new THREE.Shape();
  roundedRectPath(shape, -outer / 2, -outer / 2, outer, outer, rOuter);
  const hole = new THREE.Path();
  roundedRectPath(hole, -inner / 2, -inner / 2, inner, inner, rInner);
  shape.holes.push(hole);
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2); // 平铺到地面
  const ring = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  );
  return ring;
}
