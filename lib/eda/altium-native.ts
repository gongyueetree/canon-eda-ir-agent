import * as CFB from "cfb";
import { altiumBlocks, altiumProperties } from "./altium-records";
import { attachAltiumModels } from "./altium-models";
import { buildConnectivity, type KicadParseOutput } from "./kicad";
import type { IrPoint, PartIr, PcbIr, SchematicIr, SourceAsset } from "./types";
import { diagnostic, sourceRef, stableId, withoutExtension } from "./util";

// AD stores length-prefixed records inside an OLE compound document. No external
// libraries, scripts, database links or absolute paths in the project are opened.
type Props = Record<string, string>;
const num = (p: Props, k: string) => Number(p[k] ?? 0);
const pt = (x: number, y: number): IrPoint => ({ x: String(Number(x.toFixed(7))), y: String(Number(y.toFixed(7))), unit: "mm" });
const coord = (p: Props, k: string) => (num(p, k) + num(p, `${k}_FRAC`) / 100000) * .254;
const pos = (p: Props, x = "LOCATION.X", y = "LOCATION.Y") => pt(coord(p, x), -coord(p, y));
const decoder = new TextDecoder("windows-1252");
const altiumPinTypes = ["input", "bidirectional", "output", "open_collector", "passive", "tri_state", "open_emitter", "power_in"];
export { altiumBlocks, altiumProperties } from "./altium-records";
function schematic(data: Uint8Array, asset: SourceAsset, out: KicadParseOutput) {
  const records = altiumBlocks(data).slice(1).map(altiumProperties);
  const id = stableId("sch", asset.id), ref = sourceRef(asset.id, asset.relativePath);
  const sch: SchematicIr = { id, documentId: stableId("document", asset.sha256, asset.relativePath), name: withoutExtension(asset.fileName), rootSheetId: `${id}:sheet`, sheets: [{ id: `${id}:sheet`, name: asset.fileName, instancePath: "/" }], texts: [], graphics: [], symbolInstanceIds: [], pins: [], wires: [], junctions: [], labels: [], noConnects: [], connectivityGraphId: stableId("graph", id), sourceRefs: [ref] };
  const components = new Map<number, PartIr>();
  records.forEach((r, index) => {
    if (r.RECORD !== "1") return;
    const children = records.filter(p => p.OWNERINDEX === String(index));
    const fields = Object.fromEntries(children.filter(p => ["34", "41"].includes(p.RECORD) && p.NAME).map(p => [p.NAME.toUpperCase(), p.TEXT ?? ""]));
    if(r.LIBREFERENCE)fields.lib_id=r.LIBREFERENCE;
    const partId = stableId("part", id, String(index));
    const part: PartIr = { id: partId, logicalPartKey: r.UNIQUEID || partId, reference: fields.DESIGNATOR || r.DESIGNATOR || "?", value: fields.COMMENT || r.COMMENT || r.LIBREFERENCE || "", fields, manufacturerRaw: fields.MANUFACTURER, mpnRaw: fields["MANUFACTURER PART NUMBER"] || fields.MPN, variantStatus: "unknown", pinPadMap: [], symbolUnits: [{ id: `${partId}:unit`, unit: num(r, "CURRENTPARTID") || 1, position: pos(r), rotation: "0" }], sourceRefs: [{ ...sourceRef(asset.id, asset.relativePath), nativeId: String(index) }] };
    part.manufacturerRaw ||= fields["MANUFACTURER 1"];
    part.mpnRaw ||= fields["MANUFACTURER PART NUMBER 1"];
    components.set(index, part); out.parts.push(part); sch.symbolInstanceIds.push(part.symbolUnits[0].id);
  });
  const unsupported = new Map<string, number>();
  records.forEach((r, index) => {
    const type = r.RECORD || "binary", owner = components.get(num(r, "OWNERINDEX"));
    const component = records[num(r, "OWNERINDEX")];
    if (owner && num(r, "OWNERPARTID") > 0 && (num(r, "OWNERPARTID") !== (num(component, "CURRENTPARTID") || 1) || num(r, "OWNERPARTDISPLAYMODE") !== num(component, "DISPLAYMODE"))) return;
    const rid = stableId("ad", id, String(index)), unit = owner?.symbolUnits[0].id || rid;
    const sr = { ...sourceRef(asset.id, asset.relativePath), nativeId: String(index) }, p = pos(r);
    const graphic = (points: IrPoint[], closed = false) => { sch.graphics!.push({ id: rid, symbolUnitId: unit, points: closed ? [...points, points[0]] : points, closed }); };
    const points = () => Array.from({ length: Math.min(num(r, "LOCATIONCOUNT"), 10000) }, (_, i) => pos(r, `X${i + 1}`, `Y${i + 1}`));
    if (type === "2" && owner) {
      const angle = (num(r, "PINCONGLOMERATE") & 3) * Math.PI / 2, length = coord(r, "PINLENGTH");
      const end = pt(Number(p.x) + length * Math.cos(angle), Number(p.y) - length * Math.sin(angle));
      if (!(num(r, "PINCONGLOMERATE") & 4)) graphic([p, end]);
      const electrical = r.ELECTRICAL === undefined ? undefined : altiumPinTypes[Number(r.ELECTRICAL)] || "unspecified";
      sch.pins.push({ id: rid, partId: owner.id, symbolUnitId: unit, reference: owner.reference, number: r.DESIGNATOR || "", name: r.NAME || "", electricalType: electrical, position: end, bodyPosition:p, hidden:!!(num(r,"PINCONGLOMERATE")&4), sourceRef: sr });
    } else if (["6", "7"].includes(type)) graphic(points(), type === "7");
    else if (type === "13") graphic([p, pos(r, "CORNER.X", "CORNER.Y")]);
    else if (type === "14") { const q = pos(r, "CORNER.X", "CORNER.Y"); graphic([p, pt(Number(q.x), Number(p.y)), q, pt(Number(p.x), Number(q.y))], true); }
    else if (["8", "12"].includes(type)) {
      const start = num(r, "STARTANGLE"), end = r.ENDANGLE ? num(r, "ENDANGLE") : 360;
      const sweep = ((end - start) % 360 + 360) % 360 || 360;
      const radius = coord(r, "RADIUS"), ry = r.SECONDARYRADIUS ? coord(r, "SECONDARYRADIUS") : radius;
      graphic(Array.from({ length: 49 }, (_, i) => { const a = (start + sweep * i / 48) * Math.PI / 180; return pt(Number(p.x) + radius * Math.cos(a), Number(p.y) - ry * Math.sin(a)); }));
    } else if (type === "27") sch.wires.push({ id: rid, points: points(), sourceRef: sr });
    else if (type === "29") sch.junctions.push({ id: rid, position: p, sourceRef: sr });
    else if (type === "25" || type === "17") {
      const style=num(r,'STYLE');const ground=type==='17'&&([4,5,6,8,9].includes(style)||(!r.STYLE&&/^(?:[A-Z_]*GND|VSS\d*|EARTH)$/i.test(r.TEXT||'')));
      sch.labels.push({ id: rid, name: r.TEXT || "", kind: type === "17" ? "power" : "local", shape:type==='17'?(ground?'ground':style===1||style===7?'arrow':style===0?'circle':'bar'):undefined, position: p, rotation: String(num(r, "ORIENTATION") * 90), size: "1.5", sourceRef: sr });
    } else if (["4", "34", "41"].includes(type)) {
      if (r.ISHIDDEN === "T" || (type === "41" && r.NAME?.toUpperCase() !== "COMMENT")) return;
      const text = r.TEXT || (type === "34" ? owner?.reference : type === "41" ? owner?.value : "");
      if (text) sch.texts!.push({ id: rid, symbolUnitId: owner?.symbolUnits[0].id, text, kind: type === "34" ? "reference" : "value", position: p, rotation: String(num(r, "ORIENTATION") * 90), size: "1.5", align: "start" });
    } else if (!["1", "31", "41", "44", "45", "46", "48"].includes(type)) unsupported.set(type, (unsupported.get(type) || 0) + 1);
  });
  // AD field coordinates often share a symbol's body or pin wiring. Position
  // both visible properties together beside the actual drawn body.
  for (const part of components.values()) {
    const unit = part.symbolUnits[0], pins=sch.pins.filter(p=>p.symbolUnitId===unit.id);
    const graphics = sch.graphics!.filter(g => g.symbolUnitId === unit.id && !pins.some(pin=>
      g.points.length===2 && [pin.bodyPosition,pin.position].every((point,i)=>point?.x===g.points[i]?.x&&point?.y===g.points[i]?.y)));
    const bodyPoints=graphics.flatMap(g=>g.points);
    if(!bodyPoints.length)bodyPoints.push(...pins.map(pin=>pin.bodyPosition??pin.position));
    const bodyRight = Math.max(Number(unit.position?.x ?? 0), ...bodyPoints.map(p => Number(p.x)));
    const ys=bodyPoints.map(p=>Number(p.y));
    const centerY=ys.length?(Math.min(...ys)+Math.max(...ys))/2:Number(unit.position?.y??0);
    const right = bodyRight + 3;
    for (const [kind, value, dy] of [["reference", part.reference, -1.25], ["value", part.value, 1.25]] as const) {
      if (!value || value === "?") continue;
      const existing = sch.texts!.find(t => t.symbolUnitId === unit.id && t.kind === kind);
      if (existing) {
        existing.position = pt(right, centerY + dy);existing.rotation = "0";existing.align='start';
      } else sch.texts!.push({ id: `${unit.id}:${kind}`, symbolUnitId: unit.id, text: value, kind, position: pt(right, centerY + dy), rotation: "0", size: "1.5", align: "start" });
    }
  }
  out.schematics.push(sch);
  out.nets.push(...buildConnectivity(sch, sch.pins.map(p => ({ ...p, pin: p.number, x: p.position.x, y: p.position.y })), out.diagnostics));
  out.recognized += records.length; out.normalized += records.length - [...unsupported.values()].reduce((a, b) => a + b, 0);
  out.diagnostics.push(diagnostic("ALTIUM_SCHEMATIC_PARTIAL", `AD 原理图已解析 ${components.size} 个器件、${sch.pins.length} 个引脚、${sch.wires.length} 条导线。未完整绘制的记录（类型:数量）：${[...unsupported].map(([k,v]) => `${k}:${v}`).join(", ") || "无"}。隐藏引脚、跨页连接与电源样式需人工复核。`, "warning", "unsupported", ref, "preserved"));
}

