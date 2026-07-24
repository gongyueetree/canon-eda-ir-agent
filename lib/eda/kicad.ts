import {
  allDescendants,
  atom,
  childValue,
  directChildren,
  firstChild,
  head,
  parseSExpression,
  rootExpression,
  type SList,
} from "./sexpr";
import type {
  InputAsset,
  NetIr,
  ParseDiagnostic,
  PartIr,
  PcbIr,
  SchematicIr,
  SourceAsset,
  SourceRef,
} from "./types";
import { basename, decodeUtf8, diagnostic, numericString, point, sourceRef, stableId, withoutExtension } from "./util";

export type KicadParseOutput = {
  projectName?: string;
  sourceFormatVersion?: string;
  sourceToolVersion?: string;
  settings: Record<string, unknown>;
  schematics: SchematicIr[];
  pcbs: PcbIr[];
  parts: PartIr[];
  nets: NetIr[];
  constraints: Array<Record<string, unknown>>;
  libraries: Array<Record<string, unknown>>;
  sourceMap: SourceRef[];
  diagnostics: ParseDiagnostic[];
  opaqueNodes: Array<{ recordType: string; sourcePath: string; payloadHash: string }>;
  recognized: number;
  normalized: number;
  opaque: number;
};

type SymbolPinDefinition = { number: string; name: string; x: string; y: string };
type SymbolDefinition = { libraryId: string; pins: SymbolPinDefinition[] };
type PinAnchor = {
  id: string;
  partId: string;
  symbolUnitId: string;
  reference: string;
  pin: string;
  name: string;
  x: string;
  y: string;
  sourceRef: SourceRef;
};

function nodeAt(node: SList): [string, string, string] | undefined {
  const at = firstChild(node, "at");
  const x = atom(at?.items[1]);
  const y = atom(at?.items[2]);
  if (x === undefined || y === undefined) return undefined;
  return [x, y, atom(at?.items[3]) ?? "0"];
}

function nodeUuid(node: SList, fallback: string): string {
  return childValue(node, "uuid") ?? fallback;
}

function propertyMap(node: SList): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const property of directChildren(node, "property")) {
    const name = atom(property.items[1]);
    const value = atom(property.items[2]);
    if (name && value !== undefined) properties[name] = value;
  }
  return properties;
}

function transformPoint(
  localX: string,
  localY: string,
  originX: string,
  originY: string,
  rotation: string,
): [string, string] {
  const radians = (Number(rotation) * Math.PI) / 180;
  const x = Number(originX) + Number(localX) * Math.cos(radians) - Number(localY) * Math.sin(radians);
  const y = Number(originY) + Number(localX) * Math.sin(radians) + Number(localY) * Math.cos(radians);
  const clean = (value: number) => (Math.abs(value) < 1e-9 ? "0" : Number(value.toFixed(6)).toString());
  return [clean(x), clean(y)];
}

function pointKey(x: string, y: string): string {
  const normalize = (value: string) => Number(Number(value).toFixed(6)).toString();
  return `${normalize(x)},${normalize(y)}`;
}

function liesOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): boolean {
  const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  if (Math.abs(cross) > 1e-6) return false;
  const dot = (px - ax) * (px - bx) + (py - ay) * (py - by);
  return dot <= 1e-6;
}

class UnionFind {
  private parent = new Map<string, string>();

