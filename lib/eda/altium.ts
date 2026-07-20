import type { KicadParseOutput } from "./kicad";
import type { InputAsset, SourceAsset } from "./types";
import { decodeUtf8, diagnostic, sourceRef, stableId, withoutExtension } from "./util";

function parseProjectText(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let section = "root";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      result[section] ??= {};
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (section === "root") result[key] = value;
    else (result[section] as Record<string, unknown>)[key] = value;
  }
  return result;
}

function isCfb(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, index) => bytes[index] === value);
}

export function parseAltium(inputs: InputAsset[], inventory: SourceAsset[]): KicadParseOutput {
  const output: KicadParseOutput = {
    settings: {}, schematics: [], pcbs: [], parts: [], nets: [], constraints: [], libraries: [], sourceMap: [], diagnostics: [], opaqueNodes: [], recognized: 0, normalized: 0, opaque: 0,
  };
  const byPath = new Map(inputs.map((input) => [input.path, input]));
  for (const asset of inventory.filter((item) => item.detectedFormat === "altium")) {
    const input = byPath.get(asset.relativePath);
    if (!input) continue;
    const ref = sourceRef(asset.id, asset.relativePath);
    output.sourceMap.push(ref);
    if (asset.extension === ".prjpcb" || asset.extension === ".dsnwrk") {
      const metadata = parseProjectText(decodeUtf8(input.bytes));
      output.projectName ??= withoutExtension(asset.fileName);
      output.settings = { ...output.settings, ...metadata };
      output.recognized += Object.keys(metadata).length;
      output.normalized += Object.keys(metadata).length;
      continue;
    }
    if (isCfb(input.bytes)) {
      output.opaqueNodes.push({ recordType: `Altium.CFB${asset.extension}`, sourcePath: asset.relativePath, payloadHash: asset.sha256 });
      output.opaque += 1;
      output.recognized += 1;
      output.diagnostics.push(
        diagnostic(
          "ALTIUM_CFB_STRUCTURE_ONLY",
          `${asset.relativePath} 已通过 CFB/OLE 签名检查并按原始 Hash 保留。当前 Web MVP 不解释专有 Record，避免产生错误器件或连通关系。`,
          "warning",
          "unsupported",
          ref,
          "preserved",
        ),
      );
    } else {
      output.opaqueNodes.push({ recordType: `Altium.Asset${asset.extension}`, sourcePath: asset.relativePath, payloadHash: asset.sha256 });
      output.opaque += 1;
      output.diagnostics.push(diagnostic("SOURCE_FILE_CORRUPTED", `${asset.relativePath} 的内容与预期 Altium 容器签名不一致。`, "error", "format", ref, "preserved"));
    }
  }
  output.projectName ??= inventory.find((asset) => asset.detectedFormat === "altium") ? withoutExtension(inventory.find((asset) => asset.detectedFormat === "altium")!.fileName) : "Altium project";
  output.sourceToolVersion = "Altium (version unresolved)";
  if (!output.normalized) {
    output.diagnostics.push(diagnostic("UNSUPPORTED_FORMAT", "Altium 专有 SchDoc/PcbDoc 当前为结构级安全摄取；完整 Record Adapter 已在能力矩阵中标记为后续阶段。", "warning", "unsupported", output.sourceMap[0], "preserved"));
  }
  output.libraries = output.opaqueNodes.filter((node) => /lib/i.test(node.sourcePath)).map((node) => ({ id: stableId("library", node.sourcePath), name: node.sourcePath, type: "altium_container", resolutionStatus: "opaque_preserved" }));
  return output;
}
