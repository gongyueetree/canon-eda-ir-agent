"use client";

import {
  Box,
  ChevronLeft,
  ChevronRight,
  CircuitBoard,
  Download,
  Eye,
  EyeOff,
  Layers3,
  RotateCcw,
  Search,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { CanonicalIrBundle, IrPoint, PartIr, PcbIr } from "../lib/eda/types";

type NumericPoint = { x: number; y: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

const VIEW_WIDTH = 1200;
const VIEW_HEIGHT = 720;
const VIEW_PADDING = 52;

function numericPoint(value?: IrPoint): NumericPoint | undefined {
  if (!value) return undefined;
  const x = Number(value.x);
  const y = Number(value.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function boundsOf(points: Array<NumericPoint | undefined>): Bounds | undefined {
  const valid = points.filter((value): value is NumericPoint => Boolean(value));
  if (!valid.length) return undefined;
  const xs = valid.map((value) => value.x);
  const ys = valid.map((value) => value.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  return { minX: minX - width * 0.04, minY: minY - height * 0.04, maxX: maxX + width * 0.04, maxY: maxY + height * 0.04 };
}

function projector(bounds: Bounds, zoom: number) {
  const width = Math.max(bounds.maxX - bounds.minX, 1);
  const height = Math.max(bounds.maxY - bounds.minY, 1);
  const scale = Math.min((VIEW_WIDTH - VIEW_PADDING * 2) / width, (VIEW_HEIGHT - VIEW_PADDING * 2) / height) * zoom;
  const contentWidth = width * scale;
  const contentHeight = height * scale;
  const offsetX = (VIEW_WIDTH - contentWidth) / 2;
  const offsetY = (VIEW_HEIGHT - contentHeight) / 2;
  return (value: NumericPoint) => ({
    x: offsetX + (value.x - bounds.minX) * scale,
    y: offsetY + (value.y - bounds.minY) * scale,
  });
}

function zoomLabel(zoom: number) {
  return `${Math.round(zoom * 100)}%`;
}

function EmptyViewer({ kind, format }: { kind: string; format: string }) {
  const altium = format === "altium";
  return (
    <div className="eda-viewer-empty">
      <CircuitBoard size={42} />
      <h3>没有可显示的{kind}几何</h3>
      <p>{altium ? "该 Altium 文件是专有二进制 CFB 文档，当前只完成安全摄取，尚未产生可视几何。请从 Altium 导出 IPC-2581、ODB++、Gerber/钻孔、BOM 与 Netlist，或等待完整 CFB Record Adapter。" : "工程中未包含对应文档，或适配器尚未规范化该类几何对象。源文件与诊断仍被保留。"}</p>
    </div>
  );
}

function ViewerToolbar({
  label,
  zoom,
  onZoom,
  children,
}: {
  label: string;
  zoom: number;
  onZoom: (next: number) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="viewer-toolbar">
      <div><Eye size={15} /><strong>{label}</strong></div>
      <div className="viewer-tools">
        {children}
        <button type="button" aria-label="缩小" onClick={() => onZoom(Math.max(0.55, zoom - 0.15))}><ZoomOut size={14} /></button>
        <span>{zoomLabel(zoom)}</span>
        <button type="button" aria-label="放大" onClick={() => onZoom(Math.min(2.2, zoom + 0.15))}><ZoomIn size={14} /></button>
        <button type="button" onClick={() => onZoom(1)}><RotateCcw size={13} /> 适合窗口</button>
      </div>
    </div>
  );
}

export function SchematicViewer({ bundle }: { bundle: CanonicalIrBundle }) {
  const [documentIndex, setDocumentIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [selectedNetId, setSelectedNetId] = useState<string | null>(null);
  const schematic = bundle.schematics[Math.min(documentIndex, Math.max(bundle.schematics.length - 1, 0))];
  const partsById = useMemo(() => new Map(bundle.parts.map((part) => [part.id, part])), [bundle.parts]);

  const geometry = useMemo(() => {
    if (!schematic) return undefined;
    const points = [
      ...schematic.wires.flatMap((wire) => wire.points.map(numericPoint)),
      ...schematic.pins.map((pin) => numericPoint(pin.position)),
      ...schematic.labels.map((label) => numericPoint(label.position)),
      ...schematic.junctions.map((junction) => numericPoint(junction.position)),
    ];
    const bounds = boundsOf(points);
    if (!bounds) return undefined;
    const project = projector(bounds, zoom);
    const wireNet = new Map<string, string>();
    for (const net of bundle.nets.filter((net) => net.domain === "schematic_logical")) {
      for (const segmentId of net.segmentIds) wireNet.set(segmentId, net.id);
    }
    return { bounds, project, wireNet };
  }, [bundle.nets, schematic, zoom]);

  if (!schematic || !geometry) return <EmptyViewer kind="原理图" format={bundle.project.sourceFormat} />;
  const documentNets = bundle.nets.filter((net) => net.domain === "schematic_logical" && net.sourceRefs.some((ref) => schematic.sourceRefs.some((source) => source.path === ref.path)));

  return (
    <article className="panel eda-viewer-panel">
      <ViewerToolbar label={`Schematic · ${schematic.name}`} zoom={zoom} onZoom={setZoom}>
        {bundle.schematics.length > 1 && (
          <select aria-label="选择原理图文档" value={documentIndex} onChange={(event) => { setDocumentIndex(Number(event.target.value)); setSelectedNetId(null); }}>
            {bundle.schematics.map((item, index) => <option value={index} key={item.id}>{item.name}</option>)}
          </select>
        )}
      </ViewerToolbar>
      <div className="viewer-body">
        <div className="viewer-canvas schematic-canvas">
          <svg role="img" aria-label={`${schematic.name} 原理图在线预览`} viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}>
            <defs>
              <pattern id={`schematic-grid-${documentIndex}`} width="24" height="24" patternUnits="userSpaceOnUse"><path d="M 24 0 L 0 0 0 24" fill="none" stroke="#dce6df" strokeWidth="1" /></pattern>
            </defs>
            <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={`url(#schematic-grid-${documentIndex})`} />
            {schematic.wires.map((wire) => {
              const points = wire.points.map(numericPoint).filter((value): value is NumericPoint => Boolean(value)).map(geometry.project);
              const netId = geometry.wireNet.get(wire.id);
              const dimmed = selectedNetId && netId !== selectedNetId;
              return points.length >= 2 ? <polyline className={`schematic-wire ${dimmed ? "dimmed" : ""} ${netId === selectedNetId ? "selected" : ""}`} points={points.map((point) => `${point.x},${point.y}`).join(" ")} key={wire.id} /> : null;
            })}
            {Array.from(new Set(schematic.pins.map((pin) => pin.symbolUnitId))).map((unitId) => {
              const pins = schematic.pins.filter((pin) => pin.symbolUnitId === unitId);
              const positions = pins.map((pin) => numericPoint(pin.position)).filter((value): value is NumericPoint => Boolean(value));
              if (!positions.length) return null;
              const xs = positions.map((point) => geometry.project(point).x);
              const ys = positions.map((point) => geometry.project(point).y);
              const minX = Math.min(...xs) - 20;
              const minY = Math.min(...ys) - 15;
              const width = Math.max(Math.max(...xs) - Math.min(...xs) + 40, 54);
              const height = Math.max(Math.max(...ys) - Math.min(...ys) + 30, 34);
              const part = partsById.get(pins[0].partId);
              return <g className="schematic-symbol" key={unitId}><rect x={minX} y={minY} width={width} height={height} rx="3" /><text x={minX + 7} y={minY + 14}>{part?.reference ?? pins[0].reference}</text><text className="symbol-value" x={minX + 7} y={minY + 27}>{part?.value ?? ""}</text></g>;
            })}
            {schematic.pins.map((pin) => { const p = geometry.project(numericPoint(pin.position)!); return <g className="schematic-pin" key={pin.id}><circle cx={p.x} cy={p.y} r="3.4" /><text x={p.x + 5} y={p.y - 5}>{pin.number}</text></g>; })}
            {schematic.junctions.map((junction) => { const p = geometry.project(numericPoint(junction.position)!); return <circle className="schematic-junction" cx={p.x} cy={p.y} r="4.5" key={junction.id} />; })}
            {schematic.labels.map((label) => { const p = geometry.project(numericPoint(label.position)!); return <g className={`schematic-label ${label.kind}`} key={label.id}><path d={`M ${p.x} ${p.y} h 10`} /><text x={p.x + 13} y={p.y + 4}>{label.name}</text></g>; })}
          </svg>
        </div>
        <aside className="viewer-inspector">
          <div className="inspector-title"><Layers3 size={15} /><strong>网络导航</strong><span>{documentNets.length}</span></div>
          <button type="button" className={!selectedNetId ? "active" : ""} onClick={() => setSelectedNetId(null)}>显示全部网络</button>
          {documentNets.slice(0, 160).map((net) => <button type="button" className={selectedNetId === net.id ? "active" : ""} title={net.canonicalName} onClick={() => setSelectedNetId(net.id)} key={net.id}><i /><span>{net.canonicalName}</span><b>{net.endpoints.length}</b></button>)}
        </aside>
      </div>
      <div className="viewer-status"><span>{schematic.symbolInstanceIds.length} symbols</span><span>{schematic.wires.length} wires</span><span>{schematic.labels.length} labels</span><span>{schematic.junctions.length} junctions</span><strong>Canonical geometry · source coordinates preserved</strong></div>
    </article>
  );
}

function pcbBounds(pcb: PcbIr): Bounds | undefined {
  if (pcb.physicalDimensions) {
    const box = pcb.physicalDimensions.boundingBox;
    return { minX: Number(box.minX), minY: Number(box.minY), maxX: Number(box.maxX), maxY: Number(box.maxY) };
  }
  const geometryPoints = pcb.boardOutline.flatMap((item) => ["start", "mid", "end", "center"].map((key) => numericPoint(item.geometry[key] as IrPoint | undefined)));
  return boundsOf([
    ...geometryPoints,
    ...pcb.footprints.map((item) => numericPoint(item.position)),
    ...pcb.pads.map((item) => numericPoint(item.position)),
    ...pcb.tracks.flatMap((item) => [numericPoint(item.start), numericPoint(item.mid), numericPoint(item.end)]),
    ...pcb.vias.map((item) => numericPoint(item.position)),
  ]);
}

function layerColor(layer = "") {
  if (/^F\.|top/i.test(layer)) return "#d94d45";
  if (/^B\.|bottom/i.test(layer)) return "#3978c7";
  if (/inner|in\d+\.cu/i.test(layer)) return "#c69a32";
  return "#7d8d84";
}

function outlineElement(item: PcbIr["boardOutline"][number], project: (point: NumericPoint) => NumericPoint) {
  const start = numericPoint(item.geometry.start as IrPoint | undefined);
  const end = numericPoint(item.geometry.end as IrPoint | undefined);
  if (item.kind === "line" && start && end) {
    const a = project(start); const b = project(end);
    return <line className="pcb-outline" x1={a.x} y1={a.y} x2={b.x} y2={b.y} key={item.id} />;
  }
  if (item.kind === "rectangle" && start && end) {
    const a = project(start); const b = project(end);
    return <rect className="pcb-outline" x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} key={item.id} />;
  }
  if (item.kind === "circle") {
    const center = numericPoint(item.geometry.center as IrPoint | undefined) ?? start;
    if (center && end) {
      const c = project(center); const e = project(end);
      return <circle className="pcb-outline" cx={c.x} cy={c.y} r={Math.hypot(e.x - c.x, e.y - c.y)} key={item.id} />;
    }
  }
  if (item.kind === "arc" && start && end) {
    const a = project(start); const b = project(end);
    const mid = numericPoint(item.geometry.mid as IrPoint | undefined);
    if (mid) { const m = project(mid); return <path className="pcb-outline" d={`M ${a.x} ${a.y} Q ${m.x} ${m.y} ${b.x} ${b.y}`} key={item.id} />; }
    return <path className="pcb-outline" d={`M ${a.x} ${a.y} A ${Math.max(Math.abs(b.x - a.x), 12)} ${Math.max(Math.abs(b.y - a.y), 12)} 0 0 1 ${b.x} ${b.y}`} key={item.id} />;
  }
  return null;
}

export function PcbViewer({ bundle }: { bundle: CanonicalIrBundle }) {
  const [documentIndex, setDocumentIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [selectedNetId, setSelectedNetId] = useState<string | null>(null);
  const pcb = bundle.pcbs[Math.min(documentIndex, Math.max(bundle.pcbs.length - 1, 0))];
  const bounds = pcb ? pcbBounds(pcb) : undefined;
  if (!pcb || !bounds) return <EmptyViewer kind="PCB" format={bundle.project.sourceFormat} />;
  const project = projector(bounds, zoom);
  const footprintById = new Map(pcb.footprints.map((footprint) => [footprint.id, footprint]));
  const isVisible = (layer?: string) => !layer || !hiddenLayers.has(layer);
  const toggleLayer = (layer: string) => setHiddenLayers((current) => { const next = new Set(current); if (next.has(layer)) next.delete(layer); else next.add(layer); return next; });

  return (
    <article className="panel eda-viewer-panel">
      <ViewerToolbar label={`PCB 2D · ${pcb.name}`} zoom={zoom} onZoom={setZoom}>
        {bundle.pcbs.length > 1 && <select aria-label="选择 PCB 文档" value={documentIndex} onChange={(event) => { setDocumentIndex(Number(event.target.value)); setSelectedNetId(null); }}>
          {bundle.pcbs.map((item, index) => <option value={index} key={item.id}>{item.name}</option>)}
        </select>}
      </ViewerToolbar>
      <div className="viewer-body">
        <div className="viewer-canvas pcb-canvas">
          <svg role="img" aria-label={`${pcb.name} PCB 二维在线预览`} viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}>
            <defs><pattern id={`pcb-grid-${documentIndex}`} width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#36574c" /></pattern></defs>
            <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="#10241f" />
            <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={`url(#pcb-grid-${documentIndex})`} opacity=".42" />
            {pcb.boardOutline.map((item) => outlineElement(item, project))}
            {pcb.tracks.filter((track) => isVisible(track.layer)).map((track) => {
              const start = numericPoint(track.start); const end = numericPoint(track.end);
              if (!start || !end) return null;
              const a = project(start); const b = project(end);
              const selected = !selectedNetId || track.netId === selectedNetId;
              return <line className={`pcb-track ${selected ? "" : "dimmed"}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={layerColor(track.layer)} strokeWidth={Math.max(Number(track.width || 0.25) * 2.2 * zoom, 1.3)} key={track.id} />;
            })}
            {pcb.pads.filter((pad) => pad.layers.some(isVisible) || !pad.layers.length).map((pad) => {
              const position = numericPoint(pad.position); if (!position) return null;
              const p = project(position); const sizeX = Math.max(Number(pad.size?.x ?? 1.2) * 3 * zoom, 5); const sizeY = Math.max(Number(pad.size?.y ?? 1.2) * 3 * zoom, 5);
              const selected = !selectedNetId || pad.netId === selectedNetId;
              return <g className={`pcb-pad ${selected ? "" : "dimmed"}`} key={pad.id}><rect x={p.x - sizeX / 2} y={p.y - sizeY / 2} width={sizeX} height={sizeY} rx={/circle|oval/i.test(pad.shape) ? Math.min(sizeX, sizeY) / 2 : 1.5} /><text x={p.x + sizeX / 2 + 2} y={p.y + 3}>{footprintById.get(pad.footprintId)?.reference}.{pad.number}</text></g>;
            })}
            {pcb.vias.map((via) => { const position = numericPoint(via.position); if (!position) return null; const p = project(position); return <g className={`pcb-via ${selectedNetId && via.netId !== selectedNetId ? "dimmed" : ""}`} key={via.id}><circle cx={p.x} cy={p.y} r={Math.max(Number(via.size ?? 0.8) * 2.2 * zoom, 4)} /><circle cx={p.x} cy={p.y} r={Math.max(Number(via.drill ?? 0.35) * 1.5 * zoom, 1.6)} /></g>; })}
            {pcb.footprints.map((footprint) => { const position = numericPoint(footprint.position); if (!position) return null; const p = project(position); return <g className={`pcb-footprint ${footprint.side}`} key={footprint.id}><rect x={p.x - 18} y={p.y - 11} width="36" height="22" rx="2" transform={`rotate(${-Number(footprint.rotation || 0)} ${p.x} ${p.y})`} /><text x={p.x} y={p.y - 15}>{footprint.reference}</text></g>; })}
          </svg>
        </div>
        <aside className="viewer-inspector">
          <div className="inspector-title"><Layers3 size={15} /><strong>图层</strong><span>{pcb.layers.length}</span></div>
          {pcb.layers.slice(0, 32).map((layer) => <button type="button" className={hiddenLayers.has(layer.name) ? "muted-layer" : "active"} onClick={() => toggleLayer(layer.name)} key={layer.id}>{hiddenLayers.has(layer.name) ? <EyeOff size={12} /> : <Eye size={12} />}<span>{layer.name}</span><i style={{ background: layerColor(layer.name) }} /></button>)}
          <div className="inspector-title net-inspector-title"><Layers3 size={15} /><strong>高亮网络</strong></div>
          <select aria-label="高亮 PCB 网络" value={selectedNetId ?? ""} onChange={(event) => setSelectedNetId(event.target.value || null)}><option value="">全部网络</option>{bundle.nets.filter((net) => net.domain === "pcb_physical").map((net) => <option value={net.id} key={net.id}>{net.canonicalName}</option>)}</select>
        </aside>
      </div>
      <div className="viewer-status"><span>{pcb.layers.filter((layer) => layer.copper).length} copper layers</span><span>{pcb.footprints.length} footprints</span><span>{pcb.pads.length} pads</span><span>{pcb.tracks.length} tracks</span><strong>{pcb.physicalDimensions ? `${pcb.physicalDimensions.width} × ${pcb.physicalDimensions.height} × ${pcb.physicalDimensions.thickness ?? "?"} mm` : "尺寸未解析"}</strong></div>
    </article>
  );
}

export function Board3DViewer({ bundle }: { bundle: CanonicalIrBundle }) {
  const [documentIndex, setDocumentIndex] = useState(0);
  const [rotation, setRotation] = useState(-28);
  const [tilt, setTilt] = useState(58);
  const [showParts, setShowParts] = useState(true);
  const pcb = bundle.pcbs[Math.min(documentIndex, Math.max(bundle.pcbs.length - 1, 0))];
  const bounds = pcb ? pcbBounds(pcb) : undefined;
  if (!pcb || !bounds) return <EmptyViewer kind="3D PCB" format={bundle.project.sourceFormat} />;
  const width = Math.max(bounds.maxX - bounds.minX, 1);
  const height = Math.max(bounds.maxY - bounds.minY, 1);
  const aspect = Math.max(0.35, Math.min(2.85, width / height));
  const footprintStyle = (position?: IrPoint) => {
    const point = numericPoint(position); if (!point) return undefined;
    return { left: `${((point.x - bounds.minX) / width) * 100}%`, top: `${((point.y - bounds.minY) / height) * 100}%` };
  };

  return (
    <article className="panel board-3d-panel">
      <div className="viewer-toolbar">
        <div><Box size={15} /><strong>PCB 3D · {pcb.name}</strong><span className="preview-badge">IR 几何预览</span></div>
        <div className="viewer-tools">
          {bundle.pcbs.length > 1 && <select aria-label="选择 3D PCB 文档" value={documentIndex} onChange={(event) => setDocumentIndex(Number(event.target.value))}>{bundle.pcbs.map((item, index) => <option value={index} key={item.id}>{item.name}</option>)}</select>}
          <button type="button" onClick={() => setRotation((value) => value - 15)}><ChevronLeft size={14} /> 旋转</button>
          <button type="button" onClick={() => setRotation((value) => value + 15)}>旋转 <ChevronRight size={14} /></button>
          <button type="button" onClick={() => setShowParts((value) => !value)}>{showParts ? <Eye size={14} /> : <EyeOff size={14} />} 器件</button>
          <button type="button" onClick={() => { setRotation(-28); setTilt(58); }}><RotateCcw size={14} /> 重置</button>
        </div>
      </div>
      <div className="board-3d-stage">
        <div className="board-3d-horizon" />
        <div className="board-3d-scene" style={{ transform: `rotateX(${tilt}deg) rotateZ(${rotation}deg)`, width: aspect >= 1 ? "68%" : `${68 * aspect}%`, aspectRatio: String(aspect) }}>
          <div className="board-3d-edge" />
          <div className="board-3d-surface">
            <div className="board-3d-mask" />
            <div className="board-3d-silk">{pcb.name}<span>CANON IR PREVIEW</span></div>
            {showParts && pcb.footprints.slice(0, 320).map((footprint, index) => {
              const style = footprintStyle(footprint.position); if (!style) return null;
              const isConnector = /conn|usb|header|socket|jack/i.test(`${footprint.libraryIdentifier} ${footprint.value}`);
              const isIc = /qfn|qfp|bga|sop|soic|tssop|package|ic/i.test(`${footprint.libraryIdentifier} ${footprint.value}`);
              return <div className={`board-3d-part ${isConnector ? "connector" : isIc ? "ic" : "passive"} ${footprint.side}`} style={{ ...style, transform: `translate(-50%, -50%) rotate(${-Number(footprint.rotation || 0)}deg) translateZ(${index % 3 + 5}px)` }} title={`${footprint.reference} · ${footprint.value}`} key={footprint.id}><span>{footprint.reference}</span></div>;
            })}
            {pcb.vias.slice(0, 420).map((via) => { const style = footprintStyle(via.position); return style ? <i className="board-3d-via" style={style} key={via.id} /> : null; })}
          </div>
        </div>
        <label className="tilt-control"><span>视角 {tilt}°</span><input type="range" min="28" max="75" value={tilt} onChange={(event) => setTilt(Number(event.target.value))} /></label>
      </div>
      <div className="viewer-status"><span>{pcb.footprints.length} placed parts</span><span>{pcb.vias.length} vias</span><span>{pcb.layers.filter((layer) => layer.copper).length} copper layers</span><strong>基于 PCB IR 的交互式板级预览；未加载 STEP/WRL 实体模型</strong></div>
    </article>
  );
}

type BomRow = {
  key: string;
  quantity: number;
  references: string[];
  value: string;
  footprint: string;
  manufacturer: string;
  mpn: string;
  variant: PartIr["variantStatus"];
};

function csvCell(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadText(text: string, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = fileName; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function BomViewer({ bundle }: { bundle: CanonicalIrBundle }) {
  const [query, setQuery] = useState("");
  const [variant, setVariant] = useState("all");
  const rows = useMemo(() => {
    const groups = new Map<string, BomRow>();
    for (const part of bundle.parts) {
      const key = [part.mpnRaw || "", part.value, part.footprint || "", part.variantStatus].join("|").toLowerCase();
      const row = groups.get(key) ?? { key, quantity: 0, references: [], value: part.value, footprint: part.footprint ?? "", manufacturer: part.manufacturerRaw ?? "", mpn: part.mpnRaw ?? "", variant: part.variantStatus };
      row.quantity += 1; row.references.push(part.reference); groups.set(key, row);
    }
    return Array.from(groups.values()).sort((left, right) => left.references[0].localeCompare(right.references[0], undefined, { numeric: true }));
  }, [bundle.parts]);
  const filtered = rows.filter((row) => (variant === "all" || row.variant === variant) && [row.value, row.footprint, row.manufacturer, row.mpn, row.references.join(" ")].join(" ").toLowerCase().includes(query.toLowerCase()));
  const exportCsv = () => {
    const lines = [["Item", "Qty", "References", "Value", "Footprint", "Manufacturer", "MPN", "Variant"], ...filtered.map((row, index) => [index + 1, row.quantity, row.references.join(" "), row.value, row.footprint, row.manufacturer, row.mpn, row.variant])];
    downloadText(`\ufeff${lines.map((line) => line.map(csvCell).join(",")).join("\n")}`, `${bundle.project.name.replace(/\W+/g, "-")}-bom.csv`, "text/csv;charset=utf-8");
  };

  return (
    <article className="panel table-panel bom-panel">
      <div className="viewer-toolbar"><div><Box size={15} /><strong>BOM · 物料清单</strong><span className="preview-badge">{rows.length} line items · {bundle.parts.length} instances</span></div><div className="viewer-tools"><label className="viewer-search"><Search size={13} /><input aria-label="搜索 BOM" placeholder="RefDes / Value / MPN" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="BOM 装配状态" value={variant} onChange={(event) => setVariant(event.target.value)}><option value="all">全部装配状态</option><option value="fitted">Fitted</option><option value="dnp">DNP</option><option value="optional">Optional</option><option value="variant_excluded">Excluded</option><option value="unknown">Unknown</option></select><button type="button" onClick={exportCsv}><Download size={14} /> 下载 CSV</button></div></div>
      <div className="data-table"><table><thead><tr><th>Item</th><th>Qty</th><th>References</th><th>Value</th><th>Footprint</th><th>Manufacturer</th><th>MPN</th><th>Variant</th></tr></thead><tbody>{filtered.map((row, index) => <tr key={row.key}><td>{index + 1}</td><td><strong>{row.quantity}</strong></td><td><strong className="refdes bom-refs">{row.references.join(", ")}</strong></td><td>{row.value || "—"}</td><td>{row.footprint || <span className="muted">unresolved</span>}</td><td>{row.manufacturer || "—"}</td><td><code>{row.mpn || "—"}</code></td><td><span className={`variant ${row.variant}`}>{row.variant}</span></td></tr>)}</tbody></table></div>
      {!filtered.length && <div className="table-empty">没有符合条件的 BOM 行。</div>}
    </article>
  );
}

export function NetlistToolbar({ bundle, query, onQuery }: { bundle: CanonicalIrBundle; query: string; onQuery: (value: string) => void }) {
  const exportCsv = () => {
    const lines = [["Domain", "Net", "Endpoint Type", "Reference", "Pin/Pad", "Target ID"], ...bundle.nets.flatMap((net) => net.endpoints.length ? net.endpoints.map((endpoint) => [net.domain, net.canonicalName, endpoint.type, endpoint.identifier.reference ?? endpoint.identifier.name ?? "", endpoint.identifier.pin ?? endpoint.identifier.pad ?? "", endpoint.targetId ?? ""]) : [[net.domain, net.canonicalName, "", "", "", ""]])];
    downloadText(`\ufeff${lines.map((line) => line.map(csvCell).join(",")).join("\n")}`, `${bundle.project.name.replace(/\W+/g, "-")}-netlist.csv`, "text/csv;charset=utf-8");
  };
  return <div className="netlist-tools"><label className="viewer-search"><Search size={13} /><input aria-label="搜索 Netlist" placeholder="网络名 / RefDes / Pin" value={query} onChange={(event) => onQuery(event.target.value)} /></label><button type="button" onClick={exportCsv}><Download size={14} /> 下载 Netlist CSV</button></div>;
}
