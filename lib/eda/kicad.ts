import {legacyFieldLayout,legacyLabelRotation} from "./legacy-text";
import { activeKicadDocuments } from "./active-documents";
import { arcPoints } from "./view-geometry";
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

type SymbolPinDefinition = { number: string; name: string; x: string; y: string; electricalType?: string };
type SymbolDefinition = { libraryId: string; pins: SymbolPinDefinition[]; multiUnit?: boolean };
type PinAnchor = {
  id: string;
  partId: string;
  symbolUnitId: string;
  reference: string;
  pin: string;
  name: string;
  electricalType?: string;
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

// Symbol libraries use Cartesian +Y up; schematic sheets use +Y down.
function schematicPinPoint(x: string, y: string, ox: string, oy: string, rotation: string, mirror?: string): [string,string] {
  const [rx, ry] = transformPoint(x, y, "0", "0", rotation);
  return [String(Number(ox)+(mirror === "y" ? -1 : 1)*Number(rx)), String(Number(oy)-(mirror === "x" ? -1 : 1)*Number(ry))];
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
        electricalType: atom(pinNode.items[1]),
        number: childValue(pinNode, "number") ?? "?",
        name: childValue(pinNode, "name") ?? "",
        x: at[0],
        y: at[1],
      };
    });
    result.set(libraryId, { libraryId, pins, multiUnit: allDescendants(definition, "symbol").some(node => { const match = atom(node.items[1])?.match(/_(\d+)_(\d+)$/); return match ? Number(match[1]) > 1 || Number(match[2]) > 1 : false; }) });
  }
  return result;
}

