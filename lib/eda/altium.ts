import type { KicadParseOutput } from "./kicad";
import { parseAltiumNative } from "./altium-native";
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
    if (asset.extension === ".outjob") {
      const configuration = decodeUtf8(input.bytes);
      output.settings = {
        ...output.settings,
        outJobs: [
          ...((output.settings.outJobs as Array<Record<string, unknown>> | undefined) ?? []),
          { path: asset.relativePath, text: configuration },
        ],
      };
      output.recognized += 1;
      output.normalized += 1;
      output.diagnostics.push(
        diagnostic(
          "ALTIUM_OUTJOB_PRESERVED",
          `${asset.relativePath} 已作为 Altium 输出任务配置保留；它不是 CFB 设计文档。`,
          "information",
          "structure",
          ref,
          "preserved",
        ),
      );
      continue;
    }
    if (isCfb(input.bytes)) {
      if ([".schdoc", ".pcbdoc"].includes(asset.extension)) {
        const native: KicadParseOutput = { settings: {}, schematics: [], pcbs: [], parts: [], nets: [], constraints: [], libraries: [], sourceMap: [], diagnostics: [], opaqueNodes: [], recognized: 0, normalized: 0, opaque: 0 };
        try {
          parseAltiumNative(input.bytes, asset, native);
          output.schematics.push(...native.schematics); output.pcbs.push(...native.pcbs);
          output.parts.push(...native.parts); output.nets.push(...native.nets);
          output.diagnostics.push(...native.diagnostics);
          output.normalized += native.normalized; output.recognized += native.recognized;
          output.opaqueNodes.push({ recordType: `Altium.Partial${asset.extension}`, sourcePath: asset.relativePath, payloadHash: asset.sha256 });
          output.opaque += 1;
          continue;
        } catch (error) {
          output.diagnostics.push(diagnostic("ALTIUM_NATIVE_UNSUPPORTED", `${asset.relativePath}: ${error instanceof Error ? error.message : "解析失败"}；保留原文件，未输出该文档的部分错误实体。`, "warning", "unsupported", ref, "preserved"));
        }
      }
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
      output.diagnostics.push(
        diagnostic(
          "ALTIUM_CONTAINER_UNRECOGNIZED",
          `${asset.relativePath} 不是可识别的 CFB 容器；文件已按 Hash 原样保留，未据此生成语义实体。`,
          "warning",
          "unsupported",
          ref,
          "preserved",
        ),
      );
    }
  }
  output.projectName ??= inventory.find((asset) => asset.detectedFormat === "altium") ? withoutExtension(inventory.find((asset) => asset.detectedFormat === "altium")!.fileName) : "Altium project";
  for (const part of output.parts) {
    const matches = output.pcbs.flatMap(p => p.footprints).filter(f => f.reference === part.reference);
    if (matches.length === 1) {
      part.footprint = matches[0].libraryIdentifier;
      part.footprintInstanceId = matches[0].id;
    }
  }
  output.sourceToolVersion = "Altium (version unresolved)";
  if (!output.normalized) {
    output.diagnostics.push(diagnostic("UNSUPPORTED_FORMAT", "Altium 专有 SchDoc/PcbDoc 当前为结构级安全摄取；完整 Record Adapter 已在能力矩阵中标记为后续阶段。", "warning", "unsupported", output.sourceMap[0], "preserved"));
  }
  output.libraries = output.opaqueNodes.filter((node) => /lib/i.test(node.sourcePath)).map((node) => ({ id: stableId("library", node.sourcePath), name: node.sourcePath, type: "altium_container", resolutionStatus: "opaque_preserved" }));
  return output;
}
