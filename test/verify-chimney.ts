/**
 * 烟囱气泡位置验证（确定性，不依赖渲染/像素采样，避开飘动的云）。
 *
 * 思路：复刻 app 里 world.ts 对工厂施加的变换 + scene.ts 的等距正交相机，
 * 把“工厂中心正上方”(旧行为 / 无烟囱 fallback) 与“烟囱口 chimneyTop”(新行为)
 * 都投到屏幕坐标，断言二者明显不重合 —— 即气泡确实从烟囱口偏出，而不是直接在屋顶正中冒。
 */
import * as THREE from 'three';
import { makeFactory } from '../src/render/meshes/structures';
import { FACTORIES } from '../src/data/factories';
import type { FactoryType } from '../src/core/types';

// —— app 常量（与 world.ts / scene.ts 保持一致）——
const ISO_PITCH = Math.atan(1 / Math.SQRT2); // 35.26°
const DIST = 40;
const YAW = Math.PI * 0.25;
const TARGET = new THREE.Vector3(0, 0, 0);
const ZOOM = 1;
const WIDTH = 1280;
const HEIGHT = 720;
const ASPECT = WIDTH / HEIGHT;
const FRUSTUM = ASPECT < 1 ? 26 : 21; // scene.resize() 的横屏分支

function factoryPos(i: number): THREE.Vector3 {
  const a = -Math.PI * 0.72 + (i / 3) * Math.PI * 0.5;
  const r = 6.9;
  return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
}

function makeCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(
    (-FRUSTUM * ASPECT) / 2,
    (FRUSTUM * ASPECT) / 2,
    FRUSTUM / 2,
    -FRUSTUM / 2,
    0.1,
    300,
  );
  const cp = Math.cos(ISO_PITCH);
  const sp = Math.sin(ISO_PITCH);
  cam.position.set(
    TARGET.x + DIST * cp * Math.sin(YAW),
    TARGET.y + DIST * sp,
    TARGET.z + DIST * cp * Math.cos(YAW),
  );
  cam.lookAt(TARGET);
  cam.zoom = ZOOM;
  cam.updateProjectionMatrix();
  return cam;
}

function toScreen(cam: THREE.OrthographicCamera, world: THREE.Vector3): { x: number; y: number } {
  const v = world.clone().project(cam);
  return { x: (v.x * 0.5 + 0.5) * WIDTH, y: (1 - (v.y * 0.5 + 0.5)) * HEIGHT };
}

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

const cam = makeCamera();
const types = Object.keys(FACTORIES) as FactoryType[];

for (let i = 0; i < types.length; i++) {
  const type = types[i];
  const { group, chimneyTop } = makeFactory(type, i * 104729 + 7);

  // 复刻 syncFactories 的摆位
  group.position.copy(factoryPos(i));
  group.lookAt(0, group.position.y, 0);
  group.rotation.x = 0;
  group.rotation.z = 0;
  group.updateMatrixWorld(true);

  // 烟囱口的世界坐标（气泡真正出现的地方）
  const chimneyWorld = (chimneyTop ?? new THREE.Vector3()).clone().applyMatrix4(group.matrixWorld);
  // 屋顶正中的世界坐标（旧行为 / fallback：origin 默认 (0,1.5,0)）
  const centerTopLocal = new THREE.Vector3(0, 1.5, 0);
  const centerTopWorld = centerTopLocal.applyMatrix4(group.matrixWorld);

  const pChim = toScreen(cam, chimneyWorld);
  const pCenter = toScreen(cam, centerTopWorld);
  const dx = pChim.x - pCenter.x;
  const dy = pChim.y - pCenter.y;
  const dist = Math.hypot(dx, dy);

  console.log(`\n[${type}] i=${i}`);
  console.log(`  chimneyTop 局部 = (${chimneyTop?.x.toFixed(2)}, ${chimneyTop?.y.toFixed(2)}, ${chimneyTop?.z.toFixed(2)})`);
  console.log(`  屏幕·烟囱口 = (${pChim.x.toFixed(1)}, ${pChim.y.toFixed(1)})`);
  console.log(`  屏幕·屋顶中 = (${pCenter.x.toFixed(1)}, ${pCenter.y.toFixed(1)})`);
  console.log(`  偏移       = (${dx.toFixed(1)}, ${dy.toFixed(1)}) px, 距离 ${dist.toFixed(1)} px`);

  assert(!!chimneyTop, `${type}: makeFactory 返回了 chimneyTop`);
  assert(dist > 15, `${type}: 烟囱口与屋顶正中在屏幕上有明显偏移（>15px），气泡确实从烟囱冒出`);
  // 烟囱一定比屋顶更高（世界 y 更大），保证不会埋在屋顶里
  assert(chimneyWorld.y > centerTopWorld.y, `${type}: 烟囱口世界高度高于屋顶（冒在头顶上方）`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