export function buildConnectivity(
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
  for (const label of schematic.labels) {
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
  if (directChildren(root, "sheet").length || directChildren(root, "bus").length) diagnostics.push(diagnostic("SCHEMATIC_HIERARCHY_BUS_UNRESOLVED", "层级 Sheet / Bus 尚未完整解析，连接不可用于自动发布。", "warning", "connectivity", fileRef));
  const partsByReference = new Map<string, PartIr>();
  const pinAnchors: PinAnchor[] = [];
  const powerLabels: SchematicIr["labels"] = [];
  const graphics: NonNullable<SchematicIr["graphics"]> = [];
  const texts: NonNullable<SchematicIr["texts"]> = [];
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
    if (definition?.multiUnit) diagnostics.push(diagnostic("SCHEMATIC_MULTIUNIT_UNRESOLVED", `${reference} 的多单元/替代图形管脚尚未完整区分，不能批准连接。`, "warning", "connectivity", ref));

    const isPowerSymbol = reference.startsWith("#PWR") || libraryId.startsWith("power:");
    if (at) {
    const embedded = directChildren(firstChild(root, "lib_symbols") ?? root, "symbol").find(n => atom(n.items[1]) === libraryId);
    const mirror = childValue(symbolNode, "mirror");
    const drawPoint = (x: string, y: string) => point(...schematicPinPoint(x, y, at[0], at[1], at[2], mirror))!;
    for (const sub of embedded ? directChildren(embedded, "symbol") : []) {
      const suffix = (atom(sub.items[1]) ?? "").match(/_(\d+)_(\d+)$/);
      if (suffix && (Number(suffix[1]) !== 0 && Number(suffix[1]) !== unit || Number(suffix[2]) > 1)) continue;
      for (const node of sub.items.filter((n): n is SList => n.kind === "list")) {
        const kind = head(node);
        let coords: Array<[string, string]> = [];
        const xy = (key: string): [string, string] => { const n = firstChild(node, key); return [atom(n?.items[1]) ?? "0", atom(n?.items[2]) ?? "0"]; };
        if (kind === "rectangle") { const a = xy("start"), b = xy("end"); coords = [a, [b[0], a[1]], b, [a[0], b[1]], a]; }
        if (kind === "polyline") coords = directChildren(firstChild(node, "pts") ?? node, "xy").map(n => [atom(n.items[1]) ?? "0", atom(n.items[2]) ?? "0"]);
        if (kind === "circle") { const c = xy("center"), r = Number(childValue(node, "radius")); coords = Array.from({length:49}, (_, i) => [String(Number(c[0])+r*Math.cos(i*Math.PI/24)), String(Number(c[1])+r*Math.sin(i*Math.PI/24))]); }
        if (kind === "arc") { const a=xy("start"), m=xy("mid"), b=xy("end"); coords=arcPoints({x:Number(a[0]),y:Number(a[1])},{x:Number(m[0]),y:Number(m[1])},{x:Number(b[0]),y:Number(b[1])}).map(p=>[String(p.x),String(p.y)]); }
        if (kind === "pin") { const a = nodeAt(node); if (a) { const r = Number(a[2])*Math.PI/180, len = Number(childValue(node, "length") ?? 0); coords = [[a[0],a[1]], [String(Number(a[0])+len*Math.cos(r)),String(Number(a[1])+len*Math.sin(r))]]; } }
        if (coords.length) graphics.push({id: stableId("graphic", stableId("symbol-unit", partsByReference.get(reference)?.id ?? stableId("part", schematicId, reference), unit, nativeId), graphics.length), symbolUnitId:stableId("symbol-unit", partsByReference.get(reference)?.id ?? stableId("part", schematicId, reference), unit, nativeId), points: coords.map(([x,y]) => drawPoint(x,y)), closed: kind === "rectangle" || kind === "circle"});
      }
    }
    }
    if (isPowerSymbol) {
      if (at) {
        const powerPin = definition?.pins[0];
        const [x, y] = powerPin
          ? schematicPinPoint(powerPin.x, powerPin.y, at[0], at[1], at[2], childValue(symbolNode,"mirror"))
          : [at[0], at[1]];
        const valueProperty=directChildren(symbolNode,"property").find(n=>atom(n.items[1])==="Value");
        const textAt=valueProperty && nodeAt(valueProperty);
        const name = fields.Value || libraryId.replace(/^power:/, "") || reference;
        powerLabels.push({
          id: stableId("label", schematicId, nativeId, "power"),
          name,
          kind: "power",
          textPosition:textAt?point(textAt[0],textAt[1]):undefined,
          rotation:textAt?String((Number(textAt[2])+Number(at[2]))%180):"0",
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
      manufacturerRaw: fields.Manufacturer || fields.Manufacturer_Name || fields.Mfr || fields.MFR || fields["制造商"] || fields["厂商"],
      mpnRaw: fields.MPN || fields["Manufacturer Part Number"] || fields.Manufacturer_Part_Number || fields.Mfr_PN || fields["制造商料号"],
      variantStatus,
      pinPadMap: [],
      sourceRefs: [],
    };
    for (const property of directChildren(symbolNode, "property")) {
      const kind = atom(property.items[1]) ?? "";
      if (!["Reference", "Value"].includes(kind)) continue;
      const effects = firstChild(property,"effects"), pa = nodeAt(property);
      const hidden = childValue(property,"hide") === "yes" || !!(effects && (firstChild(effects,"hide") || effects.items.some(n=>n.kind==="atom" && n.value==="hide")));
      if (!pa || hidden) continue;
      const font = effects && firstChild(effects,"font"), size = font && firstChild(font,"size");
      const justify = effects && firstChild(effects,"justify");
      const alignment = justify?.items.map(atom);
      texts.push({id:stableId("text",unitId,kind),symbolUnitId:unitId,text:atom(property.items[2]) ?? "",kind,position:point(pa[0],pa[1])!,rotation:String(((Number(pa[2])+Number(at?.[2]??0))%180+180)%180),size:atom(size?.items[1]) ?? "1.27",align:alignment?.includes("left")?"start":alignment?.includes("right")?"end":"middle"});
    }
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
      const [x, y] = schematicPinPoint(pinDefinition.x, pinDefinition.y, at[0], at[1], at[2], childValue(symbolNode,"mirror"));
      pinAnchors.push({
        id: stableId("pin", unitId, pinDefinition.number),
        partId,
        symbolUnitId: unitId,
        reference,
        pin: pinDefinition.number,
        name: pinDefinition.name,
        electricalType: pinDefinition.electricalType,
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
        return [{ id: stableId("label", schematicId, nativeId), name, kind, shape:childValue(labelNode,"shape"), rotation:at[2], size:childValue(firstChild(firstChild(labelNode,"effects") ?? labelNode,"font") ?? labelNode,"size") ?? "1.27", position: point(at[0], at[1])!, sourceRef: ref }];
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
    page: (() => {
      const paper = firstChild(root, "paper");
      const name = atom(paper?.items[1]) ?? "A4";
      const sizes: Record<string, [number, number]> = {A0:[1189,841],A1:[841,594],A2:[594,420],A3:[420,297],A4:[297,210],A5:[210,148],A:[279.4,215.9],B:[431.8,279.4],C:[558.8,431.8],D:[863.6,558.8],E:[1117.6,863.6],USLetter:[279.4,215.9],USLegal:[355.6,215.9],USLedger:[431.8,279.4]};
      let [width,height] = name === "User" ? [Number(atom(paper?.items[2])),Number(atom(paper?.items[3]))] : sizes[name] ?? sizes.A4;
      if (paper?.items.some(n => atom(n) === "portrait")) [width,height] = [height,width];
      const title = firstChild(root,"title_block");
      return {width: Number.isFinite(width)&&width>0?width:297, height:Number.isFinite(height)&&height>0?height:210, title:title?childValue(title,"title"):undefined};
    })(),
    graphics,
    texts,
    sheetBoxes: directChildren(root, "sheet").flatMap((node, index) => {
      const at = nodeAt(node), size = firstChild(node, "size"); if (!at || !size) return [];
      const fields = propertyMap(node);
      return [{ id: stableId("sheet-box", schematicId, index), name: fields.Sheetname ?? fields["Sheet name"] ?? "Sheet", file: fields.Sheetfile ?? fields["Sheet file"] ?? "", position: point(at[0],at[1])!, size: {x: atom(size.items[1]) ?? "0", y: atom(size.items[2]) ?? "0"}, pins: directChildren(node,"pin").flatMap(pin => { const p = nodeAt(pin); return p ? [{name: atom(pin.items[1]) ?? "", position: point(p[0],p[1])!}] : []; }) }];
    }),
    symbolInstanceIds: Array.from(partsByReference.values()).flatMap((part) => part.symbolUnits.map((unit) => unit.id)),
    pins: pinAnchors.map((pinAnchor) => ({
      id: pinAnchor.id,
      partId: pinAnchor.partId,
      symbolUnitId: pinAnchor.symbolUnitId,
      reference: pinAnchor.reference,
      number: pinAnchor.pin,
      name: pinAnchor.name,
      electricalType: pinAnchor.electricalType,
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

type LegacySymbolPinDefinition = SymbolPinDefinition & { unit: number };
type LegacySymbolDefinition = { libraryId: string; pins: LegacySymbolPinDefinition[]; drawings: string[] };

function cleanNumber(value: number): string {
  if (Math.abs(value) < 1e-9) return "0";
  return Number(value.toFixed(6)).toString();
}

function legacyToMillimeters(value: string | number): string {
  return cleanNumber(Number(value) * 0.0254);
}

function legacyLibraryKey(value: string): string {
  return value.replace(/:/g, "_").toLowerCase();
}

function parseLegacySymbolDefinitions(inputs: InputAsset[]): Map<string, LegacySymbolDefinition> {
  const definitions = new Map<string, LegacySymbolDefinition>();
  for (const input of inputs.filter((candidate) => /\.lib$/i.test(candidate.path))) {
    const lines = decodeUtf8(input.bytes).split(/\r?\n/);
    let current: LegacySymbolDefinition | undefined;
    for (const line of lines) {
      const definitionMatch = line.match(/^DEF\s+(\S+)\s+/);
      if (definitionMatch) {
        current = { libraryId: definitionMatch[1], pins: [], drawings: [] };
        definitions.set(legacyLibraryKey(current.libraryId), current);
        continue;
      }
      if (line === "ENDDEF") {
        current = undefined;
        continue;
      }
      if(current && /^[SPACX] /.test(line))current.drawings.push(line);
      if (!current || !line.startsWith("X ")) continue;
      const tokens = line.trim().split(/\s+/);
      if (tokens.length < 11) continue;
      current.pins.push({
        name: tokens[1] === "~" ? "" : tokens[1],
        number: tokens[2],
        x: tokens[3],
        y: tokens[4],
        unit: Number(tokens[9]) || 0,
      });
    }
  }
  return definitions;
}

function legacyQuotedFields(line: string): string[] {
  return Array.from(line.matchAll(/"((?:\\.|[^"])*)"/g), (match) => match[1].replace(/\\"/g, '"'));
}

function resolveLegacySymbolDefinition(
  definitions: Map<string, LegacySymbolDefinition>,
  libraryId: string,
): LegacySymbolDefinition | undefined {
  const normalized = legacyLibraryKey(libraryId);
  return (
    definitions.get(normalized) ??
    definitions.get(normalized.replace(/^.+?_/, "")) ??
    Array.from(definitions.values()).find((definition) => normalized.endsWith(`_${legacyLibraryKey(definition.libraryId)}`))
  );
}

function parseLegacySchematic(
  input: InputAsset,
  asset: SourceAsset,
  definitions: Map<string, LegacySymbolDefinition>,
  diagnostics: ParseDiagnostic[],
): {
  schematic?: SchematicIr;
  parts: PartIr[];
  nets: NetIr[];
  sourceMap: SourceRef[];
  recognized: number;
  normalized: number;
  version?: string;
} {
  const lines = decodeUtf8(input.bytes).split(/\r?\n/);
  const version = lines[0]?.match(/^EESchema Schematic File Version\s+(\d+)/)?.[1];
  const fileRef = sourceRef(asset.id, asset.relativePath);
  if (!version) {
    diagnostics.push(
      diagnostic(
        "FORMAT_AMBIGUOUS",
        `${asset.relativePath} 不是可识别的 KiCad Legacy Eeschema 原理图。`,
        "error",
        "format",
        fileRef,
      ),
    );
    return { parts: [], nets: [], sourceMap: [fileRef], recognized: 0, normalized: 0 };
  }

  const documentId = stableId("document", asset.sha256, asset.relativePath);
  const schematicId = stableId("schematic", documentId);
  const partsByReference = new Map<string, PartIr>();
  const pinAnchors: PinAnchor[] = [];
  const wires: SchematicIr["wires"] = [];
  const junctions: SchematicIr["junctions"] = [];
  const labels: SchematicIr["labels"] = [];
  const graphics: NonNullable<SchematicIr["graphics"]> = [];
  const texts: NonNullable<SchematicIr["texts"]> = [];
  const noConnects: SchematicIr["noConnects"] = [];
  const sourceMap: SourceRef[] = [fileRef];
  const missingDefinitions = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "$Comp") {
      const startLine = index + 1;
      const block: string[] = [];
      while (index + 1 < lines.length && lines[index + 1] !== "$EndComp") {
        index += 1;
        block.push(lines[index]);
      }
      const libraryMatch = block.find((item) => item.startsWith("L "))?.match(/^L\s+(\S+)\s+(.+)$/);
      const unitMatch = block.find((item) => item.startsWith("U "))?.match(/^U\s+(\d+)\s+\d+\s+(\S+)/);
      const positionMatch = block.find((item) => item.startsWith("P "))?.match(/^P\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/);
      const transformMatch = block
        .map((item) => item.match(/^\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/))
        .find((match): match is RegExpMatchArray => Boolean(match));
      const fieldValues = new Map<number, string>();
      const namedFields: Record<string, string> = {};
      for (const fieldLine of block.filter((item) => /^F\s+\d+\s+/.test(item))) {
        const fieldIndex = Number(fieldLine.match(/^F\s+(\d+)/)?.[1]);
        const quoted = legacyQuotedFields(fieldLine);
        if (quoted[0] !== undefined) fieldValues.set(fieldIndex, quoted[0]);
        if (quoted.length > 1 && quoted.at(-1)) namedFields[quoted.at(-1)!] = quoted[0] ?? "";
      }
      const reference = fieldValues.get(0) || libraryMatch?.[2] || `?${partsByReference.size + 1}`;
      const libraryId = libraryMatch?.[1] ?? "unresolved";
      const value = fieldValues.get(1) ?? "";
      const footprint = fieldValues.get(2) || undefined;
      const unit = Number(unitMatch?.[1] ?? 1);
      const nativeId = unitMatch?.[2] ?? `${reference}:${startLine}`;
      const ref = sourceRef(asset.id, asset.relativePath, "explicit", { nativeId, line: startLine });
      sourceMap.push(ref);
      if (!positionMatch) continue;
      const originX = Number(positionMatch[1]);
      const originY = Number(positionMatch[2]);
      const matrix = transformMatch
        ? transformMatch.slice(1, 5).map(Number)
        : [1, 0, 0, -1];
      const definition = resolveLegacySymbolDefinition(definitions, libraryId);
      const isPowerSymbol = reference.startsWith("#PWR") || /(^|:)power[:_]/i.test(libraryId) || libraryMatch?.[2]?.startsWith("#PWR");
      const transformLegacyPin = (pinDefinition: LegacySymbolPinDefinition): [string, string] => {
        const localX = Number(pinDefinition.x);
        const localY = Number(pinDefinition.y);
        const x = originX + matrix[0] * localX + matrix[1] * localY;
        const y = originY + matrix[2] * localX + matrix[3] * localY;
        return [legacyToMillimeters(x), legacyToMillimeters(y)];
      };

      const graphicUnit=stableId("symbol-unit",partsByReference.get(reference)?.id??stableId("part",schematicId,reference),unit,nativeId);
      for(const line of definition?.drawings??[]){
        const t=line.trim().split(/\s+/),v=t.map(Number);let xy:number[][]=[],u=0,convert=1;
        if(t[0]==="P"){u=v[2];convert=v[3];xy=Array.from({length:v[1]},(_,i)=>[v[5+i*2],v[6+i*2]]);}
        if(t[0]==="S"){u=v[5];convert=v[6];xy=[[v[1],v[2]],[v[3],v[2]],[v[3],v[4]],[v[1],v[4]],[v[1],v[2]]];}
        if(t[0]==="C"||t[0]==="A"){
          u=v[t[0]==="C"?4:6];convert=v[t[0]==="C"?5:7];
          const a=t[0]==="C"?0:v[4]*Math.PI/1800;let sweep=t[0]==="C"?Math.PI*2:(v[5]-v[4])*Math.PI/1800;
          if(t[0]==="A"){while(sweep<0)sweep+=2*Math.PI;while(sweep>2*Math.PI)sweep-=2*Math.PI;}
          xy=Array.from({length:49},(_,i)=>[v[1]+v[3]*Math.cos(a+sweep*i/48),v[2]+v[3]*Math.sin(a+sweep*i/48)]);
        }
        if(t[0]==="X"){
          u=v[9];convert=v[10];if(t[12]?.includes("N"))continue;
          const directions:Record<string,number[]>={R:[1,0],L:[-1,0],U:[0,1],D:[0,-1]};const d=directions[t[6]]??[0,0];xy=[[v[3],v[4]],[v[3]+v[5]*d[0],v[4]+v[5]*d[1]]];
        }
        if((u!==0&&u!==unit)||convert>1||!xy.length)continue;
        graphics.push({id:stableId("legacy-graphic",graphicUnit,graphics.length),symbolUnitId:graphicUnit,closed:t[0]==="S"||t[0]==="C",points:xy.map(([x,y])=>point(...transformLegacyPin({x:String(x),y:String(y)} as LegacySymbolPinDefinition))!)});
      }
      for(const field of block){
        const m=field.match(/^F\s+([01])\s+"((?:\\.|[^"\\])*)"\s+([HV])\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+(\S+)/);
        if(!m||m[7]!=="0000"||isPowerSymbol)continue;
        const layout=legacyFieldLayout(Number(m[4]),Number(m[5]),originX,originY,matrix,m[3]==="V",m[8]);
        texts.push({id:stableId("legacy-text",graphicUnit,m[1]),symbolUnitId:graphicUnit,kind:m[1]==="0"?"Reference":"Value",text:m[2],position:point(legacyToMillimeters(layout.x),legacyToMillimeters(layout.y))!,size:legacyToMillimeters(m[6]),rotation:layout.rotation,align:layout.align});
      }
      if (isPowerSymbol) {
        const powerPin = definition?.pins.find((pinDefinition) => pinDefinition.unit === 0 || pinDefinition.unit === unit);
        const [x, y] = powerPin
          ? transformLegacyPin(powerPin)
          : [legacyToMillimeters(originX), legacyToMillimeters(originY)];
        const valueField=block.find(l=>/^F\s+1\s/.test(l))?.match(/^F\s+1\s+"(?:\\.|[^"\\])*"\s+([HV])\s+(-?\d+)\s+(-?\d+)\s+(\d+)/);
        const fieldLayout=valueField?legacyFieldLayout(Number(valueField[2]),Number(valueField[3]),originX,originY,matrix,valueField[1]==="V","C"):undefined;
        labels.push({
          id: stableId("label", schematicId, nativeId, "power"),
          name: value || libraryId.replace(/^.*power[:_]/i, "") || reference,
          kind: "power",
          textPosition:fieldLayout?point(legacyToMillimeters(fieldLayout.x),legacyToMillimeters(fieldLayout.y)):undefined,
          size:valueField?legacyToMillimeters(valueField[4]):undefined,
          rotation:fieldLayout?.rotation??"0",
          position: point(x, y)!,
          sourceRef: ref,
        });
        continue;
      }

      const existing = partsByReference.get(reference);
      const partId = existing?.id ?? stableId("part", schematicId, reference);
      const unitId = stableId("symbol-unit", partId, unit, nativeId);
      const fields = {
        Reference: reference,
        Value: value,
        Footprint: footprint ?? "",
        Library: libraryId,
        ...namedFields,
      };
      const part: PartIr = existing ?? {
        id: partId,
        logicalPartKey: reference,
        reference,
        value,
        symbolUnits: [],
        footprint,
        fields,
        manufacturerRaw: namedFields.Manufacturer,
        mpnRaw: namedFields.MPN || namedFields["Manufacturer Part Number"],
        variantStatus: "fitted",
        pinPadMap: [],
        sourceRefs: [],
      };
      part.symbolUnits.push({
        id: unitId,
        unit,
        position: point(legacyToMillimeters(originX), legacyToMillimeters(originY)),
        rotation: matrix.join(","),
      });
      part.sourceRefs.push(ref);
      partsByReference.set(reference, part);

      if (!definition) {
        missingDefinitions.add(libraryId);
        continue;
      }
      for (const pinDefinition of definition.pins.filter((candidate) => candidate.unit === 0 || candidate.unit === unit)) {
        const [x, y] = transformLegacyPin(pinDefinition);
        pinAnchors.push({
          id: stableId("pin", unitId, pinDefinition.number),
          partId,
          symbolUnitId: unitId,
          reference,
          pin: pinDefinition.number,
          name: pinDefinition.name,
        electricalType: pinDefinition.electricalType,
          x,
          y,
          sourceRef: ref,
        });
      }
      continue;
    }

    if (line === "Wire Wire Line") {
      const coordinates = lines[index + 1]?.trim().split(/\s+/).map(Number);
      if (coordinates?.length === 4 && coordinates.every(Number.isFinite)) {
        const nativeId = `wire:${index + 1}`;
        const ref = sourceRef(asset.id, asset.relativePath, "explicit", { nativeId, line: index + 1 });
        const points = [
          point(legacyToMillimeters(coordinates[0]), legacyToMillimeters(coordinates[1]))!,
          point(legacyToMillimeters(coordinates[2]), legacyToMillimeters(coordinates[3]))!,
        ];
        wires.push({ id: stableId("wire", schematicId, nativeId), points, sourceRef: ref });
        sourceMap.push(ref);
        index += 1;
      }
      continue;
    }

    const connectionMatch = line.match(/^Connection ~\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/);
    if (connectionMatch) {
      const nativeId = `junction:${index + 1}`;
      const ref = sourceRef(asset.id, asset.relativePath, "explicit", { nativeId, line: index + 1 });
      junctions.push({
        id: stableId("junction", schematicId, nativeId),
        position: point(legacyToMillimeters(connectionMatch[1]), legacyToMillimeters(connectionMatch[2]))!,
        sourceRef: ref,
      });
      sourceMap.push(ref);
      continue;
    }

    const labelMatch = line.match(/^Text\s+(Label|GLabel|HLabel)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/);
    if (labelMatch && lines[index + 1] !== undefined) {
      const kind: SchematicIr["labels"][number]["kind"] =
        labelMatch[1] === "GLabel" ? "global" : labelMatch[1] === "HLabel" ? "hierarchical" : "local";
      const nativeId = `label:${index + 1}`;
      const ref = sourceRef(asset.id, asset.relativePath, "explicit", { nativeId, line: index + 1 });
      labels.push({
        id: stableId("label", schematicId, nativeId),
        name: lines[index + 1].trim(),
        kind,
        rotation: String(legacyLabelRotation(kind,Number(line.trim().split(/\s+/)[4]))),
        size:legacyToMillimeters(line.trim().split(/\s+/)[5]??50),
        shape:({Input:"input",Output:"output",BiDi:"bidirectional",3:"tri_state",Passive:"passive"} as Record<string,string>)[line.trim().split(/\s+/)[6]]??"passive",
        position: point(legacyToMillimeters(labelMatch[2]), legacyToMillimeters(labelMatch[3]))!,
        sourceRef: ref,
      });
      sourceMap.push(ref);
      index += 1;
      continue;
    }

    const noConnectMatch = line.match(/^NoConn ~\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/);
    if (noConnectMatch) {
      noConnects.push(point(legacyToMillimeters(noConnectMatch[1]), legacyToMillimeters(noConnectMatch[2]))!);
    }
  }

  if (missingDefinitions.size > 0) {
    diagnostics.push(
      diagnostic(
        "SYMBOL_DEFINITION_MISSING",
        `${asset.relativePath} 有 ${missingDefinitions.size} 个 Legacy 符号定义未在工程缓存库中找到；器件实例已保留，相关 Pin 连接可能不完整。`,
        "warning",
        "library",
        fileRef,
        "preserved",
      ),
    );
  }
  const title = lines.map((line) => line.match(/^Title\s+"(.*)"$/)?.[1]).find(Boolean);
  const rootSheetId = stableId("sheet", schematicId, "/");
  const schematic: SchematicIr = {
    id: schematicId,
    documentId,
    name: title || withoutExtension(asset.fileName),
    graphics, texts,
    rootSheetId,
    sheets: [{ id: rootSheetId, name: title || withoutExtension(asset.fileName), instancePath: "/" }],
    symbolInstanceIds: Array.from(partsByReference.values()).flatMap((part) => part.symbolUnits.map((unitItem) => unitItem.id)),
    pins: pinAnchors.map((pinAnchor) => ({
      id: pinAnchor.id,
      partId: pinAnchor.partId,
      symbolUnitId: pinAnchor.symbolUnitId,
      reference: pinAnchor.reference,
      number: pinAnchor.pin,
      name: pinAnchor.name,
      electricalType: pinAnchor.electricalType,
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
  const recognized = partsByReference.size + labels.length + wires.length + junctions.length + noConnects.length + pinAnchors.length;
  return {
    schematic,
    parts: Array.from(partsByReference.values()),
    nets,
    sourceMap,
    recognized,
    normalized: recognized + nets.length,
    version,
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

type NumericPoint = { x: number; y: number };

function numericPointFromNode(node?: SList): NumericPoint | undefined {
  const x = Number(atom(node?.items[1]));
  const y = Number(atom(node?.items[2]));
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function irPointFromNumeric(value: NumericPoint) {
  return point(cleanNumber(value.x), cleanNumber(value.y))!;
}

function transformFootprintGeometryPoint(
  value: NumericPoint,
  footprintAt: [string, string, string],
  mirrored: boolean,
): NumericPoint {
  const localX = mirrored ? -value.x : value.x;
  const [x, y] = transformPoint(
    cleanNumber(localX),
    cleanNumber(value.y),
    footprintAt[0],
    footprintAt[1],
    footprintAt[2],
  );
  return { x: Number(x), y: Number(y) };
}

function rotateNumericPoint(value: NumericPoint, center: NumericPoint, angle: number): NumericPoint {
  const radians = (angle * Math.PI) / 180;
  const dx = value.x - center.x;
  const dy = value.y - center.y;
  return {
    x: center.x + dx * Math.cos(radians) - dy * Math.sin(radians),
    y: center.y + dx * Math.sin(radians) + dy * Math.cos(radians),
  };
}

function outlineGeometry(
  node: SList,
  kind: PcbIr["boardOutline"][number]["kind"],
  transform?: (value: NumericPoint) => NumericPoint,
  mirrored = false,
): Record<string, unknown> {
  const read = (key: string) => {
    const value = numericPointFromNode(firstChild(node, key));
    return value && transform ? transform(value) : value;
  };
  const geometry: Record<string, unknown> = {};
  if (kind === "line" || kind === "rectangle") {
    const start = read("start");
    const end = read("end");
    if (start) geometry.start = irPointFromNumeric(start);
    if (end) geometry.end = irPointFromNumeric(end);
    return geometry;
  }
  if (kind === "circle") {
    const center = read("center") ?? read("start");
    const end = read("end");
    if (center) geometry.center = irPointFromNumeric(center);
    if (end) geometry.end = irPointFromNumeric(end);
    return geometry;
  }

  const sourceStart = read("start");
  const sourceMid = read("mid");
  const sourceEnd = read("end");
  const angleValue = Number(childValue(node, "angle"));
  if (sourceMid) {
    if (sourceStart) geometry.start = irPointFromNumeric(sourceStart);
    geometry.mid = irPointFromNumeric(sourceMid);
    if (sourceEnd) geometry.end = irPointFromNumeric(sourceEnd);
    return geometry;
  }
  if (sourceStart && sourceEnd && Number.isFinite(angleValue)) {
    const angle = mirrored ? -angleValue : angleValue;
    const calculatedEnd = rotateNumericPoint(sourceEnd, sourceStart, angle);
    geometry.center = irPointFromNumeric(sourceStart);
    geometry.start = irPointFromNumeric(sourceEnd);
    geometry.end = irPointFromNumeric(calculatedEnd);
    geometry.mid = irPointFromNumeric(rotateNumericPoint(sourceEnd, sourceStart, angle / 2));
    geometry.angle = cleanNumber(angle);
    return geometry;
  }
  if (sourceStart) geometry.start = irPointFromNumeric(sourceStart);
  if (sourceEnd) geometry.end = irPointFromNumeric(sourceEnd);
  return geometry;
}

function geometryPoint(geometry: Record<string, unknown>, key: string): NumericPoint | undefined {
  const value = geometry[key] as { x?: string; y?: string } | undefined;
  if (!value) return undefined;
  const x = Number(value.x);
  const y = Number(value.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function circleFromThreePoints(
  start: NumericPoint,
  mid: NumericPoint,
  end: NumericPoint,
): { center: NumericPoint; angle: number } | undefined {
  const determinant =
    2 * (start.x * (mid.y - end.y) + mid.x * (end.y - start.y) + end.x * (start.y - mid.y));
  if (Math.abs(determinant) < 1e-9) return undefined;
  const startSquared = start.x ** 2 + start.y ** 2;
  const midSquared = mid.x ** 2 + mid.y ** 2;
  const endSquared = end.x ** 2 + end.y ** 2;
  const center = {
    x:
      (startSquared * (mid.y - end.y) +
        midSquared * (end.y - start.y) +
        endSquared * (start.y - mid.y)) /
      determinant,
    y:
      (startSquared * (end.x - mid.x) +
        midSquared * (start.x - end.x) +
        endSquared * (mid.x - start.x)) /
      determinant,
  };
  const normalize = (angle: number) => ((angle % 360) + 360) % 360;
  const startAngle = normalize((Math.atan2(start.y - center.y, start.x - center.x) * 180) / Math.PI);
  const midAngle = normalize((Math.atan2(mid.y - center.y, mid.x - center.x) * 180) / Math.PI);
  const endAngle = normalize((Math.atan2(end.y - center.y, end.x - center.x) * 180) / Math.PI);
  const positiveSweep = normalize(endAngle - startAngle);
  const midSweep = normalize(midAngle - startAngle);
  return { center, angle: midSweep <= positiveSweep ? positiveSweep : positiveSweep - 360 };
}

function calculatePhysicalDimensions(
  outline: PcbIr["boardOutline"],
  thickness?: string,
): PcbIr["physicalDimensions"] | undefined {
  const points: NumericPoint[] = [];
  const endpointCounts = new Map<string, number>();
  let hasClosedPrimitive = false;
  const registerEndpoint = (value?: NumericPoint) => {
    if (!value) return;
    points.push(value);
    const key = `${cleanNumber(value.x)},${cleanNumber(value.y)}`;
    endpointCounts.set(key, (endpointCounts.get(key) ?? 0) + 1);
  };
  const registerArcExtrema = (center: NumericPoint, start: NumericPoint, angle: number) => {
    const radius = Math.hypot(start.x - center.x, start.y - center.y);
    const normalize = (candidate: number) => ((candidate % 360) + 360) % 360;
    const startAngle = normalize((Math.atan2(start.y - center.y, start.x - center.x) * 180) / Math.PI);
    const onSweep = (candidate: number) => {
      if (angle >= 0) return normalize(candidate - startAngle) <= angle + 1e-7;
      return normalize(startAngle - candidate) <= -angle + 1e-7;
    };
    for (const candidate of [0, 90, 180, 270]) {
      if (!onSweep(candidate)) continue;
      const radians = (candidate * Math.PI) / 180;
      points.push({ x: center.x + radius * Math.cos(radians), y: center.y + radius * Math.sin(radians) });
    }
  };

  for (const item of outline) {
    const start = geometryPoint(item.geometry, "start");
    const end = geometryPoint(item.geometry, "end");
    if (item.kind === "line") {
      registerEndpoint(start);
      registerEndpoint(end);
      continue;
    }
    if (item.kind === "rectangle") {
      if (start && end) {
        points.push(start, end, { x: start.x, y: end.y }, { x: end.x, y: start.y });
        hasClosedPrimitive = true;
      }
      continue;
    }
    if (item.kind === "circle") {
      const center = geometryPoint(item.geometry, "center");
      if (center && end) {
        const radius = Math.hypot(end.x - center.x, end.y - center.y);
        points.push(
          { x: center.x - radius, y: center.y },
          { x: center.x + radius, y: center.y },
          { x: center.x, y: center.y - radius },
          { x: center.x, y: center.y + radius },
        );
        hasClosedPrimitive = true;
      }
      continue;
    }
    const mid = geometryPoint(item.geometry, "mid");
    let center = geometryPoint(item.geometry, "center");
    let angle = Number(item.geometry.angle);
    if ((!center || !Number.isFinite(angle)) && start && mid && end) {
      const derived = circleFromThreePoints(start, mid, end);
      center = derived?.center;
      angle = derived?.angle ?? Number.NaN;
    }
    registerEndpoint(start);
    registerEndpoint(end);
    if (center && start && Number.isFinite(angle)) registerArcExtrema(center, start, angle);
  }
  if (points.length === 0) return undefined;
  const xs = points.map((value) => value.x);
  const ys = points.map((value) => value.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const outlineClosed =
    hasClosedPrimitive ||
    (endpointCounts.size > 0 && Array.from(endpointCounts.values()).every((count) => count >= 2 && count % 2 === 0));
  return {
    width: cleanNumber(maxX - minX),
    height: cleanNumber(maxY - minY),
    thickness,
    unit: "mm",
    boundingBox: {
      minX: cleanNumber(minX),
      minY: cleanNumber(minY),
      maxX: cleanNumber(maxX),
      maxY: cleanNumber(maxY),
    },
    outlineClosed,
  };
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
    const message = error instanceof Error ? error.message : "KiCad PCB 解析失败。";
    const resource = /limit .*exceeded/i.test(message);
    diagnostics.push(diagnostic(resource ? "PCB_RESOURCE_LIMIT" : "PARSER_SYNTAX_ERROR", `${asset.relativePath} (${input.bytes.length} bytes): ${message}${resource ? "。PCB 子解析失败，项目仅部分完成；请移除非必要填充数据后重试，或使用原生 KiCad 导出精简副本。" : ""}`, "error", resource ? "resource" : "syntax", sourceRef(asset.id, asset.relativePath)));
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
      const worldAt = localAt && at ? transformPoint(localAt[0], localAt[1], at[0], at[1], String(-Number(at[2]))) : localAt ? [localAt[0], localAt[1]] : undefined;
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
        rotation: localAt?.[2] ?? "0",
        drill: (() => { const d = firstChild(padNode, "drill"); if (!d) return undefined; const oval = atom(d.items[1]) === "oval"; const x = atom(d.items[oval ? 2 : 1]) ?? "0"; return {x, y: oval ? atom(d.items[3]) ?? x : x}; })(),
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
      models: directChildren(footprintNode,"model").map(model=>{
        const xyz=(key:string, fallback:number)=>{const parent=firstChild(model,key);const n=parent && (firstChild(parent,"xyz")??parent);return [1,2,3].map(i=>Number(atom(n?.items[i])??fallback));};
        const offset=xyz(firstChild(model,"offset")?"offset":"at",0).map(v=>firstChild(model,"offset")?v:v*25.4);
        return {path:atom(model.items[1])??"",offset,scale:xyz("scale",1),rotation:xyz("rotate",0),hidden:!!firstChild(model,"hide")||model.items.some(n=>atom(n)==="hide")};
      }),
      graphics: ([['fp_line','line'],['fp_arc','arc'],['fp_circle','circle'],['fp_rect','rectangle']] as const).flatMap(([nodeHead,kind]) => directChildren(footprintNode,nodeHead).map((node,i)=>({id:stableId("fp-graphic",id,nodeHead,i),layer:childValue(node,"layer")??"",kind,geometry:outlineGeometry(node,kind)}))),
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
      boardOutline.push({
        id: stableId("outline", pcbId, nativeId),
        kind,
        geometry: outlineGeometry(outlineNode, kind),
      });
    }
  }
  const footprintOutlineHeads = new Map<string, PcbIr["boardOutline"][number]["kind"]>([
    ["fp_line", "line"], ["fp_arc", "arc"], ["fp_circle", "circle"], ["fp_rect", "rectangle"],
  ]);
  for (const [footprintIndex, footprintNode] of footprintNodes.entries()) {
    const footprintAt = nodeAt(footprintNode);
    if (!footprintAt) continue;
    const mirrored = (childValue(footprintNode, "layer") ?? "").startsWith("B.");
    for (const [nodeHead, kind] of footprintOutlineHeads) {
      for (const [graphicIndex, outlineNode] of directChildren(footprintNode, nodeHead).entries()) {
        if (childValue(outlineNode, "layer") !== "Edge.Cuts") continue;
        const nativeId = nodeUuid(outlineNode, `footprint:${footprintIndex}:${nodeHead}:${graphicIndex}`);
        boardOutline.push({
          id: stableId("outline", pcbId, nativeId),
          kind,
          geometry: {
            ...outlineGeometry(
              outlineNode,
              kind,
              (value) => transformFootprintGeometryPoint(value, footprintAt, mirrored),
              mirrored,
            ),
            source: "footprint",
          },
        });
      }
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
  const thickness = childValue(firstChild(root, "general") ?? root, "thickness");
  const physicalDimensions = calculatePhysicalDimensions(boardOutline, thickness);
  if (physicalDimensions && !physicalDimensions.outlineClosed) {
    diagnostics.push(
      diagnostic(
        "BOARD_OUTLINE_OPEN",
        `${asset.relativePath} 的 Edge.Cuts 未形成闭合边界；尺寸按外接边界计算，面积和周长未推断。`,
        "warning",
        "geometry",
        fileRef,
        "preserved",
      ),
    );
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
          ...netPads.map((pad) => ({ id: stableId("endpoint", id, pad.id), type: "footprint_pad" as const, targetId: pad.id, identifier: { pad: pad.number, footprintId: pad.footprintId ?? "" }, position: pad.position })),
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
    physicalDimensions,
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

function directoryOf(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  parts.pop();
  return parts.join("/");
}

function normalizeRelativePath(path: string): string {
  const result: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") result.pop();
    else result.push(segment);
  }
  return result.join("/");
}

function selectedLegacySchematicPaths(
  inputs: InputAsset[],
  inventory: SourceAsset[],
): Set<string> {
  const legacySchematics = inventory.filter(
    (asset) => asset.detectedFormat === "kicad" && asset.extension === ".sch",
  );
  const pathByLower = new Map(legacySchematics.map((asset) => [asset.relativePath.toLowerCase(), asset.relativePath]));
  const selected = new Set<string>();
  const projects = inventory.filter(
    (asset) => asset.detectedFormat === "kicad" && asset.extension === ".pro",
  );
  for (const project of projects) {
    const candidate = normalizeRelativePath(
      `${directoryOf(project.relativePath)}/${withoutExtension(project.fileName)}.sch`,
    );
    const actual = pathByLower.get(candidate.toLowerCase());
    if (actual) selected.add(actual);
  }
  if (selected.size === 0) {
    for (const schematic of legacySchematics) selected.add(schematic.relativePath);
  }

  const inputByPath = new Map(inputs.map((input) => [input.path, input]));
  const queue = Array.from(selected);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const input = inputByPath.get(current);
    if (!input) continue;
    const directory = directoryOf(current);
    for (const match of decodeUtf8(input.bytes).matchAll(/^F1\s+"([^"]+\.sch)"/gm)) {
      const candidate = normalizeRelativePath(`${directory}/${match[1]}`);
      const actual = pathByLower.get(candidate.toLowerCase());
      if (actual && !selected.has(actual)) {
        selected.add(actual);
        queue.push(actual);
      }
    }
  }
  return selected;
}

export function parseKicad(inputs: InputAsset[], inventory: SourceAsset[]): KicadParseOutput {
  const output: KicadParseOutput = {
    settings: {}, schematics: [], pcbs: [], parts: [], nets: [], constraints: [], libraries: [], sourceMap: [], diagnostics: [], opaqueNodes: [], recognized: 0, normalized: 0, opaque: 0,
  };
  const byPath = new Map(inputs.map((input) => [input.path, input]));
  const legacyDefinitions = parseLegacySymbolDefinitions(inputs);
  const legacySchematicPaths = selectedLegacySchematicPaths(inputs, inventory);
  const active = activeKicadDocuments(inputs, inventory, output.diagnostics);
  for (const asset of inventory.filter((item) => item.detectedFormat === "kicad")) {
    const input = byPath.get(asset.relativePath);
    if (!input) continue;
    if ([".sch", ".kicad_sch", ".kicad_pcb", ".brd"].includes(asset.extension) && !active.has(asset.relativePath)) {
      asset.irParticipation = "excluded";
      output.diagnostics.push(diagnostic(asset.extension === ".sch" ? "LEGACY_SCHEMATIC_NOT_IN_PROJECT" : "DOCUMENT_NOT_IN_ACTIVE_PROJECT", `${asset.relativePath} 为非活动文档，仅保留源文件清单，不参与 IR。`, "information", "structure", sourceRef(asset.id, asset.relativePath), "preserved"));
      continue;
    }
    asset.irParticipation = "included";
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
    if (asset.extension === ".pro") {
      output.projectName ??= withoutExtension(asset.fileName);
      output.settings.legacyProject = true;
      output.sourceMap.push(sourceRef(asset.id, asset.relativePath));
      output.recognized += 1;
      output.normalized += 1;
      continue;
    }
    if (asset.extension === ".sch") {
      if (!legacySchematicPaths.has(asset.relativePath)) {
        output.opaqueNodes.push({
          recordType: "legacy_schematic_not_in_project",
          sourcePath: asset.relativePath,
          payloadHash: asset.sha256,
        });
        output.opaque += 1;
        output.diagnostics.push(
          diagnostic(
            "LEGACY_SCHEMATIC_NOT_IN_PROJECT",
            `${asset.relativePath} 未被同名 .pro 或层级 Sheet 引用，已作为旁路原理图保留，未合并进当前工程。`,
            "information",
            "structure",
            sourceRef(asset.id, asset.relativePath),
            "preserved",
          ),
        );
        continue;
      }
      const parsed = parseLegacySchematic(input, asset, legacyDefinitions, output.diagnostics);
      if (parsed.schematic) output.schematics.push(parsed.schematic);
      output.parts.push(...parsed.parts);
      output.nets.push(...parsed.nets);
      output.sourceMap.push(...parsed.sourceMap);
      output.recognized += parsed.recognized;
      output.normalized += parsed.normalized;
      output.sourceFormatVersion ??= parsed.version;
      output.sourceToolVersion ??= "Eeschema Legacy";
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
