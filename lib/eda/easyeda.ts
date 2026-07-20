import type { KicadParseOutput } from "./kicad";
import type { InputAsset, NetIr, PartIr, SourceAsset, SourceRef } from "./types";
import { decodeUtf8, diagnostic, sourceRef, stableId, withoutExtension } from "./util";

type ShapeRecord = { prefix: string; fields: string[]; raw: string };

function parseShapeRecord(raw: string): ShapeRecord {
  const fields: string[] = [];
  let value = "";
  let escaped = false;
  for (const character of raw) {
    if (escaped) {
      value += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      value += character;
      continue;
    }
    if (character === "~") {
      fields.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  fields.push(value);
  return { prefix: fields[0] ?? "UNKNOWN", fields, raw };
}

function collectStructuredObjects(root: unknown, maxDepth = 32): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > 250_000 || current.depth > maxDepth) continue;
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    const object = current.value as Record<string, unknown>;
    if (
      ["ref", "reference", "designator", "refdes"].some((key) => typeof object[key] === "string") ||
      ["pad", "wire", "junction", "track", "via", "footprint"].includes(String(object.type ?? "").toLowerCase())
    ) {
      found.push(object);
    }
    for (const value of Object.values(object)) pending.push({ value, depth: current.depth + 1 });
  }
  return found;
}

function stringField(object: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof object[key] === "string") return object[key] as string;
    if (typeof object[key] === "number") return String(object[key]);
  }
  return undefined;
}

