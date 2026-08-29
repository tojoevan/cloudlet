import * as THREE from 'three';
import { mat, matOwn } from '../mat';
import { ISLAND_RADIUS, PALETTE } from '../palette';
import { mulberry32, pick, range } from '../rng';

export function jitter(
  geo: THREE.BufferGeometry,
  amount: number,
  rng: () => number,
  flatTopY?: number,
): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    // 顶面保持水平，建筑与作物才不会歪
    if (flatTopY !== undefined && Math.abs(y - flatTopY) < 1e-4) continue;
    pos.setXYZ(
      i,
      pos.getX(i) + (rng() - 0.5) * amount,
      y + (rng() - 0.5) * amount * 0.35,
      pos.getZ(i) + (rng() - 0.5) * amount,
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
  const top = new THREE.Mesh(
    jitter(new THREE.CylinderGeometry(R, R * 0.97, topH, 16), 0, rng, topH / 2),
    mat(PALETTE.grass),
  );
  top.position.y = -topH / 2;
  top.receiveShadow = true;
  g.add(top);

  const soilH = 1.3;
  const soil = new THREE.Mesh(
    jitter(new THREE.CylinderGeometry(R * 0.97, R * 0.82, soilH, 16), 0.35, rng),
    mat(PALETTE.soilDark),
  );
  soil.position.y = -topH - soilH / 2;
  g.add(soil);

  const rockH = 2.2;
  const rock = new THREE.Mesh(
    jitter(new THREE.CylinderGeometry(R * 0.82, R * 0.5, rockH, 12), 0.5, rng),
    mat(PALETTE.rock),
  );
  rock.position.y = -topH - soilH - rockH / 2;
  g.add(rock);

  const tip = new THREE.Mesh(
    jitter(new THREE.ConeGeometry(R * 0.5, 3.6, 8), 0.6, rng),
    mat(PALETTE.rockDark),
  );
  tip.rotation.x = Math.PI;
  tip.position.y = -topH - soilH - rockH - 1.8;
  g.add(tip);

  // 岛缘一圈小岩块，打破完美圆形的呆板
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rng() * 0.5;
    const r = R * range(rng, 0.86, 0.94);
    const s = range(rng, 0.18, 0.34);
    const chunk = new THREE.Mesh(jitter(new THREE.IcosahedronGeometry(s, 0), s * 0.4, rng), mat(PALETTE.rock));
    chunk.position.set(Math.cos(a) * r, -range(rng, 0.1, 0.45), Math.sin(a) * r);
    chunk.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    g.add(chunk);
  }

  return g;
}

export type TreeKind = 'pine' | 'broadleaf' | 'palm';

export function makeTree(seed: number, kind?: TreeKind): THREE.Group {
  const rng = mulberry32(seed);
  const k = kind ?? pick(rng, ['pine', 'broadleaf', 'palm'] as const);
  const g = new THREE.Group();
  const scale = range(rng, 0.85, 1.25);

  const trunkH = k === 'palm' ? range(rng, 1.1, 1.5) : range(rng, 0.45, 0.7);
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(range(rng, 0.06, 0.09), range(rng, 0.1, 0.14), trunkH, 6),
    mat(PALETTE.trunk),
  );
  trunk.position.y = trunkH / 2;
  trunk.castShadow = true;
  g.add(trunk);

  if (k === 'pine') {
    let y = trunkH * 0.75;
    let r = range(rng, 0.42, 0.55);
    for (let i = 0; i < 3; i++) {
      const h = range(rng, 0.45, 0.6);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), mat(i % 2 ? PALETTE.leafDeep : PALETTE.leafGreen));
      cone.position.y = y + h / 2;
      cone.castShadow = true;
      g.add(cone);
      y += h * 0.55;
      r *= 0.72;
    }
  } else if (k === 'broadleaf') {
    const blobs = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < blobs; i++) {
      const r = range(rng, 0.3, 0.46);
      const blob = new THREE.Mesh(
        jitter(new THREE.IcosahedronGeometry(r, 0), r * 0.18, rng),
        mat(i % 2 ? PALETTE.leafGreen : PALETTE.leafLight),
      );
      blob.position.set(range(rng, -0.25, 0.25), trunkH + range(rng, 0.05, 0.4), range(rng, -0.25, 0.25));
      blob.castShadow = true;
      g.add(blob);
    }
  } else {
    // 棕榈：几片压扁的锥当叶
    const leaves = 6;
    for (let i = 0; i < leaves; i++) {
      const a = (i / leaves) * Math.PI * 2 + rng() * 0.3;
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.16, range(rng, 0.7, 0.95), 4), mat(PALETTE.leafGreen));
      leaf.position.set(Math.cos(a) * 0.28, trunkH + 0.06, Math.sin(a) * 0.28);
      leaf.rotation.set(Math.PI / 2.4, 0, -a + Math.PI / 2);
      leaf.scale.set(1, 1, 0.28);
      leaf.castShadow = true;
      g.add(leaf);
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
    jitter(new THREE.IcosahedronGeometry(s, 0), s * 0.5, rng),
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

  return g;
}

export function makeCloud(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const r = range(rng, 0.5, 1.1);
    const puff = new THREE.Mesh(
      jitter(new THREE.IcosahedronGeometry(r, 0), r * 0.2, rng),
      new THREE.MeshLambertMaterial({ color: PALETTE.cloud, flatShading: true, transparent: true, opacity: 0.9 }),
    );
    puff.position.set(range(rng, -1.4, 1.4), range(rng, -0.2, 0.3), range(rng, -0.5, 0.5));
    g.add(puff);
  }
  g.scale.setScalar(range(rng, 0.8, 1.4));
  return g;
}

/** 农田地块。带 userData.plotId，射线检测后据此定位逻辑对象。 */
/** 在 Shape 上画一个圆角矩形路径（俯视 XY 平面） */
function roundedRectPath(s: THREE.Shape, x: number, y: number, w: number, h: number, r: number): void {
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

/** 地块高亮圈：选中与可收获时给反馈 */
export function makePlotRing(size = 1.0, color = 0xffffff): THREE.Mesh {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(size * 0.62, size * 0.74, 16),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  return ring;
}
