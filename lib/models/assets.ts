import type { InputAsset, PcbIr } from "../eda/types";
export function modelAssets(assets: InputAsset[]) {
  return assets.filter((a) => /\.(wrl|step|stp)$/i.test(a.path));
}
export function boardAssembly(pcb: PcbIr, assets: InputAsset[]) {
  const source = pcb.sourceRefs[0]?.path ?? "";
  const stem = source.replace(/\.[^.]+$/, "").toLowerCase();
  return (
    assets.find((a) => a.path.toLowerCase() === stem + ".wrl") ??
    assets.find((a) => a.path.toLowerCase() === stem + ".step") ??
    assets.find((a) => a.path.toLowerCase() === stem + ".stp")
  );
}
export function validateVrml(text: string) {
  if (!text.startsWith("#VRML V2.0")) throw new Error("仅支持 VRML 2.0 模型");
  if (/\b(?:Inline|ImageTexture|MovieTexture|AudioClip|Script)\s*\{/.test(text))
    throw new Error("模型引用了外部资源，请导出包含全部几何的 WRL 或 STEP");
}
