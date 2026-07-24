import { unzipSync } from "fflate";
import type { InputAsset, ParseDiagnostic } from "./types";
import { decodeUtf8, diagnostic, extensionOf } from "./util";

const LIMITS = {
  maxCompressedBytes: 75 * 1024 * 1024,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxSingleFileBytes: 50 * 1024 * 1024,
  maxEntries: 5_000,
  maxCompressionRatio: 200,
};

function hasZipSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const signature = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  return signature === 0x04034b50 || signature === 0x06054b50 || signature === 0x08074b50;
}

type IgnoredEntryKind = "platform" | "history" | "vcs" | "eda_local";

function ignoredEntryKind(path: string): IgnoredEntryKind | undefined {
  const segments = path.replace(/\\/g, "/").split("/");
  const name = segments.at(-1) ?? "";
  if (segments.includes("__MACOSX") || segments.some((segment) => segment.startsWith("._")) || segments.at(-1) === ".DS_Store") {
    return "platform";
  }
  if (segments.includes(".history")) return "history";
  if (segments.some((segment) => [".git", ".hg", ".svn"].includes(segment))) return "vcs";
  if (
    name.toLowerCase().endsWith(".kicad_prl") ||
    name === "fp-info-cache" ||
    /^~.+\.lck$/i.test(name) ||
    segments.some((segment) => /-backups$/i.test(segment))
  ) {
    return "eda_local";
  }
  return undefined;
}

function safePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error(`ARCHIVE_PATH_TRAVERSAL: ${path}`);
  }
  return normalized;
}

function inspectZip(bytes: Uint8Array): void {
  if (bytes.byteLength > LIMITS.maxCompressedBytes) {
    throw new Error("PARSER_RESOURCE_LIMIT: compressed package is too large");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let entries = 0;
  let compressedTotal = 0;
  let uncompressedTotal = 0;

  for (let offset = 0; offset + 46 <= bytes.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    entries += 1;
    if (entries > LIMITS.maxEntries) throw new Error("ARCHIVE_BOMB_DETECTED: entry limit exceeded");

    const flags = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) throw new Error("SOURCE_FILE_CORRUPTED: invalid ZIP directory");
    const path = decodeUtf8(bytes.subarray(nameStart, nameEnd));
    if (!path.endsWith("/")) safePath(path);
    if (flags & 0x0001) throw new Error("SECURITY_BLOCKED: encrypted ZIP entries are not accepted");

    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) throw new Error("SECURITY_BLOCKED: symlink ZIP entry rejected");
    if (uncompressed > LIMITS.maxSingleFileBytes) {
      throw new Error(`PARSER_RESOURCE_LIMIT: ${path} exceeds the single-file limit`);
    }
    compressedTotal += compressed;
    uncompressedTotal += uncompressed;
    if (uncompressedTotal > LIMITS.maxUncompressedBytes) {
      throw new Error("ARCHIVE_BOMB_DETECTED: uncompressed size limit exceeded");
    }
    if (compressed > 0 && uncompressed / compressed > LIMITS.maxCompressionRatio) {
      throw new Error(`ARCHIVE_BOMB_DETECTED: suspicious compression ratio for ${path}`);
    }
    offset = nameEnd + extraLength + commentLength - 1;
  }

  if (entries === 0) throw new Error("SOURCE_FILE_CORRUPTED: ZIP central directory not found");
  if (compressedTotal > 0 && uncompressedTotal / compressedTotal > LIMITS.maxCompressionRatio) {
    throw new Error("ARCHIVE_BOMB_DETECTED: package compression ratio is too high");
  }
}

