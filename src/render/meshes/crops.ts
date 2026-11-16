import * as THREE from 'three';
import { CROPS } from '../../data/crops';
import type { CropId } from '../../core/types';
import { mat } from '../mat';
import { mulberry32, range } from '../rng';

type Form = 'grain' | 'leafy' | 'vine';

const FORM: Record<CropId, Form> = {
  wheat: 'grain',
  corn: 'grain',
  carrot: 'leafy',
  cotton: 'leafy',
  strawberry: 'vine',
  pumpkin: 'vine',
  lettuce: 'leafy',
  grape: 'vine',
  rose: 'leafy',
  blueberry: 'vine',
  sugarcane: 'grain',
};

export interface CropMesh {
  group: THREE.Group;
  /** 生长动画缩放这一层即可，不用重建几何体 */
  stem: THREE.Group;
  /** 成熟才显形的果实 */
  fruits: THREE.Object3D[];
}

/**
 * 一次建好全生命周期的网格：果实先藏着，成熟时切换 visible。
 * 生长过程只改 stem 的 scale，避免每帧重建 geometry。
 */
export function makeCrop(id: CropId, seed: number): CropMesh {
  const def = CROPS[id];
  const rng = mulberry32(seed);
  const form = FORM[id];

  const group = new THREE.Group();
  const stem = new THREE.Group();
  group.add(stem);

  const fruits: THREE.Object3D[] = [];
  const h = def.height;

  if (form === 'grain') {
    const stalks = form === 'grain' ? 4 : 3;
    for (let i = 0; i < stalks; i++) {
      const a = (i / stalks) * Math.PI * 2 + rng();
      const r = range(rng, 0.06, 0.16);
      const sh = h * range(rng, 0.85, 1.05);
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.03, sh, 5), mat(def.stem));
      stalk.position.set(Math.cos(a) * r, sh / 2, Math.sin(a) * r);
      stalk.rotation.z = range(rng, -0.12, 0.12);
      stem.add(stalk);

      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.055, sh * 0.3, 5), mat(def.fruit));
      ear.position.set(Math.cos(a) * r, sh + sh * 0.1, Math.sin(a) * r);
      ear.visible = false;
      stem.add(ear);
      fruits.push(ear);
    }
  } else if (form === 'leafy') {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rng();
      const lh = h * range(rng, 0.8, 1.2);
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.07, lh, 4), mat(def.stem));
      leaf.position.set(Math.cos(a) * 0.11, lh / 2, Math.sin(a) * 0.11);
      leaf.rotation.set(Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5);
      stem.add(leaf);
    }
    const bulb = new THREE.Mesh(
      new THREE.IcosahedronGeometry(h * 0.42, 0),
      mat(def.fruit),
    );
    bulb.position.y = h * 0.3;
    bulb.scale.y = 0.75;
    bulb.visible = false;
    stem.add(bulb);
    fruits.push(bulb);
  } else {
    // 藤蔓：贴地大叶 + 中心大果
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rng();
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 0), mat(def.stem));
      leaf.position.set(Math.cos(a) * 0.22, 0.07, Math.sin(a) * 0.22);
      leaf.scale.set(1, 0.32, 1);
      stem.add(leaf);
    }
    const fruit = new THREE.Mesh(new THREE.IcosahedronGeometry(h * 0.5, 0), mat(def.fruit));
    fruit.position.y = h * 0.42;
    fruit.visible = false;
    fruit.castShadow = true;
    stem.add(fruit);
    fruits.push(fruit);
  }

  return { group, stem, fruits };
}

/** 生长视觉进度：0.28 起跳，成熟时到 1 */
export function growthScale(progress: number): number {
  return 0.28 + 0.72 * Math.min(1, Math.max(0, progress));
}