export function parseEasyEda(inputs: InputAsset[], inventory: SourceAsset[]): KicadParseOutput {
  const output: KicadParseOutput = {
    settings: {}, schematics: [], pcbs: [], parts: [], nets: [], constraints: [], libraries: [], sourceMap: [], diagnostics: [], opaqueNodes: [], recognized: 0, normalized: 0, opaque: 0,
  };
  const byPath = new Map(inputs.map((input) => [input.path, input]));
  const parts = new Map<string, PartIr>();
  const sourceRefs: SourceRef[] = [];
  const knownShapePrefixes = new Set(["LIB", "WIRE", "J", "N", "O", "F", "PL", "R", "C", "A", "T", "P", "PT", "VIA", "PAD", "TRACK", "COPPERAREA", "SOLIDREGION", "SVGNODE"]);
  const shapeCounts = new Map<string, number>();
  let documentCount = 0;

  for (const asset of inventory.filter((item) => item.detectedFormat === "easyeda")) {
    const input = byPath.get(asset.relativePath);
    if (!input) continue;
    const ref = sourceRef(asset.id, asset.relativePath);
    sourceRefs.push(ref);
    const text = decodeUtf8(input.bytes);
    const documents: unknown[] = [];
    try {
      if (asset.extension === ".jsonl") {
        const lines = text.split(/\r?\n/).filter(Boolean);
        for (const [index, line] of lines.entries()) {
          try {
            documents.push(JSON.parse(line));
          } catch {
            output.diagnostics.push(diagnostic("PARSER_SYNTAX_ERROR", `${asset.relativePath} 第 ${index + 1} 行不是有效 JSON，已保留原始行。`, "warning", "syntax", { ...ref, jsonPath: `$[${index}]` }, "preserved"));
            output.opaque += 1;
          }
        }
        output.sourceToolVersion ??= "EasyEDA Pro / JSONL";
      } else {
        documents.push(JSON.parse(text));
      }
    } catch {
      output.diagnostics.push(diagnostic("PARSER_SYNTAX_ERROR", `${asset.relativePath} 不是有效的 EasyEDA/JLCEDA JSON。`, "error", "syntax", ref));
      continue;
    }

    for (const [documentIndex, document] of documents.entries()) {
      documentCount += 1;
      if (!document || typeof document !== "object") continue;
      const object = document as Record<string, unknown>;
      const head = object.head && typeof object.head === "object" ? (object.head as Record<string, unknown>) : {};
      output.projectName ??= stringField(object, ["projectName", "name", "title"]) ?? withoutExtension(asset.fileName);
      output.sourceToolVersion ??= stringField(head, ["editorVersion", "version"]);
      output.sourceFormatVersion ??= stringField(object, ["version", "documentVersion"]);
      if (object.canvas && typeof object.canvas === "string") output.settings.canvas = object.canvas;
      const shapeValues: string[] = [];
      if (Array.isArray(object.shape)) {
        for (const shape of object.shape) if (typeof shape === "string") shapeValues.push(shape);
      }
      if (Array.isArray(object.shapes)) {
        for (const shape of object.shapes) if (typeof shape === "string") shapeValues.push(shape);
      }
      for (const shape of shapeValues) {
        const parsed = parseShapeRecord(shape);
        shapeCounts.set(parsed.prefix, (shapeCounts.get(parsed.prefix) ?? 0) + 1);
        output.recognized += 1;
        if (!knownShapePrefixes.has(parsed.prefix)) {
          output.opaqueNodes.push({ recordType: `EasyEDA.Shape.${parsed.prefix}`, sourcePath: asset.relativePath, payloadHash: asset.sha256 });
          output.opaque += 1;
        } else {
          output.normalized += 1;
        }
      }

      const structuredObjects = collectStructuredObjects(object);
      for (const [objectIndex, structured] of structuredObjects.entries()) {
        const reference = stringField(structured, ["ref", "reference", "designator", "refdes"]);
        if (!reference || parts.has(reference)) continue;
        const objectRef = sourceRef(asset.id, asset.relativePath, "explicit", { jsonPath: `$[${documentIndex}].objects[${objectIndex}]` });
        const fields: Record<string, string> = {};
        for (const [key, value] of Object.entries(structured)) {
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") fields[key] = String(value);
        }
        parts.set(reference, {
          id: stableId("part", asset.sha256, reference),
          logicalPartKey: reference,
          reference,
          value: stringField(structured, ["value", "name", "comment"]) ?? "",
          symbolUnits: [{ id: stableId("symbol-unit", asset.sha256, reference), unit: 1 }],
          footprint: stringField(structured, ["footprint", "package", "packageName"]),
          fields,
          manufacturerRaw: stringField(structured, ["manufacturer", "Manufacturer"]),
          mpnRaw: stringField(structured, ["mpn", "MPN", "manufacturerPartNumber"]),
          variantStatus: ["1", "true", "yes"].includes(String(structured.dnp ?? structured.DNP ?? "").toLowerCase()) ? "dnp" : "fitted",
          pinPadMap: [],
          sourceRefs: [objectRef],
        });
        sourceRefs.push(objectRef);
      }
    }
  }

  output.parts = Array.from(parts.values());
  output.sourceMap = sourceRefs;
  output.schematics = documentCount
    ? [{
        id: stableId("schematic", output.projectName, "easyeda"),
        documentId: stableId("document", output.projectName, "easyeda"),
        name: output.projectName ?? "EasyEDA project",
        rootSheetId: stableId("sheet", output.projectName, "/"),
        sheets: Array.from({ length: documentCount }, (_, index) => ({ id: stableId("sheet", output.projectName, index), name: `Sheet ${index + 1}`, instancePath: `/${index + 1}` })),
        symbolInstanceIds: output.parts.flatMap((part) => part.symbolUnits.map((unit) => unit.id)),
        wires: [], junctions: [], labels: [], noConnects: [],
        connectivityGraphId: stableId("connectivity", output.projectName, "easyeda"),
        sourceRefs,
      }]
    : [];
  output.libraries = Array.from(shapeCounts.entries()).map(([prefix, count]) => ({
    id: stableId("easyeda-shape-family", prefix),
    type: "shape_family",
    name: prefix,
    objectCount: count,
    resolutionStatus: knownShapePrefixes.has(prefix) ? "recognized" : "opaque_preserved",
  }));
  const netObjects = output.parts.flatMap(() => []) as NetIr[];
  output.nets.push(...netObjects);
  output.diagnostics.push(
    diagnostic(
      "EASYEDA_CONNECTIVITY_PARTIAL",
      "EasyEDA/JLCEDA 标准 JSON 的文档、器件与 Shape 已保留；首版仅对显式结构字段规范化，未对不稳定 Shape 字段位置猜测连通性。",
      "warning",
      "connectivity",
      sourceRefs[0],
      "preserved",
    ),
  );
  return output;
}