export async function filesToInputAssets(files: File[]): Promise<{
  assets: InputAsset[];
  diagnostics: ParseDiagnostic[];
}> {
  if (!files.length) throw new Error("SOURCE_PACKAGE_EMPTY: select at least one file");
  const diagnostics: ParseDiagnostic[] = [];
  const assets: InputAsset[] = [];
  const ignoredEntries: Record<IgnoredEntryKind, number> = { platform: 0, history: 0, vcs: 0, eda_local: 0 };
  let totalBytes = 0;

  for (const file of files) {
    const suppliedPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const suppliedPathKind = ignoredEntryKind(suppliedPath);
    if (suppliedPathKind) {
      ignoredEntries[suppliedPathKind] += 1;
      continue;
    }
    totalBytes += file.size;
    if (totalBytes > LIMITS.maxCompressedBytes) {
      throw new Error("PARSER_RESOURCE_LIMIT: upload selection exceeds 75 MB");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (hasZipSignature(bytes)) {
      inspectZip(bytes);
      const entries = unzipSync(bytes);
      for (const [entryPath, entryBytes] of Object.entries(entries)) {
        if (entryPath.endsWith("/")) continue;
        const path = safePath(entryPath);
        const entryKind = ignoredEntryKind(path);
        if (entryKind) {
          ignoredEntries[entryKind] += 1;
          continue;
        }
        if ([".zip", ".7z", ".rar", ".tar", ".gz"].includes(extensionOf(path))) {
          diagnostics.push(
            diagnostic(
              "ARCHIVE_NESTING_LIMIT",
              `嵌套压缩包 ${path} 已作为不透明附件保留，未继续解压。`,
              "warning",
              "security",
              undefined,
              "preserved",
            ),
          );
        }
        assets.push({ path, bytes: entryBytes });
      }
    } else {
      if (bytes.byteLength > LIMITS.maxSingleFileBytes) {
        throw new Error(`PARSER_RESOURCE_LIMIT: ${file.name} exceeds 50 MB`);
      }
      assets.push({ path: safePath(suppliedPath), bytes });
    }
  }

  if (ignoredEntries.platform > 0) {
    diagnostics.push(
      diagnostic(
        "ARCHIVE_METADATA_IGNORED",
        `已忽略 ${ignoredEntries.platform} 个平台元数据条目（__MACOSX、AppleDouble 或 .DS_Store）。`,
        "information",
        "structure",
      ),
    );
  }
  if (ignoredEntries.history > 0) {
    diagnostics.push(
      diagnostic(
        "PROJECT_HISTORY_IGNORED",
        `已忽略 ${ignoredEntries.history} 个本地历史条目（.history）；历史快照不会作为当前工程重复解析。`,
        "information",
        "structure",
      ),
    );
  }
  if (ignoredEntries.vcs > 0) {
    diagnostics.push(
      diagnostic(
        "VCS_METADATA_IGNORED",
        `已忽略 ${ignoredEntries.vcs} 个版本控制元数据条目（.git、.hg 或 .svn）。`,
        "information",
        "structure",
      ),
    );
  }
  if (ignoredEntries.eda_local > 0) {
    diagnostics.push(
      diagnostic(
        "EDA_LOCAL_STATE_IGNORED",
        `已忽略 ${ignoredEntries.eda_local} 个 EDA 本机状态、缓存或备份条目（如 .kicad_prl、fp-info-cache、锁文件或备份目录）。`,
        "information",
        "structure",
      ),
    );
  }
  if (assets.length > LIMITS.maxEntries) throw new Error("PARSER_RESOURCE_LIMIT: too many files");
  return { assets, diagnostics };
}

export function createDemoFiles(): File[] {
  const schematic = `(kicad_sch (version 20250114) (generator eeschema)
  (uuid 00000000-0000-0000-0000-000000000001)
  (paper "A4")
  (lib_symbols
    (symbol "Device:R" (pin passive line (at -2.54 0 0) (length 2.54) (name "~") (number "1")) (pin passive line (at 2.54 0 180) (length 2.54) (name "~") (number "2")))
    (symbol "Device:LED" (pin passive line (at -2.54 0 0) (length 2.54) (name "K") (number "1")) (pin passive line (at 2.54 0 180) (length 2.54) (name "A") (number "2"))))
  (junction (at 40 30) (diameter 0) (color 0 0 0 0) (uuid 10000000-0000-0000-0000-000000000001))
  (wire (pts (xy 20 30) (xy 40 30)) (stroke (width 0) (type default)) (uuid 20000000-0000-0000-0000-000000000001))
  (wire (pts (xy 45.08 30) (xy 64.92 30)) (stroke (width 0) (type default)) (uuid 20000000-0000-0000-0000-000000000002))
  (wire (pts (xy 40 20) (xy 40 40)) (stroke (width 0) (type default)) (uuid 20000000-0000-0000-0000-000000000003))
  (wire (pts (xy 55 20) (xy 55 40)) (stroke (width 0) (type default)) (uuid 20000000-0000-0000-0000-000000000004))
  (global_label "+3V3" (shape input) (at 20 30 180) (uuid 30000000-0000-0000-0000-000000000001))
  (label "LED_A" (at 50 30 0) (uuid 30000000-0000-0000-0000-000000000002))
  (symbol (lib_id "Device:R") (at 42.54 30 0) (unit 1) (in_bom yes) (on_board yes) (uuid 40000000-0000-0000-0000-000000000001)
    (property "Reference" "R1" (at 42.54 27 0)) (property "Value" "1k" (at 42.54 33 0)) (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 42.54 30 0)))
  (symbol (lib_id "Device:LED") (at 67.46 30 0) (unit 1) (in_bom yes) (on_board yes) (uuid 40000000-0000-0000-0000-000000000002)
    (property "Reference" "D1" (at 67.46 27 0)) (property "Value" "GREEN" (at 67.46 33 0)) (property "Footprint" "LED_SMD:LED_0603_1608Metric" (at 67.46 30 0))))`;

  const pcb = `(kicad_pcb (version 20250114) (generator pcbnew)
  (general (thickness 1.6))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (36 "B.SilkS" user "b.silkscreen") (37 "F.SilkS" user "f.silkscreen") (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "") (net 1 "+3V3") (net 2 "LED_A")
  (footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (at 42.54 30) (uuid 50000000-0000-0000-0000-000000000001)
    (property "Reference" "R1" (at 0 -1.43 0) (layer "F.SilkS")) (property "Value" "1k" (at 0 1.43 0) (layer "F.Fab"))
    (pad "1" smd roundrect (at -0.775 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "+3V3"))
    (pad "2" smd roundrect (at 0.775 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 2 "LED_A")))
  (footprint "LED_SMD:LED_0603_1608Metric" (layer "F.Cu") (at 67.46 30) (uuid 50000000-0000-0000-0000-000000000002)
    (property "Reference" "D1" (at 0 -1.43 0) (layer "F.SilkS")) (property "Value" "GREEN" (at 0 1.43 0) (layer "F.Fab"))
    (pad "1" smd roundrect (at -0.775 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 2 "LED_A"))
    (pad "2" smd roundrect (at 0.775 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 0 "")))
  (segment (start 43.315 30) (end 66.685 30) (width 0.25) (layer "F.Cu") (net 2))
  (via (at 55 30) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 2))
  (gr_rect (start 10 10) (end 90 50) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts")))`;

  const project = JSON.stringify(
    { board: {}, meta: { filename: "signal-beacon.kicad_pro", version: 1 }, net_settings: { classes: [] }, text_variables: { product: "Signal Beacon" } },
    null,
    2,
  );
  return [
    new File([project], "signal-beacon.kicad_pro", { type: "application/json" }),
    new File([schematic], "signal-beacon.kicad_sch", { type: "text/plain" }),
    new File([pcb], "signal-beacon.kicad_pcb", { type: "text/plain" }),
  ];
}