export function parseAltiumNative(bytes: Uint8Array, asset: SourceAsset, out: KicadParseOutput) {
  if (bytes.length > 64 * 1024 * 1024) throw new Error("AD container exceeds 64 MiB limit");
  const container = CFB.read(bytes, { type: "array" });
  const stream = (name: string): Uint8Array => {
    const i = container.FullPaths.findIndex(p => p.toLowerCase().endsWith(`/${name.toLowerCase()}`));
    return i < 0 ? new Uint8Array() : new Uint8Array(container.FileIndex[i].content as Uint8Array);
  };
  if (asset.extension === ".schdoc") schematic(stream("FileHeader"), asset, out);
  else if (asset.extension === ".pcbdoc") pcb(stream, asset, out);
  else throw new Error("Unsupported AD library container");
}

function pcb(stream: (name: string) => Uint8Array, asset: SourceAsset, out: KicadParseOutput) {
  const ref = sourceRef(asset.id, asset.relativePath), id = stableId("pcb", asset.id);
  const props = (name: string) => altiumBlocks(stream(`${name}/Data`)).map(altiumProperties);
  const mil = (s = "0") => Number.parseFloat(s) * (s.toLowerCase().endsWith("mm") ? 1 : .0254);
  const board = props("Board6")[0];
  if (!board) throw new Error("Missing Board6 records");
  const result: PcbIr = { id, documentId: stableId("document", asset.sha256, asset.relativePath), name: withoutExtension(asset.fileName), units: "mm", coordinateSystem: { sourceUnits: "0.0001mil", canonicalUnits: "mm", rotationConvention: "degrees_ccw", precision: "source_token_preserved" }, layers: [], stackup: [], boardOutline: [], footprints: [], pads: [], tracks: [], vias: [], zones: [], sourceRefs: [ref] };
  const layer = (n: number) => n === 1 ? "F.Cu" : n === 32 ? "B.Cu" : n === 74 ? "*.Cu" : `AD.Layer${n}`;
  for (let n = 1; n <= 32; n++) result.layers.push({ id: layer(n), sourceId: String(n), name: layer(n), role: "copper", side: n === 1 ? "front" : n === 32 ? "back" : "inner", copper: true });
  const vertices: IrPoint[] = [];
  for (let n = 0; board[`VX${n}`] !== undefined && n < 10000; n++) {
    vertices.push(pt(mil(board[`VX${n}`]), -mil(board[`VY${n}`])));
    if (board[`KIND${n}`] === "1") {
      const a = num(board, `SA${n}`), sweep = ((num(board, `EA${n}`) - a) % 360 + 360) % 360;
      for (let k = 1; k < 24; k++) { const t = (a + sweep * k / 24) * Math.PI / 180; vertices.push(pt(mil(board[`CX${n}`]) + mil(board[`R${n}`]) * Math.cos(t), -mil(board[`CY${n}`]) - mil(board[`R${n}`]) * Math.sin(t))); }
    }
  }
  vertices.forEach((p, i) => result.boardOutline.push({ id: `${id}:edge${i}`, kind: "line", geometry: { start: p, end: vertices[(i + 1) % vertices.length] } }));
  props("Components6").forEach((p, i) => result.footprints.push({ id: `${id}:fp${i}`, reference: p.SOURCEDESIGNATOR || "?", value: p.SOURCELIBREFERENCE || "", libraryIdentifier: p.PATTERN || "", position: pt(mil(p.X), -mil(p.Y)), rotation: String(num(p, "ROTATION")), side: p.LAYER === "BOTTOM" ? "back" : "front", locked: p.LOCKED === "TRUE", padIds: [], sourceRef: { ...sourceRef(asset.id, asset.relativePath), nativeId: `Components6:${i}` } }));
  const nets = props("Nets6").map((p, i) => ({ id: `${id}:net${i}`, domain: "pcb_physical" as const, canonicalName: p.NAME || `Net${i}`, displayNames: [p.NAME || `Net${i}`], endpoints: [] as import("./types").NetEndpoint[], segmentIds: [] as string[], resolution: { method: "explicit" as const, confidence: 1 }, sourceRefs: [ref] }));
  const binary = (name: string, type: number, handler: (blocks: Uint8Array[], i: number) => void) => {
    const bytes = stream(`${name}/Data`), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 0, i = 0;
    while (offset < bytes.length) {
      if (bytes[offset++] !== type || i >= 100000) throw new Error(`Unsupported ${name} record`);
      const blocks: Uint8Array[] = [];
      for (let k = 0; k < (type === 2 ? 6 : 1); k++) {
        if (offset + 4 > bytes.length) throw new Error(`Truncated ${name}`);
        const len = view.getUint32(offset, true) & 0xffffff; offset += 4;
        if (offset + len > bytes.length) throw new Error(`Truncated ${name}`);
        blocks.push(bytes.subarray(offset, offset + len)); offset += len;
      }
      handler(blocks, i++);
    }
  };
  const read = (b: Uint8Array) => { const v = new DataView(b.buffer, b.byteOffset, b.byteLength); return { u: (i: number) => v.getUint16(i, true), d: (i: number) => v.getFloat64(i, true), mm: (i: number) => v.getInt32(i, true) * .00000254, p: (i: number) => pt(v.getInt32(i, true) * .00000254, -v.getInt32(i + 4, true) * .00000254) }; };
  binary("Pads6", 2, (blocks, i) => {
    const b = blocks[4], v = read(b), fp = result.footprints[v.u(7)], net = nets[v.u(3)], pid = `${id}:pad${i}`;
    const hole = v.mm(45), size = { x: String(v.mm(21)), y: String(v.mm(25)), unit: "mm" as const };
    const number = decoder.decode(blocks[0].subarray(1, 1 + blocks[0][0]));
    result.pads.push({ id: pid, footprintId: fp?.id, number, padType: hole > 0 ? b[60] ? "thru_hole" : "np_thru_hole" : "smd", shape: b[49] === 1 ? (size.x === size.y ? "circle" : "oval") : b[49] === 2 ? "rect" : "roundrect", rotation: String(v.d(52)), position: v.p(13), size, drill: hole > 0 ? { x: String(hole), y: String(hole) } : undefined, layers: [layer(b[0])], netId: net?.id, netName: net?.canonicalName, sourceNativeNetId: String(v.u(3)), sourceRef: ref });
    fp?.padIds.push(pid); net?.endpoints.push({ id: `${pid}:ep`, type: "footprint_pad", targetId: pid, identifier: { reference: fp?.reference || "", pad: number }, position: v.p(13) });
  });
  binary("Tracks6", 4, ([b], i) => { const v = read(b), net = nets[v.u(3)], tid = `${id}:track${i}`; result.tracks.push({ id: tid, kind: "segment", start: v.p(13), end: v.p(21), width: String(v.mm(29)), layer: layer(b[0]), netId: net?.id, sourceNativeNetId: String(v.u(3)), sourceRef: ref }); net?.segmentIds.push(tid); });
  binary("Vias6", 3, ([b], i) => { const v = read(b), net = nets[v.u(3)], vid = `${id}:via${i}`; result.vias.push({ id: vid, position: v.p(13), size: String(v.mm(21)), drill: String(v.mm(25)), layers: ["F.Cu", "B.Cu"], netId: net?.id, sourceRef: ref }); net?.endpoints.push({ id: `${vid}:ep`, type: "via", targetId: vid, identifier: {}, position: v.p(13) }); });
  const usedLayers = new Set([...result.pads.flatMap(p => p.layers), ...result.tracks.map(t => t.layer)]);
  result.layers = result.layers.filter(l => usedLayers.has(l.name));
  try {
    const models = attachAltiumModels(stream, result);
    out.diagnostics.push(diagnostic("ALTIUM_3D_MODELS", `已关联 ${models.attached} 个 AD 内嵌模型引用；${models.skipped} 条 Body 未关联（外部模型、非封装 Body 或缺少模型）。实际加载状态见 3D 查看器。`, models.skipped ? "warning" : "information", "geometry", ref, "normalized"));
  } catch (error) {
    out.diagnostics.push(diagnostic("ALTIUM_3D_PARTIAL", `3D 模型记录解析失败：${error instanceof Error ? error.message : String(error)}。PCB 几何仍保留。`, "warning", "geometry", ref, "preserved"));
  }
  out.pcbs.push(result); out.nets.push(...nets);
  const normalized = result.pads.length + result.tracks.length + result.footprints.length;
  out.normalized += normalized; out.recognized += normalized;
  out.diagnostics.push(diagnostic("ALTIUM_PCB_PARTIAL", `AD PCB 已解析 ${result.footprints.length} 个封装、${result.pads.length} 个焊盘、${result.tracks.length} 条直线走线和 ${result.vias.length} 个过孔。圆弧板框采用采样近似；覆铜、圆弧走线、特殊焊盘、叠层、盲埋孔范围和规则尚未完整解析。内嵌 STEP 模型按 Body 记录关联，加载结果请查看 3D 页面。`, "warning", "unsupported", ref, "preserved"));
}
