import type { KicadParseOutput } from "./kicad";
import type {
  InputAsset,
  NetEndpoint,
  NetIr,
  PartIr,
  PcbIr,
  SchematicIr,
  SourceAsset,
  SourceRef,
} from "./types";
import { decodeUtf8, diagnostic, point, sourceRef, stableId, withoutExtension } from "./util";

type JsonObject = Record<string, unknown>;
type ShapeRecord = { prefix: string; fields: string[]; raw: string };
type StandardDocument = { object: JsonObject; asset: SourceAsset; ref: SourceRef; name: string; jsonPath: string };

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function parseShapeRecord(raw: string): ShapeRecord {
  const fields: string[] = [];
  let value = "";
  let escaped = false;
  for (const character of raw) {
    if (escaped) {
      value += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
      value += character;
    } else if (character === "~") {
      fields.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  fields.push(value);
  return { prefix: fields[0] ?? "UNKNOWN", fields, raw };
}

function sourceDocType(object: JsonObject): string {
  const head = asObject(object.head);
  return stringValue(object.docType) ?? stringValue(head?.docType) ?? "";
}

function shapesOf(object: JsonObject): string[] {
  const values = Array.isArray(object.shape) ? object.shape : Array.isArray(object.shapes) ? object.shapes : [];
  return values.filter((value): value is string => typeof value === "string");
}

function standardDocuments(root: JsonObject, asset: SourceAsset, ref: SourceRef): StandardDocument[] {
  if (sourceDocType(root) === "5" && Array.isArray(root.schematics)) {
    return root.schematics.flatMap((entry, index) => {
      const wrapper = asObject(entry);
      const data = asObject(wrapper?.dataStr) ?? wrapper;
      if (!data) return [];
      return [{
        object: data,
        asset,
        ref: sourceRef(asset.id, asset.relativePath, "embedded", { jsonPath: `$.schematics[${index}].dataStr` }),
        name: stringValue(wrapper?.title) ?? stringValue(data.title) ?? `Sheet ${index + 1}`,
        jsonPath: `$.schematics[${index}].dataStr`,
      }];
    });
  }
  return [{
    object: root,
    asset,
    ref,
    name: stringValue(root.title) ?? withoutExtension(asset.fileName),
    jsonPath: "$",
  }];
}

function coordinateKey(x: string, y: string): string {
  const clean = (value: string) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Number(numeric.toFixed(6)).toString() : value;
  };
  return `${clean(x)},${clean(y)}`;
}

function pointsFromSpaceList(value: string): Array<{ x: string; y: string }> {
  const tokens = value.trim().split(/\s+/);
  const points: Array<{ x: string; y: string }> = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    if (Number.isFinite(Number(tokens[index])) && Number.isFinite(Number(tokens[index + 1]))) {
      points.push({ x: tokens[index], y: tokens[index + 1] });
    }
  }
  return points;
}

