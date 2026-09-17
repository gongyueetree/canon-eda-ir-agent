import type { InputAsset, ParseDiagnostic, SourceAsset, SourceFormat } from "./types";
import { ALLEGRO_MANIFEST, isAllegroBoard } from "./allegro-format";
import { basename, decodeUtf8, diagnostic, extensionOf, sha256, sourceRef, stableId } from "./util";

const KICAD_EXTENSIONS = new Set([".kicad_pro", ".kicad_sch", ".kicad_pcb", ".kicad_sym", ".kicad_mod", ".kicad_dru", ".pro", ".sch"]);
const ALTIUM_EXTENSIONS = new Set([".prjpcb", ".schdoc", ".pcbdoc", ".schlib", ".pcblib", ".intlib", ".outjob", ".dsnwrk", ".bomdoc"]);

function extensionFormat(extension: string): SourceFormat {
  if (KICAD_EXTENSIONS.has(extension)) return "kicad";
  if (ALTIUM_EXTENSIONS.has(extension)) return "altium";
  if ([".opj", ".dra", ".psm", ".pad"].includes(extension)) return "allegro";
  if ([".json", ".jsonl", ".epro", ".eprj", ".epru", ".esch", ".epcb", ".esym", ".efoo", ".ecop"].includes(extension)) return "easyeda";
  return "unknown";
}

function contentFormat(asset: InputAsset): SourceFormat {
  if (basename(asset.path) === ALLEGRO_MANIFEST || isAllegroBoard(asset.bytes)) return "allegro";
  const prefixBytes = asset.bytes.subarray(0, Math.min(asset.bytes.length, 4096));
  if (
    prefixBytes.length >= 8 &&
    [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, index) => prefixBytes[index] === value)
  ) {
    // OrCAD Capture also uses CFB; a container signature alone does not imply Altium.
    return extensionOf(asset.path) === ".dsn" ? "allegro" : ALTIUM_EXTENSIONS.has(extensionOf(asset.path)) ? "altium" : "unknown";
  }
  const text = decodeUtf8(prefixBytes).trimStart();
  if (/^(PCBNEW-BOARD|EESchema Schematic File Version)\b/.test(text)) return "kicad";
  if (/^\((kicad_sch|kicad_pcb|kicad_symbol_lib|footprint)\b/.test(text)) return "kicad";
  if (/^\[(Project|Document|Design)\]/i.test(text) || /DocumentPath\d*=/i.test(text)) return "altium";
  if (text.startsWith("{") || text.startsWith("[")) {
    if (/"(docType|head|canvas|shape|schematics|pcb|easyeda|editorVersion)"/i.test(text)) return "easyeda";
    if (extensionOf(asset.path) === ".kicad_pro") return "kicad";
  }
  return "unknown";
}

function roleFor(extension: string): SourceAsset["entryRole"] {
  if ([".kicad_pro", ".pro", ".prjpcb", ".epro", ".eprj", ".epru"].includes(extension)) return "project";
  if ([".kicad_sch", ".sch", ".schdoc", ".esch"].includes(extension)) return "schematic";
  if ([".kicad_pcb", ".brd", ".pcbdoc", ".epcb"].includes(extension)) return "pcb";
  if ([".kicad_sym", ".schlib", ".esym"].includes(extension)) return "symbol_library";
  if ([".kicad_mod", ".pcblib", ".intlib", ".efoo"].includes(extension)) return "footprint_library";
  if ([".kicad_dru", ".outjob"].includes(extension)) return "rules";
  if ([".json", ".jsonl"].includes(extension)) return "unknown";
  return "attachment";
}

export async function inventoryAssets(inputs: InputAsset[]): Promise<{
  assets: SourceAsset[];
  diagnostics: ParseDiagnostic[];
  sourceFormat: SourceFormat;
}> {
  const diagnostics: ParseDiagnostic[] = [];
  const assets: SourceAsset[] = [];

  for (const input of inputs) {
    const extension = extensionOf(input.path);
    const byExtension = basename(input.path) === ALLEGRO_MANIFEST ? "allegro" : extensionFormat(extension);
    const byContent = contentFormat(input);
    const selected = byContent !== "unknown" ? byContent : byExtension;
    const hash = await sha256(input.bytes);
    const id = stableId("asset", input.path, hash);
    if (extension === ".brd" && selected === "unknown") diagnostics.push(diagnostic("FORMAT_AMBIGUOUS", `${input.path} 未匹配 Allegro 或 KiCad 的内容签名；.brd 扩展名也用于其他 EDA 工具，未静默猜测格式。`, "error", "format", sourceRef(id, input.path)));
    if (byExtension !== "unknown" && byContent !== "unknown" && byExtension !== byContent) {
      diagnostics.push(
        diagnostic(
          "FORMAT_EXTENSION_MISMATCH",
          `${input.path} 的扩展名指向 ${byExtension}，内容签名指向 ${byContent}；已按内容签名处理。`,
          "warning",
          "format",
          sourceRef(id, input.path),
        ),
      );
    }
    assets.push({
      id,
      relativePath: input.path,
      fileName: basename(input.path),
      extension,
      sizeBytes: input.bytes.byteLength,
      sha256: hash,
      detectedFormat: selected,
      entryRole: basename(input.path) === ALLEGRO_MANIFEST ? "project" : roleFor(extension),
      securityStatus: "accepted",
    });
  }

  const counts = assets.reduce<Record<SourceFormat, number>>(
    (result, asset) => {
      result[asset.detectedFormat] += 1;
      return result;
    },
    { kicad: 0, altium: 0, allegro: 0, easyeda: 0, unknown: 0 },
  );
  const allegroEntry = assets.some(a => a.fileName === ALLEGRO_MANIFEST || a.detectedFormat === "allegro" && a.extension === ".brd");
  const sourceFormat = allegroEntry ? "allegro" : (["kicad", "easyeda", "altium", "allegro"] as SourceFormat[]).sort(
    (left, right) => counts[right] - counts[left],
  )[0];
  if (!sourceFormat || counts[sourceFormat] === 0) {
    diagnostics.push(diagnostic("FORMAT_NOT_DETECTED", "未检测到受支持的 EDA 格式。", "error", "format"));
    return { assets, diagnostics, sourceFormat: "unknown" };
  }
  const mixed = (Object.keys(counts) as SourceFormat[]).filter((format) => format !== "unknown" && counts[format] > 0);
  if (mixed.length > 1) {
    diagnostics.push(
      diagnostic(
        "MIXED_FORMAT_PACKAGE",
        sourceFormat === "allegro" ? `工程包包含 ${mixed.join("、")} 文件；Allegro 适配器仅解析清单中哈希匹配的转换产物，未关联文件保留在清单。` : `工程包包含 ${mixed.join("、")} 文件；主适配器选择 ${sourceFormat}，其他格式作为交叉证据保留。`,
        "information",
        "format",
        undefined,
        "preserved",
      ),
    );
  }
  return { assets, diagnostics, sourceFormat };
}
