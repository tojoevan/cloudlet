import { BUILDING_ORDER } from '../data/buildings';
import { CROP_ORDER } from '../data/crops';
import { FACTORY_ORDER, PRODUCTS } from '../data/factories';
import type { BuildingType, CropId, FactoryType, GameState, ProductId } from './types';

/** 图鉴收录。返回 true 表示是新发现，交给 UI 去弹提示。 */
export function recordCrop(state: GameState, id: CropId): boolean {
  if (state.codex.crops.includes(id)) return false;
  state.codex.crops.push(id);
  return true;
}

export function recordProduct(state: GameState, id: ProductId): boolean {
  if (state.codex.products.includes(id)) return false;
  state.codex.products.push(id);
  return true;
}

export function recordBuilding(state: GameState, id: BuildingType): boolean {
  if (state.codex.buildings.includes(id)) return false;
  state.codex.buildings.push(id);
  return true;
}

export function recordFactory(state: GameState, id: FactoryType): boolean {
  if (state.codex.factories.includes(id)) return false;
  state.codex.factories.push(id);
  return true;
}

export function codexFound(state: GameState): number {
  const c = state.codex;
  return c.crops.length + c.products.length + c.buildings.length + c.factories.length;
}

export function codexTotal(): number {
  return CROP_ORDER.length + Object.keys(PRODUCTS).length + BUILDING_ORDER.length + FACTORY_ORDER.length;
}
