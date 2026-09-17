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
import { basename, decodeUtf8, diagnostic, point, sourceRef, stableId, withoutExtension } from "./util";

type JsonObject = Record<string, unknown>;
type RecordLine = unknown[];

const SQLITE_SIGNATURE = "SQLite format 3\u0000";

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function isSqlite(bytes: Uint8Array): boolean {
  return decodeUtf8(bytes.subarray(0, SQLITE_SIGNATURE.length)) === SQLITE_SIGNATURE;
}

function looksLikeRecordStream(bytes: Uint8Array): boolean {
  const firstLine = decodeUtf8(bytes.subarray(0, Math.min(bytes.length, 1024))).split(/\r?\n/, 1)[0]?.trim();
  return Boolean(firstLine && /^\[\s*"DOCTYPE"\s*,/.test(firstLine));
}

export function isJlcProProject(inputs: InputAsset[], inventory: SourceAsset[]): boolean {
  if (inventory.some((asset) => [".epro", ".eprj", ".epru", ".esch", ".epcb", ".esym", ".efoo", ".ecop"].includes(asset.extension))) return true;
  if (inventory.some((asset) => /(^|\/)project\.json$/i.test(asset.relativePath)) && inventory.some((asset) => [".esch", ".epcb"].includes(asset.extension))) return true;
  return inputs.some((input) => looksLikeRecordStream(input.bytes));
}

function parseRecordLines(
  input: InputAsset,
  asset: SourceAsset,
  output: KicadParseOutput,
): { records: RecordLine[]; ref: SourceRef } {
  const ref = sourceRef(asset.id, asset.relativePath);
  const records: RecordLine[] = [];
  let invalidCount = 0;
  let firstInvalidLine = 0;
  const lines = decodeUtf8(input.bytes).split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line);
      if (Array.isArray(value) && typeof value[0] === "string") records.push(value);
      else {
        invalidCount += 1;
        firstInvalidLine ||= index + 1;
      }
    } catch {
      invalidCount += 1;
      firstInvalidLine ||= index + 1;
    }
  }
  if (invalidCount > 0) {
    output.diagnostics.push(
      diagnostic(
        "JLCEDA_RECORD_PARSE_AGGREGATE",
        `${asset.relativePath} 有 ${invalidCount} 条无效记录（首条位于第 ${firstInvalidLine} 行）；原始文件已保留，仅跳过这些记录。`,
        "warning",
        "syntax",
        { ...ref, line: firstInvalidLine || undefined },
        "preserved",
      ),
    );
    output.opaque += invalidCount;
  }
  output.recognized += records.length;
  return { records, ref };
}

function recordsByType(records: RecordLine[]): Map<string, RecordLine[]> {
  const result = new Map<string, RecordLine[]>();
  for (const record of records) {
    const type = text(record[0]);
    (result.get(type) ?? result.set(type, []).get(type)!).push(record);
  }
  return result;
}

function attributeMap(
  records: RecordLine[],
  shape: "schematic" | "pcb",
): Map<string, Record<string, { value: string; record: RecordLine }>> {
  const result = new Map<string, Record<string, { value: string; record: RecordLine }>>();
  for (const record of records) {
    if (record[0] !== "ATTR") continue;
    const parent = text(record[shape === "schematic" ? 2 : 3]);
    const key = text(record[shape === "schematic" ? 3 : 7]);
    const value = text(record[shape === "schematic" ? 4 : 8]);
    if (!parent || !key) continue;
    const attributes = result.get(parent) ?? {};
    attributes[key] = { value, record };
    result.set(parent, attributes);
  }
  return result;
}

function refForRecord(asset: SourceAsset, record: RecordLine, line?: number): SourceRef {
  return sourceRef(asset.id, asset.relativePath, "explicit", { nativeId: text(record[1]) || undefined, line });
}