  add(value: string) {
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

  union(left: string, right: string) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}

function parseSymbolDefinitions(root: SList): Map<string, SymbolDefinition> {
  const result = new Map<string, SymbolDefinition>();
  const libraries = firstChild(root, "lib_symbols");
  if (!libraries) return result;
  for (const definition of directChildren(libraries, "symbol")) {
    const libraryId = atom(definition.items[1]);
    if (!libraryId) continue;
    const pins = allDescendants(definition, "pin").map((pinNode) => {
      const at = nodeAt(pinNode) ?? ["0", "0", "0"];
      return {
        number: childValue(pinNode, "number") ?? "?",
        name: childValue(pinNode, "name") ?? "",
        x: at[0],
        y: at[1],
      };
    });
    result.set(libraryId, { libraryId, pins });
  }
  return result;
}

function buildConnectivity(
  schematic: SchematicIr,
  pinAnchors: PinAnchor[],
  diagnostics: ParseDiagnostic[],
): NetIr[] {
  const uf = new UnionFind();
  const knownPoints = new Map<string, { x: string; y: string }>();
  const register = (x: string, y: string) => {
    const key = pointKey(x, y);
    uf.add(key);
    knownPoints.set(key, { x, y });
    return key;
  };

  for (const wire of schematic.wires) {
    for (const wirePoint of wire.points) register(wirePoint.x, wirePoint.y);
  }
  for (const junction of schematic.junctions) register(junction.position.x, junction.position.y);
  for (const label of schematic.labels) register(label.position.x, label.position.y);
  for (const pin of pinAnchors) register(pin.x, pin.y);

  for (const wire of schematic.wires) {
    if (wire.points.length < 2) continue;
    for (let index = 0; index < wire.points.length - 1; index += 1) {
      const start = wire.points[index];
      const end = wire.points[index + 1];
      const onSegment: string[] = [];
      for (const [key, candidate] of knownPoints) {
        if (
          liesOnSegment(
            Number(candidate.x),
            Number(candidate.y),
            Number(start.x),
            Number(start.y),
            Number(end.x),
            Number(end.y),
          )
        ) {
          onSegment.push(key);
        }
      }
      for (let pointIndex = 1; pointIndex < onSegment.length; pointIndex += 1) {
        uf.union(onSegment[0], onSegment[pointIndex]);
      }
    }
  }
  const globalLabelPoints = new Map<string, string>();
  for (const label of schematic.labels.filter((candidate) => candidate.kind === "global" || candidate.kind === "power")) {
    const labelPoint = pointKey(label.position.x, label.position.y);
    const semanticKey = `${label.kind}:${label.name}`;
    const existingPoint = globalLabelPoints.get(semanticKey);
    if (existingPoint) uf.union(existingPoint, labelPoint);
    else globalLabelPoints.set(semanticKey, labelPoint);
  }

  const noConnectKeys = new Set(schematic.noConnects.map((item) => pointKey(item.x, item.y)));
  const groups = new Map<string, { labels: typeof schematic.labels; pins: PinAnchor[]; wires: typeof schematic.wires }>();
  const ensure = (key: string) => {
    const root = uf.find(key);
    const existing = groups.get(root) ?? { labels: [], pins: [], wires: [] };
    groups.set(root, existing);
    return existing;
  };
  for (const label of schematic.labels) ensure(pointKey(label.position.x, label.position.y)).labels.push(label);
  for (const pin of pinAnchors) {
    const key = pointKey(pin.x, pin.y);
    if (noConnectKeys.has(key)) continue;
    ensure(key).pins.push(pin);
  }
  for (const wire of schematic.wires) {
    const first = wire.points[0];
    if (first) ensure(pointKey(first.x, first.y)).wires.push(wire);
  }

  const nets: NetIr[] = [];
  for (const [root, group] of groups) {
    if (!group.labels.length && !group.pins.length && !group.wires.length) continue;
    const labelNames = Array.from(new Set(group.labels.map((label) => label.name).filter(Boolean)));
    if (labelNames.length > 1) {
      diagnostics.push(
        diagnostic(
          "SCHEMATIC_CONNECTIVITY_CONFLICT",
          `同一连通分量出现多个标签：${labelNames.join("、")}。已保留全部名称，未猜测覆盖。`,
          "warning",
          "connectivity",
          group.labels[0]?.sourceRef,
          "preserved",
        ),
      );
    }
    const isUnresolvedSegment = group.labels.length === 0 && group.pins.length === 0 && group.wires.length > 0;
    if (isUnresolvedSegment) {
      diagnostics.push(
        diagnostic(
          "SCHEMATIC_ISOLATED_SEGMENT",
          "该导线连通分量没有标签或器件 Pin 端点，已保留为未解析网络，未推断电气语义。",
          "warning",
          "connectivity",
          group.wires[0]?.sourceRef,
          "preserved",
        ),
      );
    }
    const canonicalName = labelNames[0] || `N$${stableId("anon", schematic.id, root).slice(-8).toUpperCase()}`;
    const id = stableId("net", schematic.id, root, canonicalName);
    nets.push({
      id,
      domain: "schematic_logical",
      canonicalName,
      displayNames: labelNames.length ? labelNames : [canonicalName],
      endpoints: [
        ...group.labels.map((label) => ({
          id: stableId("endpoint", id, label.id),
          type: "label" as const,
          targetId: label.id,
          identifier: { name: label.name, kind: label.kind },
          position: label.position,
        })),
        ...group.pins.map((pin) => ({
          id: stableId("endpoint", id, pin.id),
          type: "symbol_pin" as const,
          targetId: pin.id,
          identifier: { reference: pin.reference, pin: pin.pin, partId: pin.partId },
          position: point(pin.x, pin.y),
        })),
      ],
      segmentIds: group.wires.map((wire) => wire.id),
      resolution: isUnresolvedSegment
        ? { method: "unresolved", confidence: 0.25 }
        : { method: "connectivity_resolved", confidence: 1 },
      sourceRefs: [
        ...group.labels.map((label) => label.sourceRef),
        ...group.pins.map((pin) => pin.sourceRef),
        ...group.wires.map((wire) => wire.sourceRef),
      ],
    });
  }
  return nets;
}

function parseSchematic(
  input: InputAsset,
  asset: SourceAsset,
  diagnostics: ParseDiagnostic[],
): { schematic?: SchematicIr; parts: PartIr[]; nets: NetIr[]; sourceMap: SourceRef[]; recognized: number; normalized: number; unknown: string[]; version?: string; generator?: string } {
  const text = decodeUtf8(input.bytes);
  let root: SList | undefined;
  try {
    root = rootExpression(parseSExpression(text));
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "PARSER_SYNTAX_ERROR",
        error instanceof Error ? error.message : "KiCad S-expression 解析失败。",
        "error",
        "syntax",
        sourceRef(asset.id, asset.relativePath),
      ),
    );
    return { parts: [], nets: [], sourceMap: [], recognized: 0, normalized: 0, unknown: [] };
  }
  if (!root || head(root) !== "kicad_sch") {
    diagnostics.push(diagnostic("FORMAT_AMBIGUOUS", `${asset.relativePath} 不是现代 KiCad 原理图根节点。`, "error", "format", sourceRef(asset.id, asset.relativePath)));
    return { parts: [], nets: [], sourceMap: [], recognized: 0, normalized: 0, unknown: [] };
  }

  const documentId = stableId("document", asset.sha256, asset.relativePath);
  const schematicId = stableId("schematic", documentId);
  const fileRef = sourceRef(asset.id, asset.relativePath);
  const symbolDefinitions = parseSymbolDefinitions(root);
  const partsByReference = new Map<string, PartIr>();
  const pinAnchors: PinAnchor[] = [];
  const powerLabels: SchematicIr["labels"] = [];
  const sourceMap: SourceRef[] = [fileRef];
  const symbolNodes = directChildren(root, "symbol");
  for (const [index, symbolNode] of symbolNodes.entries()) {
    const fields = propertyMap(symbolNode);
    const reference = fields.Reference || `?${index + 1}`;
    const unit = Number(childValue(symbolNode, "unit") ?? 1);
    const libraryId = childValue(symbolNode, "lib_id") ?? "unresolved";
    const at = nodeAt(symbolNode);
    const nativeId = nodeUuid(symbolNode, `${reference}:${index}`);
    const ref = sourceRef(asset.id, asset.relativePath, "explicit", { nativeId, line: symbolNode.span.line, column: symbolNode.span.column });
    sourceMap.push(ref);
    const definition = symbolDefinitions.get(libraryId);
    const isPowerSymbol = reference.startsWith("#PWR") || libraryId.startsWith("power:");
    if (isPowerSymbol) {
      if (at) {
        const powerPin = definition?.pins[0];
        const [x, y] = powerPin
          ? transformPoint(powerPin.x, powerPin.y, at[0], at[1], at[2])
          : [at[0], at[1]];
        const name = fields.Value || libraryId.replace(/^power:/, "") || reference;
        powerLabels.push({
          id: stableId("label", schematicId, nativeId, "power"),
          name,
          kind: "power",
          position: point(x, y)!,
          sourceRef: ref,
        });
      }
      continue;
    }
    const existing = partsByReference.get(reference);
    const partId = existing?.id ?? stableId("part", schematicId, reference);
    const unitId = stableId("symbol-unit", partId, unit, nativeId);
    const variantStatus: PartIr["variantStatus"] =
      fields.DNP === "1" || fields.DNP?.toLowerCase() === "yes" || childValue(symbolNode, "in_bom") === "no"
        ? "dnp"
        : "fitted";
    const part: PartIr = existing ?? {
      id: partId,
      logicalPartKey: reference,
      reference,
      value: fields.Value ?? "",
      symbolUnits: [],
      footprint: fields.Footprint || undefined,
      fields,
      manufacturerRaw: fields.Manufacturer,
      mpnRaw: fields.MPN || fields["Manufacturer Part Number"],
      variantStatus,
      pinPadMap: [],
      sourceRefs: [],
    };
    part.symbolUnits.push({ id: unitId, unit, position: at ? point(at[0], at[1]) : undefined, rotation: at?.[2] });
    part.sourceRefs.push(ref);
    partsByReference.set(reference, part);

    if (!definition) {
      diagnostics.push(
        diagnostic(
          "SYMBOL_DEFINITION_MISSING",
          `${reference} 的符号定义 ${libraryId} 未在嵌入库中解析到；器件实例仍已保留。`,
          "warning",
          "library",
          ref,
          "preserved",
        ),
      );
      continue;
    }
    if (!at) continue;
    for (const pinDefinition of definition.pins) {
      const [x, y] = transformPoint(pinDefinition.x, pinDefinition.y, at[0], at[1], at[2]);
      pinAnchors.push({
        id: stableId("pin", unitId, pinDefinition.number),
        partId,
        symbolUnitId: unitId,
        reference,
        pin: pinDefinition.number,
        name: pinDefinition.name,
        x,
        y,
        sourceRef: ref,
      });
    }
  }

  const wires = directChildren(root, "wire").map((wireNode, index) => {
    const points = directChildren(firstChild(wireNode, "pts") ?? wireNode, "xy")
      .map((xy) => point(atom(xy.items[1]), atom(xy.items[2])))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const nativeId = nodeUuid(wireNode, `wire:${index}`);
    const ref = sourceRef(asset.id, asset.relativePath, "explicit", { nativeId, line: wireNode.span.line, column: wireNode.span.column });
    sourceMap.push(ref);
    return { id: stableId("wire", schematicId, nativeId), points, sourceRef: ref };
  });
  const junctions = directChildren(root, "junction").flatMap((junctionNode, index) => {
    const at = nodeAt(junctionNode);
    if (!at) return [];
    const nativeId = nodeUuid(junctionNode, `junction:${index}`);
    const ref = sourceRef(asset.id, asset.relativePath, "explicit", { nativeId, line: junctionNode.span.line, column: junctionNode.span.column });
    sourceMap.push(ref);
    return [{ id: stableId("junction", schematicId, nativeId), position: point(at[0], at[1])!, sourceRef: ref }];
  });
  const labelKinds: Array<[string, SchematicIr["labels"][number]["kind"]]> = [
    ["label", "local"],
    ["global_label", "global"],
    ["hierarchical_label", "hierarchical"],
  ];
  const labels = [
    ...labelKinds.flatMap(([nodeHead, kind]) =>
      directChildren(root, nodeHead).flatMap((labelNode, index) => {
        const at = nodeAt(labelNode);
        const name = atom(labelNode.items[1]);
        if (!at || name === undefined) return [];
        const nativeId = nodeUuid(labelNode, `${nodeHead}:${index}`);
        const ref = sourceRef(asset.id, asset.relativePath, "explicit", { nativeId, line: labelNode.span.line, column: labelNode.span.column });
        sourceMap.push(ref);
        return [{ id: stableId("label", schematicId, nativeId), name, kind, position: point(at[0], at[1])!, sourceRef: ref }];
      }),
    ),
    ...powerLabels,
  ];
  const noConnects = directChildren(root, "no_connect")
    .map((noConnect) => nodeAt(noConnect))
    .filter((at): at is [string, string, string] => Boolean(at))
    .map((at) => point(at[0], at[1])!);

  const schematic: SchematicIr = {
    id: schematicId,
    documentId,
    name: withoutExtension(asset.fileName),
    rootSheetId: stableId("sheet", schematicId, "/"),
    sheets: [{ id: stableId("sheet", schematicId, "/"), name: withoutExtension(asset.fileName), instancePath: "/" }],
    symbolInstanceIds: Array.from(partsByReference.values()).flatMap((part) => part.symbolUnits.map((unit) => unit.id)),
    pins: pinAnchors.map((pinAnchor) => ({
      id: pinAnchor.id,
      partId: pinAnchor.partId,
      symbolUnitId: pinAnchor.symbolUnitId,
      reference: pinAnchor.reference,
      number: pinAnchor.pin,
      name: pinAnchor.name,
      position: point(pinAnchor.x, pinAnchor.y)!,
      sourceRef: pinAnchor.sourceRef,
    })),
    wires,
    junctions,
    labels,
    noConnects,
    connectivityGraphId: stableId("connectivity", schematicId),
    sourceRefs: [fileRef],
  };
  const nets = buildConnectivity(schematic, pinAnchors, diagnostics);
  const knownHeads = new Set([
    "version", "generator", "generator_version", "uuid", "paper", "lib_symbols", "junction", "wire", "bus", "bus_entry", "label", "global_label", "hierarchical_label", "symbol", "sheet", "sheet_instances", "symbol_instances", "no_connect", "text", "text_box", "image", "polyline", "arc", "circle", "rectangle", "bezier", "title_block", "bus_alias",
  ]);
  const unknown = directChildren(root).map((node) => head(node) ?? "unknown").filter((nodeHead) => !knownHeads.has(nodeHead));
  const recognized = symbolNodes.length + wires.length + junctions.length + labels.length + noConnects.length + pinAnchors.length;
  const normalized = Array.from(partsByReference.values()).length + wires.length + junctions.length + labels.length + nets.length + pinAnchors.length;
  return {
    schematic,
    parts: Array.from(partsByReference.values()),
    nets,
    sourceMap,
    recognized,
    normalized,
    unknown,
    version: childValue(root, "version"),
    generator: childValue(root, "generator_version") ?? childValue(root, "generator"),
  };
}

