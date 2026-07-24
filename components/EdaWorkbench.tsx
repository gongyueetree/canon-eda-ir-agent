"use client";

import {
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  Box,
  Check,
  ChevronRight,
  CircleGauge,
  CircuitBoard,
  Clock3,
  Code2,
  Database,
  FileCode2,
  FileJson2,
  FolderOpen,
  GitCompareArrows,
  HardDriveUpload,
  Layers3,
  Network,
  PackageCheck,
  Save,
  ShieldCheck,
  Sparkles,
  Waypoints,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createDemoFiles, filesToInputAssets } from "../lib/eda/archive";
import { parseEdaProject } from "../lib/eda/parse";
import type { CanonicalIrBundle, ParseDiagnostic } from "../lib/eda/types";

type ResultTab = "overview" | "inventory" | "schematic" | "pcb" | "parts" | "nets" | "diagnostics" | "json";
type AppView = "workspace" | "history" | "adapters";
type SavedProject = {
  id: string;
  name: string;
  source_format: string;
  updated_at: string;
  summary?: { partInstances?: number; logicalNets?: number };
};

const PARSE_STAGES = [
  "安全摄取",
  "文件清单",
  "格式探测",
  "选择适配器",
  "解析源模型",
  "映射 Canonical IR",
  "解析连通性",
  "跨文档验证",
  "计算 Fidelity",
];