function parseSchematicRecords(
  asset: SourceAsset,
  records: RecordLine[],
  ref: SourceRef,
  output: KicadParseOutput,
  projectSheetNames: Map<string, string>,
  partsByReference: Map<string, PartIr>,
): void {
  const byType = recordsByType(records);
  const attributes = attributeMap(records, "schematic");
  const documentToken = withoutExtension(asset.fileName);
  const pathSegments = asset.relativePath.split("/");
  const manifestSheetKey = `${pathSegments.at(-2) ?? ""}/${documentToken}`;
  const sheetName = projectSheetNames.get(manifestSheetKey) ?? projectSheetNames.get(documentToken) ?? documentToken;
  const schematicId = stableId("schematic", asset.sha256, asset.relativePath);
  const documentId = stableId("document", asset.sha256, asset.relativePath);
  const sheetId = stableId("sheet", schematicId, sheetName);
  const pins: SchematicIr["pins"] = [];
  const wires: SchematicIr["wires"] = [];
  const labels: SchematicIr["labels"] = [];
  const symbolInstanceIds: string[] = [];
  const componentPartByNativeId = new Map<string, PartIr>();

  for (const component of byType.get("COMPONENT") ?? []) {
    const nativeId = text(component[1]);
    const attrs = attributes.get(nativeId) ?? {};
    const reference = attrs.Designator?.value;
    if (!reference) continue;
    const existingPart = partsByReference.get(reference);
    const partId = existingPart?.id ?? stableId("part", schematicId, nativeId, reference);
    const unitNumber = (existingPart?.symbolUnits.length ?? 0) + 1;
    const symbolUnitId = stableId("symbol-unit", partId, nativeId, unitNumber);
    const fields = Object.fromEntries(Object.entries(attrs).map(([key, entry]) => [key, entry.value]));
    const symbolUnit: PartIr["symbolUnits"][number] = {
      id: symbolUnitId,
      unit: unitNumber,
      position: point(text(component[3]), text(component[4])),
      rotation: text(component[5]) || "0",
    };
    const part: PartIr = existingPart ?? {
      id: partId,
      logicalPartKey: reference,
      reference,
      value: attrs.Value?.value ?? "",
      symbolUnits: [symbolUnit],
      footprint: attrs.Footprint?.value || attrs["Origin Footprint"]?.value || undefined,
      fields,
      manufacturerRaw: attrs.Manufacturer?.value || undefined,
      mpnRaw: attrs["Manufacturer Part"]?.value || attrs.MPN?.value || undefined,
      variantStatus: /^(yes|true|1)$/i.test(attrs.DNP?.value ?? "") ? "dnp" : "fitted",
      pinPadMap: [],
      sourceRefs: [refForRecord(asset, component)],
    };
    if (existingPart) existingPart.symbolUnits.push(symbolUnit);
    else partsByReference.set(reference, part);
    componentPartByNativeId.set(nativeId, part);
    symbolInstanceIds.push(symbolUnitId);
    output.normalized += 1;
  }

  for (const [parentId, attrs] of attributes) {
    const number = attrs.NUMBER?.value;
    if (!number) continue;
    const componentEntry = Array.from(componentPartByNativeId.entries())
      .filter(([nativeId]) => parentId.startsWith(nativeId))
      .sort(([left], [right]) => right.length - left.length)[0];
    if (!componentEntry) continue;
    const [, part] = componentEntry;
    const attrRecord = attrs.NUMBER.record;
    const position = point(text(attrRecord[7]), text(attrRecord[8]));
    if (!position) continue;
    const symbolUnitId = part.symbolUnits[0].id;
    pins.push({
      id: stableId("pin", part.id, parentId, number),
      partId: part.id,
      symbolUnitId,
      reference: part.reference,
      number,
      name: attrs.NAME?.value ?? "",
      position,
      sourceRef: refForRecord(asset, attrRecord),
    });
    output.normalized += 1;
  }

  const wireNetName = new Map<string, string>();
  for (const [parentId, attrs] of attributes) {
    if (attrs.NET?.value) wireNetName.set(parentId, attrs.NET.value);
    if (attrs["Global Net Name"]?.value) {
      const record = attrs["Global Net Name"].record;
      const position = point(text(record[7]), text(record[8]));
      if (!position) continue;
      labels.push({
        id: stableId("label", schematicId, parentId, attrs["Global Net Name"].value),
        name: attrs["Global Net Name"].value,
        kind: "global",
        position,
        sourceRef: refForRecord(asset, record),
      });
      output.normalized += 1;
    }
  }

  const wiresByNet = new Map<string, typeof wires>();
  for (const wire of byType.get("WIRE") ?? []) {
    const nativeId = text(wire[1]);
    const vertices = Array.isArray(wire[2]) ? wire[2] : [];
    const wirePoints = vertices.flatMap((vertex) => {
      if (!Array.isArray(vertex) || vertex.length < 2) return [];
      if (vertex.length >= 4) {
        return [
          point(text(vertex[0]), text(vertex[1]))!,
          point(text(vertex[2]), text(vertex[3]))!,
        ];
      }
      return [point(text(vertex[0]), text(vertex[1]))!];
    });
    if (wirePoints.length < 2) continue;
    const wireEntity = { id: stableId("wire", schematicId, nativeId), points: wirePoints, sourceRef: refForRecord(asset, wire) };
    wires.push(wireEntity);
    const netName = wireNetName.get(nativeId) || `UNRESOLVED_${nativeId}`;
    (wiresByNet.get(netName) ?? wiresByNet.set(netName, []).get(netName)!).push(wireEntity);
    output.normalized += 1;
  }

  for (const [name, netWires] of wiresByNet) {
    const id = stableId("logical-net", schematicId, name);
    const matchingLabels = labels.filter((label) => label.name === name);
    const endpoints: NetEndpoint[] = matchingLabels.map((label) => ({
      id: stableId("endpoint", id, label.id),
      type: "label",
      targetId: label.id,
      identifier: { name: label.name },
      position: label.position,
    }));
    const pointKeys = new Set(netWires.flatMap((wire) => wire.points.map((position) => `${position.x},${position.y}`)));
    for (const pinEntity of pins.filter((candidate) => pointKeys.has(`${candidate.position.x},${candidate.position.y}`))) {
      endpoints.push({
        id: stableId("endpoint", id, pinEntity.id),
        type: "symbol_pin",
        targetId: pinEntity.id,
        identifier: { reference: pinEntity.reference, pin: pinEntity.number, partId: pinEntity.partId },
        position: pinEntity.position,
      });
    }
    const resolved = !name.startsWith("UNRESOLVED_");
    output.nets.push({
      id,
      domain: "schematic_logical",
      canonicalName: name,
      displayNames: resolved ? [name] : [],
      endpoints,
      segmentIds: netWires.map((wire) => wire.id),
      resolution: { method: resolved ? "explicit" : "unresolved", confidence: resolved ? 1 : 0.35 },
      sourceRefs: netWires.map((wire) => wire.sourceRef),
    });
  }

  output.schematics.push({
    id: schematicId,
    documentId,
    name: sheetName,
    rootSheetId: sheetId,
    sheets: [{ id: sheetId, name: sheetName, instancePath: "/" }],
    symbolInstanceIds,
    pins,
    wires,
    junctions: [],
    labels,
    noConnects: [],
    connectivityGraphId: stableId("connectivity", schematicId),
    sourceRefs: [ref],
  });
  const known = new Set(["DOCTYPE", "HEAD", "OBJ", "COMPONENT", "ATTR", "WIRE"]);
  preserveUnknownTypes(asset, byType, known, output);
}