function packageField(value: string): string | undefined {
  const match = value.match(/(?:^|`)package`([^`]*)/i);
  return match?.[1] || undefined;
}

function textChildValue(children: string[], marker: "P" | "N"): string {
  for (const child of children) {
    const fields = parseShapeRecord(child).fields;
    if (fields[0] === "T" && fields[1] === marker) return fields[12] ?? fields.at(-1) ?? "";
    if (fields[0] === "TEXT" && fields[1] === marker) return fields[10] ?? fields.at(-1) ?? "";
  }
  return "";
}

function labelName(record: ShapeRecord): string {
  const colored = record.raw.match(/\^\^([^~^]+)~#[0-9a-f]{3,8}(?:~|$)/i);
  if (colored?.[1]) return colored[1];
  const chunks = record.raw.split("^^");
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const candidate = chunks[index].split("~")[0]?.trim();
    if (candidate && !Number.isFinite(Number(candidate)) && !candidate.startsWith("#")) return candidate;
  }
  return "";
}

class UnionFind {
  private parent = new Map<string, string>();

  add(value: string): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: string): string {
    this.add(value);
    const parent = this.parent.get(value)!;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  join(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}

function parseStandardSchematic(
  documents: StandardDocument[],
  output: KicadParseOutput,
  partsByReference: Map<string, PartIr>,
  shapeCounts: Map<string, number>,
): void {
  if (!documents.length) return;
  const projectKey = output.projectName ?? documents[0].name;
  const schematicId = stableId("schematic", projectKey, documents.map((document) => document.asset.sha256).join("|"));
  const documentId = stableId("document", schematicId);
  const sheets: SchematicIr["sheets"] = [];
  const wires: SchematicIr["wires"] = [];
  const junctions: SchematicIr["junctions"] = [];
  const labels: SchematicIr["labels"] = [];
  const pins: SchematicIr["pins"] = [];
  const symbolInstanceIds: string[] = [];
  const sourceRefs: SourceRef[] = [];
  const wireSheet = new Map<string, string>();
  const labelSheet = new Map<string, string>();
  const pinSheet = new Map<string, string>();

  for (const [sheetIndex, document] of documents.entries()) {
    const sheetId = stableId("sheet", schematicId, sheetIndex, document.name);
    sheets.push({ id: sheetId, name: document.name, instancePath: `/${sheetIndex + 1}` });
    sourceRefs.push(document.ref);
    for (const [shapeIndex, raw] of shapesOf(document.object).entries()) {
      const record = parseShapeRecord(raw);
      shapeCounts.set(record.prefix, (shapeCounts.get(record.prefix) ?? 0) + 1);
      output.recognized += 1;
      const nativeId = record.fields.find((field) => /^gge[0-9a-z]+$/i.test(field)) ?? `${sheetIndex}:${shapeIndex}`;
      const shapeRef = sourceRef(document.asset.id, document.asset.relativePath, "explicit", {
        nativeId,
        jsonPath: `${document.jsonPath}.shape[${shapeIndex}]`,
      });
      if (record.prefix === "W" || record.prefix === "WIRE") {
        const vertices = pointsFromSpaceList(record.fields[1] ?? "");
        if (vertices.length >= 2) {
          const id = stableId("wire", schematicId, sheetId, nativeId);
          wires.push({ id, points: vertices.map((vertex) => point(vertex.x, vertex.y)!), sourceRef: shapeRef });
          wireSheet.set(id, sheetId);
          output.normalized += 1;
        }
        continue;
      }
      if (record.prefix === "J") {
        const position = point(record.fields[1], record.fields[2]);
        if (position) {
          const id = stableId("junction", schematicId, sheetId, nativeId);
          junctions.push({ id, position, sourceRef: shapeRef });
          output.normalized += 1;
        }
        continue;
      }
      if (["F", "N"].includes(record.prefix)) {
        const name = labelName(record);
        const x = record.prefix === "F" ? record.fields[2] : record.fields[1];
        const y = record.prefix === "F" ? record.fields[3] : record.fields[2];
        const position = point(x, y);
        if (name && position) {
          const id = stableId("label", schematicId, sheetId, nativeId, name);
          labels.push({ id, name, kind: /netPort|global/i.test(record.fields[1] ?? "") ? "global" : "local", position, sourceRef: shapeRef });
          labelSheet.set(id, sheetId);
          output.normalized += 1;
        }
        continue;
      }
      if (record.prefix !== "LIB") continue;
      const children = raw.split("#@$");
      const main = parseShapeRecord(children.shift() ?? raw);
      const reference = textChildValue(children, "P").trim();
      if (!reference || !/^[A-Za-z_#][A-Za-z0-9_#.-]*\d[A-Za-z0-9_#.-]*$/.test(reference)) continue;
      const value = textChildValue(children, "N").trim();
      const existingPart = partsByReference.get(reference);
      const partId = existingPart?.id ?? stableId("part", schematicId, sheetId, reference);
      const symbolUnitId = stableId("symbol-unit", partId, 1);
      const fields: Record<string, string> = {};
      for (const token of (main.fields[3] ?? "").split("`")) {
        if (token.includes("=")) {
          const separator = token.indexOf("=");
          fields[token.slice(0, separator)] = token.slice(separator + 1);
        }
      }
      const part: PartIr = existingPart ?? {
        id: partId,
        logicalPartKey: reference,
        reference,
        value,
        symbolUnits: [{ id: symbolUnitId, unit: 1, position: point(main.fields[1], main.fields[2]), rotation: main.fields[4] ?? "0" }],
        footprint: packageField(main.fields[3] ?? ""),
        fields,
        variantStatus: "fitted",
        pinPadMap: [],
        sourceRefs: [shapeRef],
      };
      if (!existingPart) partsByReference.set(reference, part);
      symbolInstanceIds.push(symbolUnitId);
      output.normalized += 1;
      for (const [childIndex, child] of children.entries()) {
        const childRecord = parseShapeRecord(child);
        if (childRecord.prefix !== "P") continue;
        const number = childRecord.fields[3] ?? "";
        const position = point(childRecord.fields[4], childRecord.fields[5]);
        if (!number || !position) continue;
        const pinId = stableId("pin", partId, sheetId, number, childIndex);
        const pinRef = sourceRef(document.asset.id, document.asset.relativePath, "embedded", {
          nativeId: childRecord.fields[7] || `${nativeId}:pin:${childIndex}`,
          jsonPath: `${document.jsonPath}.shape[${shapeIndex}]`,
        });
        pins.push({ id: pinId, partId, symbolUnitId, reference, number, name: "", position, sourceRef: pinRef });
        pinSheet.set(pinId, sheetId);
        output.normalized += 1;
      }
    }
  }

  const union = new UnionFind();
  for (const wire of wires) {
    for (let index = 1; index < wire.points.length; index += 1) {
      union.join(coordinateKey(wire.points[index - 1].x, wire.points[index - 1].y), coordinateKey(wire.points[index].x, wire.points[index].y));
    }
  }
  const groupForPosition = (x: string, y: string) => union.find(coordinateKey(x, y));
  const groupWires = new Map<string, string[]>();
  for (const wire of wires) {
    const root = groupForPosition(wire.points[0].x, wire.points[0].y);
    (groupWires.get(root) ?? groupWires.set(root, []).get(root)!).push(wire.id);
  }
  const groupLabels = new Map<string, typeof labels>();
  for (const label of labels) {
    const root = groupForPosition(label.position.x, label.position.y);
    (groupLabels.get(root) ?? groupLabels.set(root, []).get(root)!).push(label);
  }
  const groupPins = new Map<string, typeof pins>();
  for (const pinEntity of pins) {
    const root = groupForPosition(pinEntity.position.x, pinEntity.position.y);
    (groupPins.get(root) ?? groupPins.set(root, []).get(root)!).push(pinEntity);
  }
  const roots = new Set([...groupWires.keys(), ...groupLabels.keys(), ...groupPins.keys()]);
  for (const root of roots) {
    const netLabels = groupLabels.get(root) ?? [];
    const netPins = groupPins.get(root) ?? [];
    const segmentIds = groupWires.get(root) ?? [];
    if (!segmentIds.length && !netLabels.length) continue;
    const name = netLabels[0]?.name ?? `UNRESOLVED_${root.replace(",", "_")}`;
    const netId = stableId("logical-net", schematicId, root, name);
    const endpoints: NetEndpoint[] = [
      ...netLabels.map((label) => ({
        id: stableId("endpoint", netId, label.id),
        type: "label" as const,
        targetId: label.id,
        identifier: { name: label.name },
        position: label.position,
      })),
      ...netPins.map((pinEntity) => ({
        id: stableId("endpoint", netId, pinEntity.id),
        type: "symbol_pin" as const,
        targetId: pinEntity.id,
        identifier: { reference: pinEntity.reference, pin: pinEntity.number, partId: pinEntity.partId },
        position: pinEntity.position,
      })),
    ];
    const resolved = netLabels.length > 0;
    output.nets.push({
      id: netId,
      domain: "schematic_logical",
      canonicalName: name,
      displayNames: Array.from(new Set(netLabels.map((label) => label.name))),
      endpoints,
      segmentIds,
      resolution: { method: resolved ? "connectivity_resolved" : "unresolved", confidence: resolved ? 0.9 : 0.35 },
      sourceRefs: [
        ...netLabels.map((label) => label.sourceRef),
        ...segmentIds.map((id) => wires.find((wire) => wire.id === id)!.sourceRef),
      ],
    });
  }

  output.schematics.push({
    id: schematicId,
    documentId,
    name: output.projectName ?? "EasyEDA schematic",
    rootSheetId: sheets[0].id,
    sheets,
    symbolInstanceIds,
    pins,
    wires,
    junctions,
    labels,
    noConnects: [],
    connectivityGraphId: stableId("connectivity", schematicId),
    sourceRefs,
  });
  if (output.nets.some((net) => net.domain === "schematic_logical" && net.resolution.method === "unresolved")) {
    output.diagnostics.push(
      diagnostic(
        "EASYEDA_CONNECTIVITY_PARTIAL",
        "部分 EasyEDA 导线没有显式网络标签；已保留几何连通分组并以低置信度 unresolved Net 输出。",
        "warning",
        "connectivity",
        sourceRefs[0],
        "normalized",
      ),
    );
  }

  void wireSheet;
  void labelSheet;
  void pinSheet;
}

function layerRole(name: string, sourceId: string): Pick<PcbIr["layers"][number], "role" | "side" | "copper"> {
  const normalized = name.toLowerCase();
  if (sourceId === "10" || /boardoutline|edge\.cuts|outline/.test(normalized)) return { role: "edge", side: "both", copper: false };
  if (sourceId === "1" || /toplayer|top layer|f\.cu/.test(normalized)) return { role: "copper", side: "front", copper: true };
  if (sourceId === "2" || /bottomlayer|bottom layer|b\.cu/.test(normalized)) return { role: "copper", side: "back", copper: true };
  if (/inner|copper/.test(normalized) || Number(sourceId) >= 21 && Number(sourceId) <= 50) return { role: "copper", side: "inner", copper: true };
  if (/silk/.test(normalized)) return { role: "silkscreen", side: /bottom|b\./.test(normalized) ? "back" : "front", copper: false };
  if (/mask/.test(normalized)) return { role: "solder_mask", side: /bottom|b\./.test(normalized) ? "back" : "front", copper: false };
  if (/paste/.test(normalized)) return { role: "paste", side: /bottom|b\./.test(normalized) ? "back" : "front", copper: false };
  return { role: "user", side: "unknown", copper: false };
}

function parseStandardPcb(
  document: StandardDocument,
  output: KicadParseOutput,
  shapeCounts: Map<string, number>,
): void {
  const object = document.object;
  const pcbId = stableId("pcb", document.asset.sha256, document.jsonPath);
  const documentId = stableId("document", pcbId);
  const layers: PcbIr["layers"] = [];
  const rawLayers = Array.isArray(object.layers) ? object.layers : Array.isArray(asObject(object.head)?.layers) ? asObject(object.head)!.layers as unknown[] : [];
  for (const [index, rawLayer] of rawLayers.entries()) {
    const fields = typeof rawLayer === "string" ? rawLayer.split("~") : [];
    const sourceId = fields[0] ?? String(index);
    const name = fields[1] ?? `Layer ${sourceId}`;
    layers.push({ id: stableId("layer", pcbId, sourceId), sourceId, name, ...layerRole(name, sourceId) });
  }
  if (!layers.length) {
    for (const [sourceId, name] of [["1", "TopLayer"], ["2", "BottomLayer"], ["10", "BoardOutLine"]] as const) {
      layers.push({ id: stableId("layer", pcbId, sourceId), sourceId, name, ...layerRole(name, sourceId) });
    }
  }
  const layerName = (sourceId: string) => layers.find((layer) => layer.sourceId === sourceId)?.name ?? sourceId;
  const footprints: PcbIr["footprints"] = [];
  const pads: PcbIr["pads"] = [];
  const tracks: PcbIr["tracks"] = [];
  const vias: PcbIr["vias"] = [];
  const zones: PcbIr["zones"] = [];
  const boardOutline: PcbIr["boardOutline"] = [];
  const explicitNetNames = new Set<string>();
  const shapeValues = shapesOf(object);

  for (const [shapeIndex, raw] of shapeValues.entries()) {
    const record = parseShapeRecord(raw);
    shapeCounts.set(record.prefix, (shapeCounts.get(record.prefix) ?? 0) + 1);
    output.recognized += 1;
    const nativeId = record.fields.find((field) => /^gge[0-9a-z]+$/i.test(field)) ?? `${shapeIndex}`;
    const ref = sourceRef(document.asset.id, document.asset.relativePath, "explicit", {
      nativeId,
      jsonPath: `${document.jsonPath}.shape[${shapeIndex}]`,
    });
    if (record.prefix === "TRACK") {
      const width = record.fields[1];
      const layer = record.fields[2] ?? "";
      const netName = record.fields[3] ?? "";
      const vertices = pointsFromSpaceList(record.fields[4] ?? "");
      if (netName) explicitNetNames.add(netName);
      for (let index = 1; index < vertices.length; index += 1) {
        if (layer === "10") {
          boardOutline.push({
            id: stableId("outline", pcbId, nativeId, index),
            kind: "line",
            geometry: { start: point(vertices[index - 1].x, vertices[index - 1].y), end: point(vertices[index].x, vertices[index].y), sourceLayer: layer },
          });
        } else {
          tracks.push({
            id: stableId("track", pcbId, nativeId, index),
            kind: "segment",
            start: point(vertices[index - 1].x, vertices[index - 1].y),
            end: point(vertices[index].x, vertices[index].y),
            width,
            layer: layerName(layer),
            netId: netName ? stableId("pcb-net", pcbId, netName) : undefined,
            sourceNativeNetId: netName || undefined,
            sourceRef: ref,
          });
        }
      }
      output.normalized += 1;
      continue;
    }
    if (record.prefix === "VIA") {
      const netName = record.fields[4] ?? "";
      if (netName) explicitNetNames.add(netName);
      vias.push({
        id: stableId("via", pcbId, nativeId),
        position: point(record.fields[1], record.fields[2]),
        size: record.fields[3],
        drill: record.fields[5],
        layers: ["TopLayer", "BottomLayer"],
        netId: netName ? stableId("pcb-net", pcbId, netName) : undefined,
        sourceNativeNetId: netName || undefined,
        sourceRef: ref,
      });
      output.normalized += 1;
      continue;
    }
    if (record.prefix === "ARC") {
      const layer = record.fields[2] ?? "";
      const netName = record.fields[3] ?? "";
      if (netName) explicitNetNames.add(netName);
      if (layer === "10") {
        boardOutline.push({ id: stableId("outline", pcbId, nativeId), kind: "arc", geometry: { svgPath: record.fields[4], sourceLayer: layer } });
      } else {
        tracks.push({
          id: stableId("track", pcbId, nativeId),
          kind: "arc",
          width: record.fields[1],
          layer: layerName(layer),
          netId: netName ? stableId("pcb-net", pcbId, netName) : undefined,
          sourceNativeNetId: netName || undefined,
          sourceRef: ref,
        });
      }
      output.normalized += 1;
      continue;
    }
    if (["COPPERAREA", "SOLIDREGION"].includes(record.prefix)) {
      const layer = record.fields[2] ?? record.fields[1] ?? "";
      const netName = record.fields[3] ?? "";
      if (netName) explicitNetNames.add(netName);
      zones.push({
        id: stableId("zone", pcbId, nativeId),
        netId: netName ? stableId("pcb-net", pcbId, netName) : undefined,
        sourceNativeNetId: netName || undefined,
        layers: [layerName(layer)],
        sourceRef: ref,
      });
      output.normalized += 1;
      continue;
    }
    if (record.prefix !== "LIB") continue;
    const children = raw.split("#@$");
    const main = parseShapeRecord(children.shift() ?? raw);
    const reference = textChildValue(children, "P").trim() || `FP${footprints.length + 1}`;
    const value = textChildValue(children, "N").trim();
    const footprintId = stableId("footprint", pcbId, nativeId, reference);
    const padIds: string[] = [];
    for (const [childIndex, child] of children.entries()) {
      const padRecord = parseShapeRecord(child);
      if (padRecord.prefix !== "PAD") continue;
      const netName = padRecord.fields[7] ?? "";
      if (netName) explicitNetNames.add(netName);
      const padId = stableId("pad", footprintId, padRecord.fields[8], padRecord.fields[12] || childIndex);
      padIds.push(padId);
      pads.push({
        id: padId,
        footprintId,
        number: padRecord.fields[8] ?? String(childIndex + 1),
        padType: padRecord.fields[1] ?? "standard",
        shape: padRecord.fields[1] ?? "unknown",
        position: point(padRecord.fields[2], padRecord.fields[3]),
        size: padRecord.fields[4] && padRecord.fields[5] ? { x: padRecord.fields[4], y: padRecord.fields[5], unit: "mm" } : undefined,
        layers: [layerName(padRecord.fields[6] ?? "")],
        netId: netName ? stableId("pcb-net", pcbId, netName) : undefined,
        sourceNativeNetId: netName || undefined,
        netName: netName || undefined,
        sourceRef: ref,
      });
    }
    footprints.push({
      id: footprintId,
      reference,
      value,
      libraryIdentifier: packageField(main.fields[3] ?? "") ?? value,
      position: point(main.fields[1], main.fields[2]),
      rotation: main.fields[4] ?? "0",
      side: main.fields[5] === "1" ? "back" : "front",
      locked: main.fields.at(-1) === "1",
      padIds,
      sourceRef: ref,
    });
    output.normalized += 1 + padIds.length;
  }

  const pcbNets: NetIr[] = Array.from(explicitNetNames).map((name) => {
    const id = stableId("pcb-net", pcbId, name);
    const netPads = pads.filter((pad) => pad.netId === id);
    const netTracks = tracks.filter((track) => track.netId === id);
    const netVias = vias.filter((via) => via.netId === id);
    const netZones = zones.filter((zone) => zone.netId === id);
    return {
      id,
      domain: "pcb_physical",
      canonicalName: name,
      displayNames: [name],
      endpoints: [
        ...netPads.map((pad) => ({ id: stableId("endpoint", id, pad.id), type: "footprint_pad" as const, targetId: pad.id, identifier: { pad: pad.number, footprintId: pad.footprintId }, position: pad.position })),
        ...netTracks.map((track) => ({ id: stableId("endpoint", id, track.id), type: "track" as const, targetId: track.id, identifier: { kind: track.kind } })),
        ...netVias.map((via) => ({ id: stableId("endpoint", id, via.id), type: "via" as const, targetId: via.id, identifier: {}, position: via.position })),
        ...netZones.map((zone) => ({ id: stableId("endpoint", id, zone.id), type: "zone" as const, targetId: zone.id, identifier: {} })),
      ],
      segmentIds: netTracks.map((track) => track.id),
      resolution: { method: "explicit", confidence: 1 },
      sourceRefs: [document.ref],
    };
  });
  output.nets.push(...pcbNets);
  output.pcbs.push({
    id: pcbId,
    documentId,
    name: document.name,
    units: "mm",
    coordinateSystem: { sourceUnits: "EasyEDA standard source token", canonicalUnits: "mm", rotationConvention: "degrees_ccw", precision: "source_token_preserved" },
    layers,
    stackup: [],
    boardOutline,
    footprints,
    pads,
    tracks,
    vias,
    zones,
    sourceRefs: [document.ref],
  });
  if (!boardOutline.length) {
    output.diagnostics.push(diagnostic("BOARD_OUTLINE_OPEN", `${document.asset.relativePath} 未解析到闭合板框。`, "warning", "geometry", document.ref));
  }
}

export function parseEasyEda(inputs: InputAsset[], inventory: SourceAsset[]): KicadParseOutput {
  const output: KicadParseOutput = {
    settings: {}, schematics: [], pcbs: [], parts: [], nets: [], constraints: [], libraries: [], sourceMap: [], diagnostics: [], opaqueNodes: [], recognized: 0, normalized: 0, opaque: 0,
  };
  const byPath = new Map(inputs.map((input) => [input.path, input]));
  const schematicDocuments: StandardDocument[] = [];
  const pcbDocuments: StandardDocument[] = [];
  const partsByReference = new Map<string, PartIr>();
  const shapeCounts = new Map<string, number>();
  const knownPrefixes = new Set(["LIB", "WIRE", "W", "J", "N", "O", "F", "PL", "R", "RECT", "C", "CIRCLE", "A", "ARC", "T", "P", "PT", "VIA", "PAD", "TRACK", "COPPERAREA", "SOLIDREGION", "SVGNODE", "DIMENSION", "TEXT"]);

  for (const asset of inventory.filter((item) => item.detectedFormat === "easyeda")) {
    const input = byPath.get(asset.relativePath);
    if (!input) continue;
    const ref = sourceRef(asset.id, asset.relativePath);
    output.sourceMap.push(ref);
    let root: unknown;
    try {
      root = JSON.parse(decodeUtf8(input.bytes));
    } catch {
      output.diagnostics.push(diagnostic("PARSER_SYNTAX_ERROR", `${asset.relativePath} 不是有效的 EasyEDA Standard JSON。`, "error", "syntax", ref, "preserved"));
      continue;
    }
    const rootObject = asObject(root);
    if (!rootObject) {
      output.diagnostics.push(diagnostic("EASYEDA_ROOT_UNSUPPORTED", `${asset.relativePath} 的 JSON 根节点不是 Standard 文档对象。`, "warning", "structure", ref, "preserved"));
      continue;
    }
    output.projectName ??= stringValue(rootObject.projectName) ?? stringValue(rootObject.title) ?? withoutExtension(asset.fileName);
    const head = asObject(rootObject.head);
    output.sourceToolVersion ??= stringValue(head?.editorVersion) ?? stringValue(head?.version);
    output.sourceFormatVersion ??= stringValue(rootObject.version) ?? stringValue(rootObject.documentVersion);
    if (typeof rootObject.canvas === "string") output.settings.canvas = rootObject.canvas;
    for (const document of standardDocuments(rootObject, asset, ref)) {
      const docType = sourceDocType(document.object);
      if (docType === "3" || docType === "4" || docType === "14") pcbDocuments.push(document);
      else schematicDocuments.push(document);
    }
  }

  parseStandardSchematic(schematicDocuments, output, partsByReference, shapeCounts);
  for (const document of pcbDocuments) parseStandardPcb(document, output, shapeCounts);
  output.parts = Array.from(partsByReference.values());
  output.libraries = Array.from(shapeCounts.entries()).map(([prefix, count]) => ({
    id: stableId("easyeda-shape-family", prefix),
    type: "shape_family",
    name: prefix,
    objectCount: count,
    resolutionStatus: knownPrefixes.has(prefix) ? "recognized" : "opaque_preserved",
  }));
  for (const [prefix] of shapeCounts) {
    if (knownPrefixes.has(prefix)) continue;
    output.opaqueNodes.push({ recordType: `EasyEDA.Shape.${prefix}`, sourcePath: inventory[0]?.relativePath ?? "", payloadHash: inventory[0]?.sha256 ?? "" });
    output.opaque += 1;
  }
  if (!output.schematics.length && !output.pcbs.length) {
    output.diagnostics.push(diagnostic("PROJECT_ENTRY_NOT_FOUND", "未找到 EasyEDA Standard 原理图或 PCB 文档入口。", "error", "structure", output.sourceMap[0]));
  }
  return output;
}
