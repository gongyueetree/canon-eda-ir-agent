import {
  Group,
  Mesh,
  Matrix4,
  type BufferGeometry,
  type Material,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
/** Bake the exported assembly's transform hierarchy; batch only identical materials. */
export function optimizeAssembly(root: Group) {
  root.updateMatrixWorld(true);
  const groups = new Map<
    string,
    { material: Material; geometries: BufferGeometry[] }
  >();
  const originals = new Set<BufferGeometry>(),
    materials = new Set<Material>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    if (Array.isArray(object.material))
      throw new Error("模型包含多材质子网格，请改用 STEP 导出");
    const material = object.material;
    originals.add(object.geometry);
    materials.add(material);
    const data = material.toJSON();
    delete data.uuid;
    delete data.metadata;
    const key = JSON.stringify(data);
    let geometry = object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld as Matrix4);
    if (geometry.index) {
      const nonIndexed = geometry.toNonIndexed();
      geometry.dispose();
      geometry = nonIndexed;
    }
    // The WRL exporter emits no textures; keep only normals and vertices for batching.
    for (const name of Object.keys(geometry.attributes))
      if (name !== "position" && name !== "normal")
        geometry.deleteAttribute(name);
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const group = groups.get(key) ?? {
      material,
      geometries: [] as BufferGeometry[],
    };
    group.geometries.push(geometry);
    groups.set(key, group);
  });
  const out = new Group();
  const retained = new Set<Material>();
  for (const { material, geometries } of groups.values()) {
    const merged = mergeGeometries(geometries, false);
    geometries.forEach((g) => g.dispose());
    if (!merged) throw new Error("模型网格合并失败");
    out.add(new Mesh(merged, material));
    retained.add(material);
  }
  originals.forEach((g) => g.dispose());
  materials.forEach((m) => {
    if (!retained.has(m)) m.dispose();
  });
  return out;
}