function parsePcbRecords(
  asset: SourceAsset,
  records: RecordLine[],
  ref: SourceRef,
  output: KicadParseOutput,
  pcbNames: Map<string, string>,
): void {
  const byType = recordsByType(records);
  const attributes = attributeMap(records, "pcb");
  const token = withoutExtension(asset.fileName);
  const pcbName = pcbNames.get(token) ?? token;
  const pcbId = stableId("pcb", asset.sha256, asset.relativePath);
  const layers: PcbIr["layers"] = (byType.get("LAYER") ?? []).map((record) => {
    const sourceId = text(record[1]);
    const side = sourceId === "1" ? "front" : sourceId === "2" ? "back" : Number(sourceId) >= 21 && Number(sourceId) <= 50 ? "inner" : "unknown";
    const copper = sourceId === "1" || sourceId === "2" || side === "inner";
    return {
      id: stableId("layer", pcbId, sourceId),
      sourceId,
      name: text(record[3]) || text(record[2]) || `Layer ${sourceId}`,
      role: copper ? "copper" : /outline/i.test(text(record[2]) + text(record[3])) ? "edge" : "user",
      side,
      copper,
    };
  });
  output.normalized += layers.length;
  const layerName = (sourceId: string) => layers.find((layer) => layer.sourceId === sourceId)?.name ?? sourceId;
  const footprints: PcbIr["footprints"] = [];
  const pads: PcbIr["pads"] = [];
  const tracks: PcbIr["tracks"] = [];
  const vias: PcbIr["vias"] = [];
  const zones: PcbIr["zones"] = [];
  const footprintByNativeId = new Map<string, PcbIr["footprints"][number]>();
  const explicitNetNames = new Set((byType.get("NET") ?? []).map((record) => text(record[1])).filter(Boolean));

  for (const component of byType.get("COMPONENT") ?? []) {
    const nativeId = text(component[1]);
    const attrs = attributes.get(nativeId) ?? {};
    const reference = attrs.Designator?.value || `FP${footprints.length + 1}`;
    const footprint = {
      id: stableId("footprint", pcbId, nativeId),
      reference,
      value: attrs.Value?.value ?? "",
      libraryIdentifier: attrs.Footprint?.value ?? "",
      position: point(text(component[4]), text(component[5])),
      rotation: text(component[6]) || "0",
      side: (text(component[3]) === "2" ? "back" : "front") as "front" | "back",
      locked: false,
      padIds: [] as string[],
      sourceRef: refForRecord(asset, component),
    };
    footprints.push(footprint);
    footprintByNativeId.set(nativeId, footprint);
    output.normalized += 1;
  }
  for (const record of byType.get("PAD_NET") ?? []) {
    const footprint = footprintByNativeId.get(text(record[1]));
    if (!footprint) continue;
    const number = text(record[2]);
    const netName = text(record[3]);
    const nativeId = text(record[4]) || `${record[1]}:${number}`;
    if (netName) explicitNetNames.add(netName);
    const id = stableId("pad", pcbId, footprint.id, number, nativeId);
    footprint.padIds.push(id);
    pads.push({
      id,
      footprintId: footprint.id,
      number,
      padType: "component",
      shape: "source_library",
      layers: [],
      netId: netName ? stableId("pcb-net", pcbId, netName) : undefined,
      sourceNativeNetId: netName || undefined,
      netName: netName || undefined,
      sourceRef: refForRecord(asset, record),
    });
    output.normalized += 1;
  }
  for (const record of byType.get("PAD") ?? []) {
    const netName = text(record[3]);
    if (netName) explicitNetNames.add(netName);
    const orphanFootprintId = stableId("footprint", pcbId, "board-pads");
    let footprint = footprints.find((candidate) => candidate.id === orphanFootprintId);
    if (!footprint) {
      footprint = {
        id: orphanFootprintId,
        reference: "BOARD_PAD",
        value: "",
        libraryIdentifier: "board_pad",
        rotation: "0",
        side: "front",
        locked: false,
        padIds: [],
        sourceRef: ref,
      };
      footprints.push(footprint);
    }
    const id = stableId("pad", pcbId, text(record[1]));
    footprint.padIds.push(id);
    const shape = Array.isArray(record[9]) ? text(record[9][0]) : "unknown";
    pads.push({
      id,
      footprintId: footprint.id,
      number: text(record[5]),
      padType: "free",
      shape,
      position: point(text(record[6]), text(record[7])),
      layers: [layerName(text(record[4]))],
      netId: netName ? stableId("pcb-net", pcbId, netName) : undefined,
      sourceNativeNetId: netName || undefined,
      netName: netName || undefined,
      sourceRef: refForRecord(asset, record),
    });
    output.normalized += 1;
  }
  for (const record of byType.get("LINE") ?? []) {
    const netName = text(record[3]);
    if (netName) explicitNetNames.add(netName);
    tracks.push({
      id: stableId("track", pcbId, text(record[1])),
      kind: "segment",
      start: point(text(record[5]), text(record[6])),
      end: point(text(record[7]), text(record[8])),
      width: text(record[9]),
      layer: layerName(text(record[4])),
      netId: netName ? stableId("pcb-net", pcbId, netName) : undefined,
      sourceNativeNetId: netName || undefined,
      sourceRef: refForRecord(asset, record),
    });
    output.normalized += 1;
  }
  for (const record of byType.get("VIA") ?? []) {
    const netName = text(record[3]);
    if (netName) explicitNetNames.add(netName);
    vias.push({
      id: stableId("via", pcbId, text(record[1])),
      position: point(text(record[5]), text(record[6])),
      drill: text(record[7]),
      size: text(record[8]),
      layers: ["Top Layer", "Bottom Layer"],
      netId: netName ? stableId("pcb-net", pcbId, netName) : undefined,
      sourceNativeNetId: netName || undefined,
      sourceRef: refForRecord(asset, record),
    });
    output.normalized += 1;
  }
  for (const record of byType.get("POUR") ?? []) {
    const netName = text(record[3]);
    if (netName) explicitNetNames.add(netName);
    zones.push({
      id: stableId("zone", pcbId, text(record[1])),
      netId: netName ? stableId("pcb-net", pcbId, netName) : undefined,
      sourceNativeNetId: netName || undefined,
      layers: [layerName(text(record[4]))],
      sourceRef: refForRecord(asset, record),
    });
    output.normalized += 1;
  }
  output.constraints.push(
    ...(byType.get("RULE") ?? []).map((record) => ({
      id: stableId("constraint", pcbId, text(record[1])),
      type: "jlceda_rule",
      nativeId: text(record[1]),
      record,
      provenance: "explicit",
    })),
  );
  output.normalized += (byType.get("RULE") ?? []).length;

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
        ...netPads.map((pad) => ({ id: stableId("endpoint", id, pad.id), type: "footprint_pad" as const, targetId: pad.id, identifier: { pad: pad.number, footprintId: pad.footprintId ?? "" } })),
        ...netTracks.map((track) => ({ id: stableId("endpoint", id, track.id), type: "track" as const, targetId: track.id, identifier: { kind: track.kind } })),
        ...netVias.map((via) => ({ id: stableId("endpoint", id, via.id), type: "via" as const, targetId: via.id, identifier: {}, position: via.position })),
        ...netZones.map((zone) => ({ id: stableId("endpoint", id, zone.id), type: "zone" as const, targetId: zone.id, identifier: {} })),
      ],
      segmentIds: netTracks.map((track) => track.id),
      resolution: { method: "explicit", confidence: 1 },
      sourceRefs: [ref],
    };
  });
  output.nets.push(...pcbNets);
  output.pcbs.push({
    id: pcbId,
    documentId: stableId("document", asset.sha256, asset.relativePath),
    name: pcbName,
    units: "mm",
    coordinateSystem: { sourceUnits: "mm", canonicalUnits: "mm", rotationConvention: "degrees_ccw", precision: "source_token_preserved" },
    layers,
    stackup: (byType.get("LAYER_PHYS") ?? []).map((record) => ({ nativeId: text(record[1]), name: text(record[2]), thickness: text(record[4]) })),
    boardOutline: [],
    footprints,
    pads,
    tracks,
    vias,
    zones,
    sourceRefs: [ref],
  });
  const known = new Set(["DOCTYPE", "CANVAS", "HEAD", "ACTIVE_LAYER", "LAYER", "LAYER_PHYS", "NET", "COMPONENT", "ATTR", "PAD_NET", "PAD", "LINE", "VIA", "POUR", "RULE", "CONNECT"]);
  preserveUnknownTypes(asset, byType, known, output);
}