const SUPPORT_MATRIX = [
  { format: "KiCad 5–9+", level: "语义解析", tone: "ready", detail: "Legacy Sch / Project / Sch / PCB / Symbol / Footprint" },
  { format: "EasyEDA 标准版", level: "语义解析", tone: "ready", detail: "JSON / docType 多页 / Sch + PCB Shape" },
  { format: "JLCEDA Pro", level: "部分语义", tone: "partial", detail: "EPro ZIP / Project manifest / ESch + EPCB JSONL" },
  { format: "Altium", level: "仅结构", tone: "planned", detail: "PrjPcb / DsnWrk / OutJob + CFB 原样保留" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatName(format: string): string {
  return format === "easyeda" ? "EasyEDA / JLCEDA" : format === "kicad" ? "KiCad" : format === "altium" ? "Altium" : "Unknown";
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    complete: "完整",
    substantially_complete: "基本完整",
    partial: "部分",
    structure_only: "仅结构",
    unknown: "未知",
  };
  return labels[status] ?? status;
}

function downloadBundle(bundle: CanonicalIrBundle) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${bundle.project.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, "-")}-canonical-ir.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function MetricCard({ label, value, detail, accent }: { label: string; value: string | number; detail: string; accent?: boolean }) {
  return (
    <article className={`metric-card ${accent ? "accent" : ""}`}>
      <div className="metric-label">{label}</div>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

function EmptyState({ onDemo, onUpload }: { onDemo: () => void; onUpload: () => void }) {
  return (
    <section className="empty-hero">
      <div className="eyebrow"><span>Agent 16</span> · deterministic parser</div>
      <h1>把 EDA 工程转成<br /><em>可验证的统一数据。</em></h1>
      <p className="hero-copy">
        安全解析 KiCad、Altium、嘉立创EDA / EasyEDA 工程，输出 Project、Schematic、PCB、Part 与 Net IR，并保留每一条证据和未知对象。
      </p>
      <div className="hero-actions">
        <button className="primary-button" onClick={onUpload}><HardDriveUpload size={18} /> 上传工程</button>
        <button className="ghost-button" onClick={onDemo}><Sparkles size={17} /> 载入演示工程</button>
      </div>
      <div className="trust-line">
        <span><ShieldCheck size={16} /> 浏览器内确定性解析</span>
        <span><X size={15} /> 不执行工程脚本</span>
        <span><X size={15} /> 不把工程发送给模型</span>
      </div>
      <div className="format-strip">
        {SUPPORT_MATRIX.map((item) => (
          <div className="format-mini" key={item.format}>
            <span className={`status-dot ${item.tone}`} />
            <div><strong>{item.format}</strong><small>{item.level}</small></div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function EdaWorkbench() {
  const [view, setView] = useState<AppView>("workspace");
  const [bundle, setBundle] = useState<CanonicalIrBundle | null>(null);
  const [activeTab, setActiveTab] = useState<ResultTab>("overview");
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parseStage, setParseStage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dbConfigured, setDbConfigured] = useState<boolean | null>(null);
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [expandedNetId, setExpandedNetId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const parseRunIdRef = useRef(0);

  const refreshProjects = async () => {
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const data = await response.json();
      setDbConfigured(Boolean(data.configured));
      setSavedProjects(data.projects ?? []);
    } catch {
      setDbConfigured(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { configured?: boolean; projects?: SavedProject[] }) => {
        if (cancelled) return;
        setDbConfigured(Boolean(data.configured));
        setSavedProjects(data.projects ?? []);
      })
      .catch(() => {
        if (!cancelled) setDbConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runParse = async (files: File[]) => {
    const runId = ++parseRunIdRef.current;
    setError(null);
    setBundle(null);
    setIsParsing(true);
    setParseStage(0);
    setView("workspace");
    setActiveTab("overview");
    setSaveState("idle");
    setExpandedNetId(null);
    try {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const intake = await filesToInputAssets(files);
      if (runId !== parseRunIdRef.current) return;
      setParseStage(2);
      await new Promise((resolve) => setTimeout(resolve, 90));
      if (runId !== parseRunIdRef.current) return;
      setParseStage(4);
      const result = await parseEdaProject(intake.assets, intake.diagnostics);
      if (runId !== parseRunIdRef.current) return;
      setParseStage(7);
      await new Promise((resolve) => setTimeout(resolve, 110));
      if (runId !== parseRunIdRef.current) return;
      setBundle(result);
      setParseStage(PARSE_STAGES.length - 1);
    } catch (parseError) {
      if (runId === parseRunIdRef.current) {
        setError(parseError instanceof Error ? parseError.message : "解析失败，请检查工程包。 ");
      }
    } finally {
      if (runId === parseRunIdRef.current) setIsParsing(false);
    }
  };

  const startNewProject = () => {
    parseRunIdRef.current += 1;
    setBundle(null);
    setView("workspace");
    setActiveTab("overview");
    setIsDragging(false);
    setIsParsing(false);
    setParseStage(0);
    setError(null);
    setSaveState("idle");
    setExpandedNetId(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (directoryInputRef.current) directoryInputRef.current.value = "";
  };

  const saveToDatabase = async () => {
    if (!bundle) return;
    setSaveState("saving");
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bundle),
      });
      if (!response.ok) throw new Error((await response.json()).message ?? "保存失败");
      setSaveState("saved");
      await refreshProjects();
    } catch {
      setSaveState("error");
    }
  };

  const openSavedProject = async (id: string) => {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("读取失败");
      const data = await response.json();
      setBundle(data.bundle as CanonicalIrBundle);
      setView("workspace");
      setActiveTab("overview");
      setExpandedNetId(null);
    } catch {
      setError("无法读取数据库中的 IR Bundle。");
    }
  };

  const diagnosticsBySeverity = useMemo(() => {
    if (!bundle) return {} as Record<string, ParseDiagnostic[]>;
    return bundle.diagnostics.reduce<Record<string, ParseDiagnostic[]>>((result, item) => {
      (result[item.severity] ??= []).push(item);
      return result;
    }, {});
  }, [bundle]);

  const netTargetLabels = useMemo(() => {
    const labels = new Map<string, string>();
    if (!bundle) return labels;
    for (const schematic of bundle.schematics) {
      for (const pin of schematic.pins) labels.set(pin.id, `${pin.reference}.${pin.number}${pin.name ? ` (${pin.name})` : ""}`);
      for (const label of schematic.labels) labels.set(label.id, `${label.kind}:${label.name}`);
    }
    for (const pcb of bundle.pcbs) {
      const footprintById = new Map(pcb.footprints.map((footprint) => [footprint.id, footprint]));
      for (const pad of pcb.pads) {
        const reference = footprintById.get(pad.footprintId)?.reference ?? pad.footprintId.slice(-8);
        labels.set(pad.id, `${reference}.Pad ${pad.number || "?"}`);
      }
      for (const track of pcb.tracks) {
        const start = track.start ? `${track.start.x},${track.start.y}` : "?";
        const end = track.end ? `${track.end.x},${track.end.y}` : "?";
        labels.set(track.id, `${track.kind === "arc" ? "Arc" : "Track"} ${start} → ${end} mm`);
      }
      for (const via of pcb.vias) {
        labels.set(via.id, `Via ${via.position ? `${via.position.x},${via.position.y} mm` : via.id.slice(-8)}`);
      }
      for (const zone of pcb.zones) labels.set(zone.id, `Zone ${zone.layers.join(", ") || zone.id.slice(-8)}`);
    }
    return labels;
  }, [bundle]);

  const describeEndpoint = (endpoint: CanonicalIrBundle["nets"][number]["endpoints"][number]) =>
    (endpoint.targetId && netTargetLabels.get(endpoint.targetId)) ||
    endpoint.identifier.reference ||
    endpoint.identifier.name ||
    endpoint.targetId?.slice(-8) ||
    endpoint.type;

  const resultTabs: Array<{ id: ResultTab; label: string; count?: number }> = bundle
    ? [
        { id: "overview", label: "概览" },
        { id: "inventory", label: "源文件", count: bundle.inventory.length },
        { id: "schematic", label: "原理图", count: bundle.schematics.length },
        { id: "pcb", label: "PCB", count: bundle.pcbs.length },
        { id: "parts", label: "器件", count: bundle.parts.length },
        { id: "nets", label: "网络", count: bundle.nets.length },
        { id: "diagnostics", label: "诊断", count: bundle.diagnostics.length },
        { id: "json", label: "IR JSON" },
      ]
    : [];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark"><span><Waypoints size={19} /></span><div>CANON<small>EDA IR AGENT</small></div></div>
        <nav className="main-nav" aria-label="主导航">
          <button className={view === "workspace" ? "active" : ""} onClick={() => setView("workspace")}><CircleGauge size={18} /><span>解析工作台</span></button>
          <button className={view === "history" ? "active" : ""} onClick={() => setView("history")}><Clock3 size={18} /><span>工程记录</span>{savedProjects.length > 0 && <b>{savedProjects.length}</b>}</button>
          <button className={view === "adapters" ? "active" : ""} onClick={() => setView("adapters")}><Code2 size={18} /><span>适配器能力</span></button>
        </nav>
        <div className="nav-caption">IR DOMAINS</div>
        <div className="domain-list">
          <div><FileJson2 size={16} />Project IR</div>
          <div><Zap size={16} />Schematic IR</div>
          <div><CircuitBoard size={16} />PCB IR</div>
          <div><PackageCheck size={16} />Part IR</div>
          <div><Network size={16} />Net IR</div>
        </div>
        <div className="sidebar-footer">
          <div className={`db-state ${dbConfigured ? "online" : ""}`}><Database size={15} /><span>{dbConfigured ? "PostgreSQL 已连接" : "本地只读模式"}</span></div>
          <small>Parser 1.0.0-mvp · IR 1.0.0</small>
        </div>
      </aside>

      <main className="main-stage">
        <header className="topbar">
          <div className="breadcrumb"><span>ezPLM</span><ChevronRight size={14} /><strong>{view === "workspace" ? bundle?.project.name ?? "新建解析" : view === "history" ? "工程记录" : "适配器能力"}</strong></div>
          <div className="top-actions">
            {bundle && view === "workspace" && (
              <>
                <button className="icon-text-button" onClick={() => downloadBundle(bundle)}><ArrowDownToLine size={16} /> 导出 JSON</button>
                <button className="save-button" onClick={saveToDatabase} disabled={!dbConfigured || saveState === "saving"} title={!dbConfigured ? "设置 DATABASE_URL 后可用" : "保存当前 IR Bundle"}>
                  {saveState === "saved" ? <Check size={16} /> : <Save size={16} />}
                  {saveState === "saving" ? "保存中" : saveState === "saved" ? "已保存" : "保存 Bundle"}
                </button>
              </>
            )}
            <button className="new-project" onClick={startNewProject}><FolderOpen size={16} /> 新工程</button>
          </div>
        </header>

        <input ref={fileInputRef} type="file" multiple hidden accept=".zip,.pro,.sch,.brd,.lib,.kicad_pro,.kicad_sch,.kicad_pcb,.kicad_sym,.kicad_mod,.PrjPcb,.DsnWrk,.SchDoc,.PcbDoc,.SchLib,.PcbLib,.IntLib,.OutJob,.json,.jsonl,.epro,.eprj,.epru,.esch,.epcb,.esym,.efoo" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) void runParse(files); }} />
        <input ref={directoryInputRef} type="file" multiple hidden {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) void runParse(files); }} />

        <div className="content-area">
          {view === "workspace" && !bundle && !isParsing && (
            <div
              className={`drop-surface ${isDragging ? "dragging" : ""}`}
              onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => { event.preventDefault(); setIsDragging(false); void runParse(Array.from(event.dataTransfer.files)); }}
            >
              <EmptyState onDemo={() => void runParse(createDemoFiles())} onUpload={() => fileInputRef.current?.click()} />
              <div className="drop-hint"><Archive size={19} /><span>拖入 ZIP、工程文件或</span><button onClick={() => directoryInputRef.current?.click()}>选择工程目录</button><small>单文件 50 MB · 解压后 200 MB · 不支持嵌套执行</small></div>
              {error && <div className="inline-error"><AlertTriangle size={17} />{error}</div>}
            </div>
          )}

          {view === "workspace" && isParsing && (
            <section className="parsing-state">
              <div className="parse-orbit"><CircuitBoard size={42} /><span /></div>
              <div className="eyebrow">DETERMINISTIC PIPELINE</div>
              <h2>正在构建 Canonical IR</h2>
              <p>{PARSE_STAGES[parseStage]}</p>
              <div className="stage-track">
                {PARSE_STAGES.map((stage, index) => <div key={stage} className={index <= parseStage ? "done" : ""}><span>{index < parseStage ? <Check size={12} /> : index + 1}</span><small>{stage}</small></div>)}
              </div>
            </section>
          )}

          {view === "workspace" && bundle && (
            <section className="result-workspace">
              <div className="project-heading">
                <div>
                  <div className="eyebrow"><span className={`format-badge ${bundle.project.sourceFormat}`}>{formatName(bundle.project.sourceFormat)}</span> · {bundle.parser.adapterId}</div>
                  <h1>{bundle.project.name}</h1>
                  <p>{bundle.inventory.length} 个源文件 · Bundle <code>{bundle.bundleId}</code> · 只读 IR</p>
                </div>
                <div className={`fidelity-seal ${bundle.fidelity.overallStatus}`}><CircleGauge size={21} /><div><small>FIDELITY</small><strong>{statusLabel(bundle.fidelity.overallStatus)}</strong></div></div>
              </div>

              <div className="result-tabs" role="tablist">
                {resultTabs.map((tab) => <button role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)} key={tab.id}>{tab.label}{tab.count !== undefined && <span>{tab.count}</span>}</button>)}
              </div>

              <div className="tab-content">
                {activeTab === "overview" && (
                  <>
                    <div className="metrics-grid">
                      <MetricCard label="Part instances" value={bundle.summary.partInstances} detail={`${bundle.summary.footprints} 个已放置 Footprints`} accent />
                      <MetricCard label="Logical nets" value={bundle.summary.logicalNets} detail={`${bundle.summary.pcbNets} 个 PCB Physical Nets`} />
                      <MetricCard label="Source map" value={bundle.sourceMap.length} detail="Canonical → Source 证据" />
                      <MetricCard label="Diagnostics" value={bundle.summary.warnings + bundle.summary.errors} detail={`${bundle.summary.errors} errors · ${bundle.summary.warnings} warnings`} />
                    </div>
                    <div className="overview-grid">
                      <article className="panel fidelity-panel">
                        <div className="panel-title"><div><CircleGauge size={18} /><strong>解析完整度</strong></div><span>不以单一百分比掩盖缺口</span></div>
                        <div className="fidelity-list">
                          {Object.entries(bundle.fidelity.dimensions).map(([name, dimension]) => (
                            <div key={name}><div><strong>{name}</strong><span className={`dimension-status ${dimension.status}`}>{statusLabel(dimension.status)}</span></div><p>{dimension.note}</p><small>{dimension.recognized} recognized · {dimension.normalized} normalized · {dimension.opaque} opaque</small></div>
                          ))}
                        </div>
                      </article>
                      <article className="panel pipeline-panel">
                        <div className="panel-title"><div><Waypoints size={18} /><strong>证据管线</strong></div><span>Parser replay ready</span></div>
                        <div className="pipeline-visual">
                          {["Raw source", "Source model", "Canonical IR", bundle.summary.errors > 0 ? "Bundle with errors" : bundle.fidelity.overallStatus === "structure_only" ? "Structure-only bundle" : "Validated bundle"].map((item, index) => <div key={item}><span>{index + 1}</span><strong>{item}</strong>{index < 3 && <ChevronRight size={15} />}</div>)}
                        </div>
                        <div className="safety-card"><ShieldCheck size={21} /><div><strong>解析边界已执行</strong><p>不修改源文件 · 不执行宏/插件 · Unknown Record 原样计入 Fidelity</p></div></div>
                      </article>
                    </div>
                    {bundle.diagnostics.length > 0 && (
                      <article className="panel diagnostics-preview">
                        <div className="panel-title"><div><AlertTriangle size={18} /><strong>需要关注</strong></div><button onClick={() => setActiveTab("diagnostics")}>查看全部 <ChevronRight size={14} /></button></div>
                        {bundle.diagnostics.slice(0, 4).map((item) => <div className={`diagnostic-row ${item.severity}`} key={item.id}><span>{item.severity === "error" ? "E" : item.severity === "warning" ? "W" : "i"}</span><div><strong>{item.code}</strong><p>{item.message}</p></div></div>)}
                      </article>
                    )}
                  </>
                )}

                {activeTab === "inventory" && (
                  <article className="panel table-panel">
                    <div className="panel-title"><div><FolderOpen size={18} /><strong>Source Asset Inventory</strong></div><span>SHA-256 内容寻址</span></div>
                    <div className="data-table"><table><thead><tr><th>文件</th><th>角色</th><th>检测格式</th><th>大小</th><th>SHA-256</th><th>安全状态</th></tr></thead><tbody>{bundle.inventory.map((asset) => <tr key={asset.id}><td><FileCode2 size={15} /><strong>{asset.relativePath}</strong></td><td>{asset.entryRole}</td><td>{formatName(asset.detectedFormat)}</td><td>{formatBytes(asset.sizeBytes)}</td><td><code>{asset.sha256.slice(0, 12)}…</code></td><td><span className="accepted"><Check size={12} /> accepted</span></td></tr>)}</tbody></table></div>
                  </article>
                )}

                {activeTab === "schematic" && (
                  <div className="object-grid">
                    {bundle.schematics.map((schematic) => <article className="panel object-card" key={schematic.id}><div className="object-icon schematic"><Zap size={21} /></div><div><small>SCHEMATIC IR</small><h3>{schematic.name}</h3><p>{schematic.sheets.length} sheets · {schematic.symbolInstanceIds.length} symbol units</p></div><div className="object-stats"><span><b>{schematic.wires.length}</b> wires</span><span><b>{schematic.junctions.length}</b> junctions</span><span><b>{schematic.labels.length}</b> labels</span></div></article>)}
                    {bundle.schematics.length === 0 && <div className="empty-panel"><Zap size={34} /><h3>没有规范化的 Schematic IR</h3><p>源文件可能不含原理图，或当前适配器只提供结构级摄取。</p></div>}
                  </div>
                )}

                {activeTab === "pcb" && (
                  <div className="object-grid">
                    {bundle.pcbs.map((pcb) => (
                      <article className="panel pcb-card" key={pcb.id}>
                        <div className="pcb-card-head"><div className="object-icon pcb"><CircuitBoard size={21} /></div><div><small>PCB IR · mm</small><h3>{pcb.name}</h3></div><span>{pcb.layers.filter((layer) => layer.copper).length} copper layers</span></div>
                        {pcb.physicalDimensions && (
                          <div className="pcb-dimensions">
                            <div><small>BOARD SIZE</small><strong>{pcb.physicalDimensions.width} × {pcb.physicalDimensions.height} mm</strong></div>
                            <div><small>THICKNESS</small><strong>{pcb.physicalDimensions.thickness ? `${pcb.physicalDimensions.thickness} mm` : "未声明"}</strong></div>
                            <div><small>BOUNDING BOX</small><strong>X {pcb.physicalDimensions.boundingBox.minX}–{pcb.physicalDimensions.boundingBox.maxX} · Y {pcb.physicalDimensions.boundingBox.minY}–{pcb.physicalDimensions.boundingBox.maxY}</strong></div>
                            <div><small>OUTLINE</small><strong>{pcb.physicalDimensions.outlineClosed ? "闭合" : "开放 / 部分"}</strong></div>
                          </div>
                        )}
                        <div className="pcb-stats"><span><b>{pcb.footprints.length}</b>Footprints</span><span><b>{pcb.pads.length}</b>Pads</span><span><b>{pcb.tracks.length}</b>Tracks</span><span><b>{pcb.vias.length}</b>Vias</span><span><b>{pcb.zones.length}</b>Zones</span><span><b>{pcb.boardOutline.length}</b>Outline objects</span></div>
                        <div className="layer-chips">{pcb.layers.slice(0, 12).map((layer) => <span className={layer.copper ? "copper" : ""} key={layer.id}>{layer.name}</span>)}</div>
                      </article>
                    ))}
                    {bundle.pcbs.length === 0 && <div className="empty-panel"><CircuitBoard size={34} /><h3>没有规范化的 PCB IR</h3><p>专有 PCB 容器会保留 Hash 和诊断，但不会猜测 Pad、Track 或 Net。</p></div>}
                  </div>
                )}

                {activeTab === "parts" && (
                  <article className="panel table-panel">
                    <div className="panel-title"><div><PackageCheck size={18} /><strong>Part IR</strong></div><span>Symbol / Part / Footprint identity separated</span></div>
                    <div className="data-table"><table><thead><tr><th>RefDes</th><th>Value</th><th>Symbol units</th><th>Footprint</th><th>Variant</th><th>Pin ↔ Pad</th><th>Source</th></tr></thead><tbody>{bundle.parts.map((part) => <tr key={part.id}><td><strong className="refdes">{part.reference}</strong></td><td>{part.value || "—"}</td><td>{part.symbolUnits.map((unit) => unit.unit).join(", ")}</td><td>{part.footprint ?? <span className="muted">unresolved</span>}</td><td><span className={`variant ${part.variantStatus}`}>{part.variantStatus}</span></td><td>{part.pinPadMap.filter((item) => item.status === "verified").length}/{part.pinPadMap.length || "—"}</td><td><code>{part.sourceRefs[0]?.nativeId?.slice(0, 8) ?? part.sourceRefs[0]?.path}</code></td></tr>)}</tbody></table></div>
                  </article>
                )}

                {activeTab === "nets" && (
                  <article className="panel table-panel">
                    <div className="panel-title"><div><Network size={18} /><strong>Net IR</strong></div><span>Logical 与 Physical 分域保存</span></div>
                    <div className="net-summary"><span><i className="logical" /> {bundle.summary.logicalNets} Schematic logical</span><span><i className="physical" /> {bundle.summary.pcbNets} PCB physical</span><span><GitCompareArrows size={15} /> {bundle.crossDocumentLinks.filter((link) => link.type === "schematic_net_to_pcb_net" && link.status === "verified").length} verified cross-links</span></div>
                    <div className="data-table"><table><thead><tr><th>网络名称</th><th>Domain</th><th>Endpoints</th><th>Segments</th><th>Resolution</th><th>Confidence</th></tr></thead><tbody>
                      {bundle.nets.flatMap((net) => {
                        const expanded = expandedNetId === net.id;
                        const relatedLinks = bundle.crossDocumentLinks.filter((link) => link.sourceEntityId === net.id || link.targetEntityId === net.id);
                        return [
                          <tr className="net-row" key={net.id}>
                            <td><button className="net-expand" aria-expanded={expanded} onClick={() => setExpandedNetId(expanded ? null : net.id)}><ChevronRight size={13} /><strong>{net.canonicalName}</strong></button></td>
                            <td><span className={`net-domain ${net.domain}`}>{net.domain}</span></td><td>{net.endpoints.length}</td><td>{net.segmentIds.length}</td><td>{net.resolution.method}</td><td>{Math.round(net.resolution.confidence * 100)}%</td>
                          </tr>,
                          expanded ? (
                            <tr className="net-detail-row" key={`${net.id}:details`}>
                              <td colSpan={6}>
                                <div className="net-detail">
                                  <div className="net-detail-heading"><strong>具体连接关系</strong><code>{net.id}</code></div>
                                  <div className="endpoint-list">
                                    {net.endpoints.map((endpoint) => (
                                      <span className={`endpoint-chip ${endpoint.type}`} key={endpoint.id}>
                                        <small>{endpoint.type}</small>
                                        <b>{describeEndpoint(endpoint)}</b>
                                        {endpoint.targetId && <code>{endpoint.targetId}</code>}
                                      </span>
                                    ))}
                                    {net.endpoints.length === 0 && <span className="muted">该网络当前没有已解析端点。</span>}
                                  </div>
                                  {relatedLinks.length > 0 && (
                                    <div className="cross-link-list">
                                      <strong>跨文档链接</strong>
                                      {relatedLinks.map((link) => <span key={link.id}>{link.type} · {link.status} · {link.evidence.join(" / ")}</span>)}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ) : null,
                        ];
                      })}
                    </tbody></table></div>
                  </article>
                )}

                {activeTab === "diagnostics" && (
                  <article className="panel diagnostics-panel">
                    <div className="panel-title"><div><AlertTriangle size={18} /><strong>Parse Diagnostics</strong></div><div className="diagnostic-counts"><span className="error">{diagnosticsBySeverity.error?.length ?? 0} errors</span><span className="warning">{diagnosticsBySeverity.warning?.length ?? 0} warnings</span><span>{diagnosticsBySeverity.information?.length ?? 0} info</span></div></div>
                    {bundle.diagnostics.map((item) => <div className={`diagnostic-row expanded ${item.severity}`} key={item.id}><span>{item.severity === "error" ? "E" : item.severity === "warning" ? "W" : "i"}</span><div><div><strong>{item.code}</strong><small>{item.category} · {item.preservationStatus}</small></div><p>{item.message}</p>{item.sourceRef && <code>{item.sourceRef.path}{item.sourceRef.line ? `:${item.sourceRef.line}` : ""}</code>}</div></div>)}
                    {bundle.diagnostics.length === 0 && <div className="empty-panel compact"><Check size={28} /><h3>没有解析诊断</h3></div>}
                  </article>
                )}

                {activeTab === "json" && (
                  <article className="panel json-panel"><div className="panel-title"><div><Code2 size={18} /><strong>Canonical IR Bundle</strong></div><button onClick={() => downloadBundle(bundle)}><ArrowDownToLine size={14} /> 下载</button></div><pre>{JSON.stringify(bundle, null, 2)}</pre></article>
                )}
              </div>
            </section>
          )}

          {view === "history" && (
            <section className="secondary-view">
              <div className="section-heading"><div className="eyebrow">PERSISTED IR</div><h1>工程记录</h1><p>数据库保存的是规范化 IR 与诊断，不覆盖原始历史 Bundle。</p></div>
              {!dbConfigured ? (
                <div className="setup-card"><Database size={28} /><div><h3>连接 PostgreSQL / Neon</h3><p>在 Vercel 项目中设置 <code>DATABASE_URL</code>，首次访问 API 会创建最小可用的 Project、Parse Job 与 IR Bundle 表。</p></div></div>
              ) : savedProjects.length ? (
                <div className="history-list">{savedProjects.map((project) => <button key={project.id} onClick={() => void openSavedProject(project.id)}><div className={`file-emblem ${project.source_format}`}><CircuitBoard size={20} /></div><div><strong>{project.name}</strong><span>{formatName(project.source_format)} · {project.summary?.partInstances ?? 0} parts · {project.summary?.logicalNets ?? 0} nets</span></div><time>{new Date(project.updated_at).toLocaleString("zh-CN")}</time><ChevronRight size={17} /></button>)}</div>
              ) : <div className="empty-panel"><Database size={34} /><h3>数据库中还没有工程</h3><p>解析一个工程后点击“保存 Bundle”。</p></div>}
            </section>
          )}

          {view === "adapters" && (
            <section className="secondary-view">
              <div className="section-heading"><div className="eyebrow">ADAPTER REGISTRY</div><h1>格式能力矩阵</h1><p>每项能力都按真实实现标注；“安全摄取”不等于“语义完整解析”。</p></div>
              <div className="adapter-grid">{SUPPORT_MATRIX.map((item) => <article className="adapter-card" key={item.format}><div className={`adapter-icon ${item.tone}`}>{item.format.startsWith("KiCad") ? <CircuitBoard size={23} /> : item.format.startsWith("Altium") ? <Layers3 size={23} /> : <Box size={23} />}</div><div><div className="adapter-title"><h3>{item.format}</h3><span className={item.tone}>{item.level}</span></div><p>{item.detail}</p></div><ul>{item.format.startsWith("KiCad") ? <><li><Check size={13} /> S-expression lexer + AST + Source Span</li><li><Check size={13} /> Deterministic junction connectivity</li><li><Check size={13} /> PCB explicit Net assignment</li></> : item.format.startsWith("Altium") ? <><li><Check size={13} /> PrjPcb / DsnWrk / OutJob configuration</li><li><Check size={13} /> CFB signature and bounds intake</li><li className="pending"><Clock3 size={13} /> Proprietary Record semantic mapper</li></> : item.format.startsWith("JLC") ? <><li><Check size={13} /> EPro ZIP + Project manifest</li><li><Check size={13} /> ESch / EPCB record mapping</li><li className="pending"><Clock3 size={13} /> SQLite private-table semantic mapper</li></> : <><li><Check size={13} /> docType 1 / 3 / 5 routing</li><li><Check size={13} /> Schematic and PCB Shape mapping</li><li className="pending"><Clock3 size={13} /> Rare Shape semantic coverage</li></>}</ul></article>)}</div>
              <article className="panel principles"><div className="panel-title"><div><ShieldCheck size={18} /><strong>不可突破的解析纪律</strong></div></div><div>{["Wire 几何对象不等于 Net", "Cross without Junction 不连接", "同名 Net 不自动跨文档合并", "Unknown Token / Record / Shape 必须保留", "V1 只读，不无损写回", "核心解析与连通性不使用 LLM"].map((item) => <span key={item}><Check size={14} />{item}</span>)}</div></article>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