function layerRole(name: string): { role: string; side: PcbIr["layers"][number]["side"] } {
  const lower = name.toLowerCase();
  if (lower === "edge.cuts") return { role: "edge", side: "both" };
  const side = lower.startsWith("f.") ? "front" : lower.startsWith("b.") ? "back" : /^in\d+\.cu$/.test(lower) ? "inner" : "unknown";
  if (/^(f|b|in\d+)\.cu$/.test(lower)) return { role: "copper", side };
  if (lower.includes("mask")) return { role: "solder_mask", side };
  if (lower.includes("paste")) return { role: "paste", side };
  if (lower.includes("silk")) return { role: "silkscreen", side };
  if (lower.includes("courtyard")) return { role: "courtyard", side };
  if (lower.includes("fab")) return { role: "fabrication", side };
  return { role: "user", side };
}

function parsePcb(
  input: InputAsset,
  asset: SourceAsset,
  diagnostics: ParseDiagnostic[],
): { pcb?: PcbIr; nets: NetIr[]; constraints: Array<Record<string, unknown>>; sourceMap: SourceRef[]; recognized: number; normalized: number; unknown: string[]; version?: string; generator?: string } {
  let root: SList | undefined;
  try {
    root = rootExpression(parseSExpression(decodeUtf8(input.bytes)));
  } catch (error) {
    diagnostics.push(diagnostic("PARSER_SYNTAX_ERROR", error instanceof Error ? error.message : "KiCad PCB 解析失败。", "error", "syntax", sourceRef(asset.id, asset.relativePath)));
    return { nets: [], constraints: [], sourceMap: [], recognized: 0, normalized: 0, unknown: [] };
  }
  if (!root || head(root) !== "kicad_pcb") return { nets: [], constraints: [], sourceMap: [], recognized: 0, normalized: 0, unknown: [] };
  const documentId = stableId("document", asset.sha256, asset.relativePath);
  const pcbId = stableId("pcb", documentId);
  const fileRef = sourceRef(asset.id, asset.relativePath);
  const sourceMap: SourceRef[] = [fileRef];
  const layersNode = firstChild(root, "layers");
  const layers = layersNode
    ? directChildren(layersNode).map((layerNode) => {
        const sourceId = atom(layerNode.items[0]) ?? "?";
        const name = atom(layerNode.items[1]) ?? `Layer ${sourceId}`;
        const mapped = layerRole(name);
        return { id: stableId("layer", pcbId, sourceId), sourceId, name, role: mapped.role, side: mapped.side, copper: mapped.role === "copper" };
      })
    : [];
  const netMap = new Map<string, string>();
  for (const netNode of directChildren(root, "net")) {
    const id = atom(netNode.items[1]);
    const name = atom(netNode.items[2]);
    if (id !== undefined && name !== undefined) netMap.set(id, name);
  }
  const canonicalNetId = (sourceNativeNetId?: string): string | undefined => {
    if (!sourceNativeNetId || sourceNativeNetId === "0") return undefined;
    const name = netMap.get(sourceNativeNetId);
    return name === undefined ? undefined : stableId("pcb-net", pcbId, sourceNativeNetId, name);
  };

  const pads: PcbIr["pads"] = [];
  const footprints: PcbIr["footprints"] = [];
  const footprintNodes = [...directChildren(root, "footprint"), ...directChildren(root, "module")];
  for (const [index, footprintNode] of footprintNodes.entries()) {
    const libraryIdentifier = atom(footprintNode.items[1]) ?? "unresolved";
    const properties = propertyMap(footprintNode);
    for (const fpText of directChildren(footprintNode, "fp_text")) {
      const kind = atom(fpText.items[1]);
      const value = atom(fpText.items[2]);
      if (kind === "reference" && value) properties.Reference ??= value;
      if (kind === "value" && value) properties.Value ??= value;
    }
    const nativeId = nodeUuid(footprintNode, `footprint:${index}`);
    const id = stableId("footprint", pcbId, nativeId);
    const at = nodeAt(footprintNode);
    const layer = childValue(footprintNode, "layer") ?? "";
    const ref = sourceRef(asset.id, asset.relativePath, "explicit", { nativeId, line: footprintNode.span.line, column: footprintNode.span.column });
    sourceMap.push(ref);
    const padIds: string[] = [];
    for (const [padIndex, padNode] of directChildren(footprintNode, "pad").entries()) {
      const number = atom(padNode.items[1]) ?? "";
      const padType = atom(padNode.items[2]) ?? "unknown";
      const shape = atom(padNode.items[3]) ?? "unknown";
      const localAt = nodeAt(padNode);
      const worldAt = localAt && at ? transformPoint(localAt[0], localAt[1], at[0], at[1], at[2]) : localAt ? [localAt[0], localAt[1]] : undefined;
      const size = firstChild(padNode, "size");
      const net = firstChild(padNode, "net");
      const sourceNativeNetId = atom(net?.items[1]);
      const netName = atom(net?.items[2]) ?? (sourceNativeNetId ? netMap.get(sourceNativeNetId) : undefined);
      const layersList = firstChild(padNode, "layers");
      const padNativeId = childValue(padNode, "uuid") ?? `${nativeId}:pad:${number}:${padIndex}`;
      const padId = stableId("pad", id, padNativeId);
      padIds.push(padId);
      const padRef = sourceRef(asset.id, asset.relativePath, "explicit", { nativeId: padNativeId, line: padNode.span.line, column: padNode.span.column });
      sourceMap.push(padRef);
      pads.push({
        id: padId,
        footprintId: id,
        number,
        padType,
        shape,
        position: worldAt ? point(worldAt[0], worldAt[1]) : undefined,
        size: size ? { x: numericString(atom(size.items[1])), y: numericString(atom(size.items[2])), unit: "mm" } : undefined,
        layers: layersList ? layersList.items.slice(1).map(atom).filter((item): item is string => Boolean(item)) : [],
        netId: canonicalNetId(sourceNativeNetId),
        sourceNativeNetId,
        netName,
        sourceRef: padRef,
      });
    }
    footprints.push({
      id,
      reference: properties.Reference ?? `?${index + 1}`,
      value: properties.Value ?? "",
      libraryIdentifier,
      position: at ? point(at[0], at[1]) : undefined,
      rotation: at?.[2] ?? "0",
      side: layer.startsWith("F.") ? "front" : layer.startsWith("B.") ? "back" : "unknown",
      locked: footprintNode.items.some((item) => item.kind === "atom" && item.value === "locked"),
      padIds,
      sourceRef: ref,
    });
  }

  const tracks: PcbIr["tracks"] = [...directChildren(root, "segment"), ...directChildren(root, "arc")].map((trackNode, index) => {
    const start = firstChild(trackNode, "start");
    const end = firstChild(trackNode, "end");
    const mid = firstChild(trackNode, "mid");
    const nativeId = nodeUuid(trackNode, `${head(trackNode)}:${index}`);
    const ref = sourceRef(asset.id, asset.relativePath, "explicit", { nativeId, line: trackNode.span.line, column: trackNode.span.column });
    sourceMap.push(ref);
    const sourceNativeNetId = childValue(trackNode, "net");
    return {
      id: stableId("track", pcbId, nativeId),
      kind: head(trackNode) === "arc" ? "arc" : "segment",
      start: start ? point(atom(start.items[1]), atom(start.items[2])) : undefined,
      end: end ? point(atom(end.items[1]), atom(end.items[2])) : undefined,
      mid: mid ? point(atom(mid.items[1]), atom(mid.items[2])) : undefined,
      width: childValue(trackNode, "width"),
      layer: childValue(trackNode, "layer"),
      netId: canonicalNetId(sourceNativeNetId),
      sourceNativeNetId,
      sourceRef: ref,
    } as PcbIr["tracks"][number];
  });
  const vias: PcbIr["vias"] = directChildren(root, "via").map((viaNode, index) => {
    const at = nodeAt(viaNode);
    const nativeId = nodeUuid(viaNode, `via:${index}`);
    const ref = sourceRef(asset.id, asset.relativePath, "explicit", { nativeId, line: viaNode.span.line, column: viaNode.span.column });
    sourceMap.push(ref);
    const layerList = firstChild(viaNode, "layers");
    const sourceNativeNetId = childValue(viaNode, "net");
    return {
      id: stableId("via", pcbId, nativeId),
      position: at ? point(at[0], at[1]) : undefined,
      size: childValue(viaNode, "size"),
      drill: childValue(viaNode, "drill"),
      layers: layerList ? layerList.items.slice(1).map(atom).filter((item): item is string => Boolean(item)) : [],
      netId: canonicalNetId(sourceNativeNetId),
      sourceNativeNetId,
      sourceRef: ref,
    };
  });
  const zones: PcbIr["zones"] = directChildren(root, "zone").map((zoneNode, index) => {
    const nativeId = nodeUuid(zoneNode, `zone:${index}`);
    const ref = sourceRef(asset.id, asset.relativePath, "explicit", { nativeId, line: zoneNode.span.line, column: zoneNode.span.column });
    sourceMap.push(ref);
    const layersNode = firstChild(zoneNode, "layers");
    const sourceNativeNetId = childValue(zoneNode, "net");
    return {
      id: stableId("zone", pcbId, nativeId),
      netId: canonicalNetId(sourceNativeNetId),
      sourceNativeNetId,
      layers: layersNode
        ? layersNode.items.slice(1).map(atom).filter((item): item is string => Boolean(item))
        : [childValue(zoneNode, "layer")].filter((item): item is string => Boolean(item)),
      sourceRef: ref,
    };
  });

  const outlineHeads = new Map<string, PcbIr["boardOutline"][number]["kind"]>([
    ["gr_line", "line"], ["gr_arc", "arc"], ["gr_circle", "circle"], ["gr_rect", "rectangle"],
  ]);
  const boardOutline: PcbIr["boardOutline"] = [];
  for (const [nodeHead, kind] of outlineHeads) {
    for (const [index, outlineNode] of directChildren(root, nodeHead).entries()) {
      if (childValue(outlineNode, "layer") !== "Edge.Cuts") continue;
      const nativeId = nodeUuid(outlineNode, `${nodeHead}:${index}`);
      const geometry: Record<string, unknown> = {};
      for (const geometryKey of ["start", "mid", "end", "center"]) {
        const geometryNode = firstChild(outlineNode, geometryKey);
        if (geometryNode) geometry[geometryKey] = point(atom(geometryNode.items[1]), atom(geometryNode.items[2]));
      }
      boardOutline.push({ id: stableId("outline", pcbId, nativeId), kind, geometry });
    }
  }
  if (!boardOutline.length) {
    diagnostics.push(diagnostic("BOARD_OUTLINE_OPEN", `${asset.relativePath} 未解析到 Edge.Cuts 板框。`, "warning", "geometry", fileRef));
  }

  const stackup: PcbIr["stackup"] = [];
  const stackupNode = firstChild(firstChild(root, "setup") ?? root, "stackup");
  if (stackupNode) {
    for (const stackLayer of directChildren(stackupNode, "layer")) {
      stackup.push({
        name: atom(stackLayer.items[1]) ?? null,
        type: childValue(stackLayer, "type") ?? null,
        material: childValue(stackLayer, "material") ?? null,
        thickness: childValue(stackLayer, "thickness") ?? null,
        epsilonR: childValue(stackLayer, "epsilon_r") ?? null,
      });
    }
  }
  const constraints = directChildren(root, "net_class").map((netClass) => ({
    type: "net_class",
    name: atom(netClass.items[1]) ?? "Default",
    clearance: childValue(netClass, "clearance") ?? null,
    trackWidth: childValue(netClass, "trace_width") ?? null,
    viaDiameter: childValue(netClass, "via_dia") ?? null,
    provenance: "explicit",
  }));
  const pcbNets: NetIr[] = Array.from(netMap.entries())
    .filter(([id]) => id !== "0")
    .map(([nativeId, name]) => {
      const id = stableId("pcb-net", pcbId, nativeId, name);
      const netPads = pads.filter((pad) => pad.netId === id);
      const netTracks = tracks.filter((track) => track.netId === id);
      const netVias = vias.filter((via) => via.netId === id);
      const netZones = zones.filter((zone) => zone.netId === id);
      return {
        id,
        domain: "pcb_physical",
        canonicalName: name || `PCB_NET_${nativeId}`,
        displayNames: name ? [name] : [],
        endpoints: [
          ...netPads.map((pad) => ({ id: stableId("endpoint", id, pad.id), type: "footprint_pad" as const, targetId: pad.id, identifier: { pad: pad.number, footprintId: pad.footprintId }, position: pad.position })),
          ...netTracks.map((track) => ({ id: stableId("endpoint", id, track.id), type: "track" as const, targetId: track.id, identifier: { kind: track.kind } })),
          ...netVias.map((via) => ({ id: stableId("endpoint", id, via.id), type: "via" as const, targetId: via.id, identifier: {}, position: via.position })),
          ...netZones.map((zone) => ({ id: stableId("endpoint", id, zone.id), type: "zone" as const, targetId: zone.id, identifier: {} })),
        ],
        segmentIds: netTracks.map((track) => track.id),
        resolution: { method: "explicit", confidence: 1 },
        sourceRefs: [fileRef],
      };
    });

  const pcb: PcbIr = {
    id: pcbId,
    documentId,
    name: withoutExtension(asset.fileName),
    units: "mm",
    coordinateSystem: { sourceUnits: "mm", canonicalUnits: "mm", rotationConvention: "degrees_ccw", precision: "source_token_preserved" },
    layers,
    stackup,
    boardOutline,
    footprints,
    pads,
    tracks,
    vias,
    zones,
    sourceRefs: [fileRef],
  };
  const knownHeads = new Set(["version", "generator", "generator_version", "general", "paper", "title_block", "layers", "setup", "net", "footprint", "module", "segment", "arc", "via", "zone", "gr_line", "gr_arc", "gr_circle", "gr_rect", "gr_poly", "gr_text", "gr_text_box", "dimension", "target", "group", "image", "net_class", "property"]);
  const unknown = directChildren(root).map((node) => head(node) ?? "unknown").filter((nodeHead) => !knownHeads.has(nodeHead));
  const recognized = footprints.length + pads.length + tracks.length + vias.length + zones.length + layers.length + boardOutline.length;
  const normalized = recognized + pcbNets.length + constraints.length;
  return { pcb, nets: pcbNets, constraints, sourceMap, recognized, normalized, unknown, version: childValue(root, "version"), generator: childValue(root, "generator_version") ?? childValue(root, "generator") };
}

