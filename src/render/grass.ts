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
export function makeGrassField(points: { x: number; z: number; s: number }[]): THREE.InstancedMesh {
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
    dummy.position.set(p.x, 0, p.z);
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
  return mesh;
}
