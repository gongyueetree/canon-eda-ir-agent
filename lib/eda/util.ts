import type { IrPoint, ParseDiagnostic, SourceRef } from "./types";

export function stableId(namespace: string, ...parts: Array<string | number | undefined>): string {
  const input = `${namespace}:${parts.map((part) => String(part ?? "")).join("|")}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  const hex = `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
  return `${namespace}_${hex}`;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const safeBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", safeBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function point(x?: string, y?: string): IrPoint | undefined {
  if (x === undefined || y === undefined) return undefined;
  return { x, y, unit: "mm", raw: [x, y] };
}

export function sourceRef(
  assetId: string,
  path: string,
  resolutionMethod: SourceRef["resolutionMethod"] = "explicit",
  extra: Partial<SourceRef> = {},
): SourceRef {
  return { assetId, path, resolutionMethod, ...extra };
}

export function diagnostic(
  code: string,
  message: string,
  severity: ParseDiagnostic["severity"] = "warning",
  category: ParseDiagnostic["category"] = "structure",
  ref?: SourceRef,
  preservationStatus: ParseDiagnostic["preservationStatus"] = "not_applicable",
): ParseDiagnostic {
  return {
    id: stableId("diag", code, ref?.path, message),
    code,
    message,
    severity,
    category,
    sourceRef: ref,
    preservationStatus,
  };
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function withoutExtension(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "");
}

export function numericString(value: unknown, fallback = "0"): string {
  if (typeof value === "string" && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}