export function parseKicad(inputs: InputAsset[], inventory: SourceAsset[]): KicadParseOutput {
  const output: KicadParseOutput = {
    settings: {}, schematics: [], pcbs: [], parts: [], nets: [], constraints: [], libraries: [], sourceMap: [], diagnostics: [], opaqueNodes: [], recognized: 0, normalized: 0, opaque: 0,
  };
  const byPath = new Map(inputs.map((input) => [input.path, input]));
  for (const asset of inventory.filter((item) => item.detectedFormat === "kicad")) {
    const input = byPath.get(asset.relativePath);
    if (!input) continue;
    if (asset.extension === ".kicad_pro") {
      try {
        const project = JSON.parse(decodeUtf8(input.bytes)) as Record<string, unknown>;
        output.projectName = withoutExtension(asset.fileName);
        output.settings = project;
        output.recognized += Object.keys(project).length;
        output.normalized += Object.keys(project).length;
        output.sourceMap.push(sourceRef(asset.id, asset.relativePath));
      } catch {
        output.diagnostics.push(diagnostic("PARSER_SYNTAX_ERROR", `${asset.relativePath} 不是有效的 KiCad Project JSON。`, "error", "syntax", sourceRef(asset.id, asset.relativePath)));
      }
      continue;
    }
    if (asset.extension === ".kicad_sch") {
      const parsed = parseSchematic(input, asset, output.diagnostics);
      if (parsed.schematic) output.schematics.push(parsed.schematic);
      output.parts.push(...parsed.parts);
      output.nets.push(...parsed.nets);
      output.sourceMap.push(...parsed.sourceMap);
      output.recognized += parsed.recognized;
      output.normalized += parsed.normalized;
      output.sourceFormatVersion ??= parsed.version;
      output.sourceToolVersion ??= parsed.generator;
      for (const nodeHead of parsed.unknown) {
        output.opaqueNodes.push({ recordType: nodeHead, sourcePath: asset.relativePath, payloadHash: asset.sha256 });
        output.opaque += 1;
      }
      continue;
    }
    if (asset.extension === ".kicad_pcb") {
      const parsed = parsePcb(input, asset, output.diagnostics);
      if (parsed.pcb) output.pcbs.push(parsed.pcb);
      output.nets.push(...parsed.nets);
      output.constraints.push(...parsed.constraints);
      output.sourceMap.push(...parsed.sourceMap);
      output.recognized += parsed.recognized;
      output.normalized += parsed.normalized;
      output.sourceFormatVersion ??= parsed.version;
      output.sourceToolVersion ??= parsed.generator;
      for (const nodeHead of parsed.unknown) {
        output.opaqueNodes.push({ recordType: nodeHead, sourcePath: asset.relativePath, payloadHash: asset.sha256 });
        output.opaque += 1;
      }
      continue;
    }
    if ([".kicad_sym", ".kicad_mod"].includes(asset.extension)) {
      let libraryDetails: Record<string, unknown> = {};
      try {
        const root = rootExpression(parseSExpression(decodeUtf8(input.bytes)));
        if (!root) throw new Error("root missing");
        if (asset.extension === ".kicad_sym") {
          const symbols = directChildren(root, "symbol").map((symbol) => {
            const name = atom(symbol.items[1]) ?? "unnamed";
            return {
              name,
              pinCount: allDescendants(symbol, "pin").length,
              unitCount: directChildren(symbol, "symbol").length || 1,
            };
          });
          libraryDetails = { objectCount: symbols.length, symbols };
          output.recognized += symbols.length + symbols.reduce((sum, symbol) => sum + symbol.pinCount, 0);
          output.normalized += symbols.length + symbols.reduce((sum, symbol) => sum + symbol.pinCount, 0);
        } else {
          const pads = directChildren(root, "pad").map((pad, index) => ({
            number: atom(pad.items[1]) ?? String(index + 1),
            type: atom(pad.items[2]) ?? "unknown",
            shape: atom(pad.items[3]) ?? "unknown",
          }));
          libraryDetails = {
            objectCount: 1,
            footprints: [{
              name: atom(root.items[1]) ?? withoutExtension(asset.fileName),
              padCount: pads.length,
              pads,
            }],
          };
          output.recognized += 1 + pads.length;
          output.normalized += 1 + pads.length;
        }
      } catch {
        output.diagnostics.push(
          diagnostic(
            "PARSER_SYNTAX_ERROR",
            `${asset.relativePath} 的 KiCad 库 S-expression 无法解析，已保留原文件。`,
            "error",
            "syntax",
            sourceRef(asset.id, asset.relativePath),
            "preserved",
          ),
        );
        output.opaque += 1;
      }
      output.libraries.push({
        id: stableId("library", asset.id),
        name: basename(asset.relativePath),
        type: asset.extension === ".kicad_sym" ? "symbol" : "footprint",
        resolutionSource: "project_local",
        resolutionStatus: "preserved",
        sourceAssetId: asset.id,
        ...libraryDetails,
      });
      output.sourceMap.push(sourceRef(asset.id, asset.relativePath));
      continue;
    }
    output.opaqueNodes.push({ recordType: `kicad_asset${asset.extension}`, sourcePath: asset.relativePath, payloadHash: asset.sha256 });
    output.opaque += 1;
  }
  if (!output.schematics.length && !output.pcbs.length && !output.libraries.length) {
    output.diagnostics.push(diagnostic("PROJECT_ENTRY_NOT_FOUND", "未找到可解析的 .kicad_sch 或 .kicad_pcb 入口。", "error", "structure"));
  }
  return output;
}
