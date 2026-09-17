import { parseKicad, type KicadParseOutput } from "./kicad";
import { ALLEGRO_MANIFEST, isAllegroBoard, readAllegroManifest } from "./allegro-format";
import type { InputAsset, SourceAsset } from "./types";
import { decodeUtf8, diagnostic, sourceRef, stableId, withoutExtension } from "./util";

/** Conversion artifacts remain separate source documents; never claim converted UUIDs are native Allegro IDs. */
export function parseAllegro(inputs: InputAsset[], inventory: SourceAsset[]): KicadParseOutput {
  const output: KicadParseOutput = { settings: {}, schematics: [], pcbs: [], parts: [], nets: [], constraints: [], libraries: [], sourceMap: [], diagnostics: [], opaqueNodes: [], recognized: 0, normalized: 0, opaque: 0 };
  const byPath = new Map(inputs.map(i => [i.path, i]));
  const assets = new Map(inventory.map(a => [a.relativePath, a]));
  const consumed = new Set<string>();
  for (const manifestAsset of inventory.filter(a => a.fileName === ALLEGRO_MANIFEST)) {
    const ref = sourceRef(manifestAsset.id, manifestAsset.relativePath);
    try {
      const m = readAllegroManifest(byPath.get(manifestAsset.relativePath)!.bytes);
      const directory = manifestAsset.relativePath.slice(0, -ALLEGRO_MANIFEST.length);
      const original = assets.get(directory + m.source.path), converted = assets.get(directory + m.board.path);
      if (!original || !converted) throw new Error("缺少清单引用的原始 BRD 或转换后的 PCB");
      if (original.sha256 !== m.source.sha256 || converted.sha256 !== m.board.sha256) throw new Error("文件 SHA-256 与转换清单不一致，请重新转换");
      const input = byPath.get(original.relativePath)!, boardInput = byPath.get(converted.relativePath)!;
      if (!isAllegroBoard(input.bytes) || !/^\s*\(kicad_pcb\b/.test(decodeUtf8(boardInput.bytes.subarray(0, 100)))) throw new Error("源文件或转换文件内容签名无效");
      if (consumed.has(original.id) || consumed.has(converted.id)) throw new Error("同一源文件或转换文件被重复关联，未重复导入");
      const parsed = parseKicad([boardInput], [{ ...converted, detectedFormat: "kicad" }]);
      output.diagnostics.push(...parsed.diagnostics);
      if (parsed.pcbs.length !== 1) throw new Error("转换产物未能解析为一块 PCB");
      const pcb = parsed.pcbs[0];
      const originalRef = sourceRef(original.id, original.relativePath);
      pcb.name = withoutExtension(original.fileName);
      pcb.sourceRefs.push({ ...originalRef, resolutionMethod: "derived" });
      for (const fp of pcb.footprints) {
        output.parts.push({ id: stableId("part", pcb.id, fp.id), logicalPartKey: stableId("logical_part", pcb.id, fp.id), reference: fp.reference, value: fp.value, symbolUnits: [], footprintInstanceId: fp.id, footprint: fp.libraryIdentifier, fields: { Source: "Allegro PCB conversion" }, variantStatus: "unknown", pinPadMap: [], sourceRefs: [fp.sourceRef, { ...originalRef, resolutionMethod: "derived" }] });
      }
      output.projectName ??= pcb.name;
      output.pcbs.push(pcb); output.nets.push(...parsed.nets); output.constraints.push(...parsed.constraints);
      output.sourceMap.push(...parsed.sourceMap, originalRef, ref);
      output.recognized += parsed.recognized + 1; output.normalized += parsed.normalized;
      output.opaque += parsed.opaque + 1;
      output.opaqueNodes.push(...parsed.opaqueNodes, { recordType: "Allegro.NativeBoard", sourcePath: original.relativePath, payloadHash: original.sha256 });
      output.settings[manifestAsset.relativePath] = m;
      original.irParticipation = converted.irParticipation = manifestAsset.irParticipation = "included";
      consumed.add(original.id); consumed.add(converted.id);
      output.diagnostics.push(diagnostic("ALLEGRO_CONVERSION_PARTIAL", `${original.fileName} 经 ${m.converter.name} ${m.converter.version} 转换。保留原文件和转换文件的 SHA-256；PCB 派生 BOM 不等于原理图 BOM，未认证原生网表等价性。设计规则、特殊几何和 3D 模型可能未完整转换。`, "warning", "mapping", originalRef, "preserved"));
      if (!pcb.footprints.some(f => f.models?.length)) output.diagnostics.push(diagnostic("ALLEGRO_3D_MODELS_UNAVAILABLE", "转换结果没有器件 3D 模型引用；3D 查看器仅显示板体和焊盘。", "warning", "geometry", originalRef));
    } catch (error) {
      output.diagnostics.push(diagnostic("ALLEGRO_CONVERSION_INVALID", error instanceof Error ? error.message : "转换清单无效", "error", "structure", ref));
    }
  }
  for (const asset of inventory) {
    if (consumed.has(asset.id) || asset.fileName === ALLEGRO_MANIFEST) continue;
    asset.irParticipation = "excluded";
    if (asset.detectedFormat !== "allegro") continue;
    const ref = sourceRef(asset.id, asset.relativePath);
    output.recognized++; output.opaque++;
    output.sourceMap.push(ref);
    output.opaqueNodes.push({ recordType: "Allegro.UnconvertedSource", sourcePath: asset.relativePath, payloadHash: asset.sha256 });
    const board = isAllegroBoard(byPath.get(asset.relativePath)!.bytes) && asset.extension === ".brd";
    output.diagnostics.push(diagnostic(board ? "ALLEGRO_CONVERSION_REQUIRED" : "ALLEGRO_DOCUMENT_UNSUPPORTED", board
      ? `${asset.fileName} 为原生 Allegro PCB。请配置在线转换服务，或运行 scripts/allegro-convert.py 后上传生成的 ZIP。尚未生成 PCB IR。`
      : `${asset.fileName} 已保留；当前只支持 Allegro PCB 转换，不解析 OrCAD 原理图或独立库。原理图可附 PDF 作为证据。`, "error", "unsupported", ref, "preserved"));
  }
  return output;
}
