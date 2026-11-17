import * as THREE from 'three';

/**
 * 实例化草皮。
 *
 * 为什么这是"观感跃迁"而不是"再加点装饰"：Tiny Glade 这类作品的地面之所以高级，
 * 一大半来自**密集的草叶与花**——它给地面提供了尺度感与细碎的高频信息，
 * 而我们现在是一块平滑的绿色。
 *
 * 做法：一个 3 万级实例的 InstancedMesh（1 次绘制），每株草是两片交叉的窄叶，
 * 顶点色做「根深梢浅」，并按世界坐标抖动色相，避免整片同色。
 */
const BLADE_H = 0.16;
const BLADE_W = 0.06;

function bladeGeometry(): THREE.BufferGeometry {
  // 两片交叉的窄四边形，从底部到梢部逐渐收窄
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const base = new THREE.Color(0x7cb14e);
  const tip = new THREE.Color(0xdaf2a6);

  const quad = (dirX: number, dirZ: number) => {
    const ox = (strength: number) => dirX * BLADE_W * strength;
    const oz = (strength: number) => dirZ * BLADE_W * strength;
    const start = positions.length / 3;
    // 4 个顶点：底部左右 + 顶部左右（顶部收窄）
    positions.push(-ox(0.5), 0, -oz(0.5));
    positions.push(ox(0.5), 0, oz(0.5));
    positions.push(-ox(0.16), BLADE_H, -oz(0.16));
    positions.push(ox(0.16), BLADE_H, oz(0.16));
    const c = base.clone().lerp(tip, 0.15);
    const c2 = base.clone().lerp(tip, 0.95);
    colors.push(c.r, c.g, c.b, c.r, c.g, c.b, c2.r, c2.g, c2.b, c2.r, c2.g, c2.b);
    indices.push(start, start + 1, start + 3, start, start + 3, start + 2);
  };
  quad(1, 0);
  quad(0, 1);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  // 法线统一朝上：草叶是竖直薄片，真实的侧向法线会让它们几乎不受光、发黑。
  // 这是风格化草皮的常用手法——让草像地面一样被天光照亮。
  const normals = new Float32Array((positions.length / 3) * 3);
  for (let i = 0; i < positions.length / 3; i++) {
    normals[i * 3 + 1] = 1;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return g;
}

let cachedGeo: THREE.BufferGeometry | null = null;
let cachedMat: THREE.MeshStandardMaterial | null = null;

/** 一株草实例一个矩阵；由 World 在装饰阶段收集坐标后统一构建 */
export function makeGrassField(points: { x: number; z: number; s: number; y?: number }[]): THREE.InstancedMesh {
  if (!cachedGeo) {
    cachedGeo = bladeGeometry();
    cachedMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
      side: THREE.DoubleSide,
    });
  }
  const mesh = new THREE.InstancedMesh(cachedGeo, cachedMat!, Math.max(1, points.length));
  mesh.count = points.length;
  mesh.frustumCulled = false;
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    dummy.position.set(p.x, p.y ?? 0, p.z);
    dummy.rotation.set(0, (i * 2.399963) % (Math.PI * 2), 0);
    dummy.scale.set(p.s, p.s * (0.8 + ((i * 37) % 40) / 100), p.s);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    // 每株草的色相抖动一点，整片才不会像刷了同一桶漆
    const k = 0.86 + ((i * 53) % 30) / 100;
    tint.setRGB(k, k * (0.98 + ((i * 17) % 10) / 200), k * 0.95);
    mesh.setColorAt(i, tint);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.instanceMatrix.needsUpdate = true;
  // 草必须接收阴影：否则地面覆盖着一层“永远被照亮”的草叶，
  // 树影/房影全被这层高频草盖住，画面就永远像没有主光。
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

/**
 * 野花田：整片 1 次绘制。
 * 草叶负责“密度”，花负责“颜色节拍”。没有花的草地会像一块地毯，
 * 有了疏密不均的色点，眼睛才会把它读成会呼吸的草甸。
 */
function flowerGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  // 五片小花瓣：每片一个扁平四边形，绕中心排布
  const petals = 5;
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const px = -dz;
    const pz = dx;
    const start = positions.length / 3;
    const r0 = 0.02;
    const r1 = 0.075;
    const spread = 0.045;
    positions.push(px * r0, 0, pz * r0);
    positions.push(dx * r1 + px * spread, 0.012, dz * r1 + pz * spread);
    positions.push(dx * r1 - px * spread, 0.012, dz * r1 - pz * spread);
    colors.push(1, 1, 1, 1, 1, 1, 1, 1, 1);
    indices.push(start, start + 1, start + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  const normals = new Float32Array((positions.length / 3) * 3);
  for (let i = 0; i < positions.length / 3; i++) normals[i * 3 + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return g;
}

const FLOWER_COLORS = [0xf26d7d, 0xffd05a, 0xf7f0dc, 0xb28bd8, 0xf39a4b, 0x7fc6d9];

export function makeFlowerField(
  points: { x: number; z: number; s: number; y?: number; c?: number }[],
): THREE.InstancedMesh {
  const geo = flowerGeometry();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, points.length));
  mesh.count = points.length;
  mesh.frustumCulled = false;
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    dummy.position.set(p.x, p.y ?? 0.01, p.z);
    dummy.rotation.set(0, (i * 2.399963) % (Math.PI * 2), 0);
    dummy.scale.setScalar(p.s);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    tint.setHex(p.c ?? FLOWER_COLORS[i % FLOWER_COLORS.length]);
    mesh.setColorAt(i, tint);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.receiveShadow = true;
  return mesh;
}