function preserveUnknownTypes(
  asset: SourceAsset,
  byType: Map<string, RecordLine[]>,
  known: Set<string>,
  output: KicadParseOutput,
): void {
  const unknown: Array<{ type: string; count: number }> = [];
  for (const [type, records] of byType) {
    if (known.has(type)) continue;
    unknown.push({ type, count: records.length });
    output.opaqueNodes.push({ recordType: `JLCEDA.Record.${type}`, sourcePath: asset.relativePath, payloadHash: asset.sha256 });
    output.opaque += records.length;
  }
  if (unknown.length) {
    output.diagnostics.push(
      diagnostic(
        "JLCEDA_RECORDS_PARTIAL",
        `${asset.relativePath} 有 ${unknown.reduce((sum, item) => sum + item.count, 0)} 条未映射记录，已按 ${unknown.length} 种类型汇总并原样保留：${unknown.slice(0, 12).map((item) => `${item.type}×${item.count}`).join("、")}${unknown.length > 12 ? "…" : ""}`,
        "warning",
        "unsupported",
        sourceRef(asset.id, asset.relativePath),
        "preserved",
      ),
    );
  }
}

export function parseJlcPro(inputs: InputAsset[], inventory: SourceAsset[]): KicadParseOutput {
  const output: KicadParseOutput = {
    settings: {}, schematics: [], pcbs: [], parts: [], nets: [], constraints: [], libraries: [], sourceMap: [], diagnostics: [], opaqueNodes: [], recognized: 0, normalized: 0, opaque: 0,
  };
  const byPath = new Map(inputs.map((input) => [input.path, input]));
  const projectSheetNames = new Map<string, string>();
  const pcbNames = new Map<string, string>();
  const partsByReference = new Map<string, PartIr>();
  let manifestFound = false;

  const easyEdaAssets = inventory
    .filter((item) => item.detectedFormat === "easyeda")
    .sort((left, right) => Number(!/(^|\/)project\.json$/i.test(left.relativePath)) - Number(!/(^|\/)project\.json$/i.test(right.relativePath)));
  for (const asset of easyEdaAssets) {
    const input = byPath.get(asset.relativePath);
    if (!input) continue;
    const ref = sourceRef(asset.id, asset.relativePath);
    output.sourceMap.push(ref);
    if (asset.extension === ".eprj" && isSqlite(input.bytes)) {
      output.projectName ??= withoutExtension(asset.fileName);
      output.opaqueNodes.push({ recordType: "JLCEDA.SQLiteProject", sourcePath: asset.relativePath, payloadHash: asset.sha256 });
      output.opaque += 1;
      output.recognized += 1;
      output.diagnostics.push(
        diagnostic(
          "JLCEDA_SQLITE_STRUCTURE_ONLY",
          `${asset.relativePath} 已识别为 SQLite 工程容器并原样保留；当前浏览器适配器不猜测私有表语义。`,
          "warning",
          "unsupported",
          ref,
          "preserved",
        ),
      );
      continue;
    }
    if (/(^|\/)project\.json$/i.test(asset.relativePath) || asset.extension === ".eprj" && !looksLikeRecordStream(input.bytes)) {
      try {
        const manifest = JSON.parse(decodeUtf8(input.bytes)) as JsonObject;
        const schematics = asObject(manifest.schematics);
        const pcbs = asObject(manifest.pcbs);
        if (schematics || pcbs) {
          manifestFound = true;
          output.settings.projectManifest = manifest;
          output.projectName ??= text(manifest.name) || Object.values(schematics ?? {}).map(asObject).find(Boolean)?.name as string | undefined || withoutExtension(asset.fileName);
          for (const [projectId, project] of Object.entries(schematics ?? {})) {
            const projectObject = asObject(project);
            if (!projectObject || !Array.isArray(projectObject.sheets)) continue;
            for (const sheet of projectObject.sheets) {
              const sheetObject = asObject(sheet);
              if (!sheetObject) continue;
              const name = text(sheetObject.name) || text(sheetObject.uuid) || text(sheetObject.id);
              if (sheetObject.uuid) projectSheetNames.set(text(sheetObject.uuid), name);
              if (sheetObject.id !== undefined) projectSheetNames.set(`${projectId}/${text(sheetObject.id)}`, name);
            }
          }
          for (const [id, name] of Object.entries(pcbs ?? {})) pcbNames.set(id, text(name) || id);
          output.recognized += Object.keys(manifest).length;
          output.normalized += Object.keys(manifest).length;
          continue;
        }
      } catch {
        // The aggregate record parser below reports malformed JSONL without flooding diagnostics.
      }
    }
    if (asset.extension === ".esym" || asset.extension === ".efoo") {
      output.libraries.push({
        id: stableId("library", asset.id),
        name: basename(asset.relativePath),
        type: asset.extension === ".esym" ? "symbol" : "footprint",
        resolutionSource: "project_local",
        resolutionStatus: "preserved",
        sourceAssetId: asset.id,
      });
      output.recognized += 1;
      output.normalized += 1;
      continue;
    }
    if (asset.extension === ".esch" || asset.extension === ".epcb" || asset.extension === ".jsonl" || looksLikeRecordStream(input.bytes)) {
      const parsed = parseRecordLines(input, asset, output);
      if (asset.extension === ".epcb" || parsed.records[0]?.[1] === "PCB") parsePcbRecords(asset, parsed.records, parsed.ref, output, pcbNames);
      else if (asset.extension === ".esch" || parsed.records[0]?.[1] === "SCH") parseSchematicRecords(asset, parsed.records, parsed.ref, output, projectSheetNames, partsByReference);
      else {
        const grouped = recordsByType(parsed.records);
        preserveUnknownTypes(asset, grouped, new Set(["DOCTYPE"]), output);
      }
      continue;
    }
    if ([".ecop"].includes(asset.extension)) {
      output.opaqueNodes.push({ recordType: `JLCEDA.Asset${asset.extension}`, sourcePath: asset.relativePath, payloadHash: asset.sha256 });
      output.opaque += 1;
    }
  }

  output.parts = Array.from(partsByReference.values());
  output.projectName ??= withoutExtension(inventory.find((asset) => asset.detectedFormat === "easyeda")?.fileName ?? "JLCEDA project");
  output.sourceToolVersion = "JLCEDA Pro record stream";
  output.sourceFormatVersion = manifestFound ? "Pro project manifest + JSONL" : "Pro record stream";
  if (!output.schematics.length && !output.pcbs.length && !output.libraries.length && !output.opaqueNodes.length) {
    output.diagnostics.push(diagnostic("PROJECT_ENTRY_NOT_FOUND", "未找到可解析的 JLCEDA Pro SCH/PCB 记录流。", "error", "structure", output.sourceMap[0]));
  }
  return output;
}
