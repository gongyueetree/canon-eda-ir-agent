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
  Copy,
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
import { validateMiningInput } from "../lib/knowledge/validate";
import { miningDemoFiles } from "../lib/knowledge/fixtures";
import { BomWorkbench } from "./BomWorkbench";
import { KnowledgeWorkbench } from "./KnowledgeWorkbench";
import { apiFetch, setApiToken } from "../lib/client-api";
import { strToU8, zipSync } from "fflate";
import { useEffect, useMemo, useRef, useState } from "react";
import { createDemoFiles, filesToInputAssets } from "../lib/eda/archive";
import { createIrDomainExport, IR_DOMAIN_KEYS, type IrDomainKey } from "../lib/eda/export";
import { parseEdaProject } from "../lib/eda/parse";
import { prepareAllegroInputs } from "../lib/eda/allegro-client";
import type { CanonicalIrBundle, ParseDiagnostic } from "../lib/eda/types";
import { Board3DViewer, NetlistToolbar, PcbViewer, SchematicViewer } from "./EdaViewers";
import { KeepAlivePanel } from "./KeepAlivePanel";

type ResultTab = "knowledge" | "overview" | "inventory" | "project" | "schematic" | "pcb" | "3d" | "parts" | "nets" | "diagnostics" | "json";
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
  { format: "KiCad 5–9+", level: "在线查看", tone: "ready", detail: "Sch / PCB / 3D IR Preview / BOM / Netlist" },
  { format: "EasyEDA 标准版", level: "在线查看", tone: "ready", detail: "JSON 多页 Sch / PCB / BOM / Netlist" },
  { format: "JLCEDA Pro", level: "在线查看", tone: "partial", detail: "EPro / ESch / EPCB 已映射对象在线显示" },
  { format: "Altium", level: "结构预览", tone: "planned", detail: "PrjPcb 元数据；二进制 CFB 几何适配中" },
  { format: "Allegro PCB", level: "转换导入", tone: "partial", detail: "BRD → KiCad 10+ 转换服务或本地 ZIP；PCB / 派生 BOM / 网表，原理图暂不支持" },
];

const DOMAIN_NAV: Array<{
  domain: IrDomainKey;
  tab: ResultTab;
  label: string;
  description: string;
}> = [
  { domain: "project", tab: "project", label: "Project IR", description: "工程身份、文档图、设置与扩展记录" },
  { domain: "schematic", tab: "schematic", label: "Schematic IR", description: "Sheet、Symbol Pin、Wire、Junction 与 Label" },
  { domain: "pcb", tab: "pcb", label: "PCB IR", description: "Layer、Footprint、Pad、Track、Via、Zone 与板框" },
  { domain: "part", tab: "parts", label: "Part IR", description: "器件身份、变体、封装及 Pin ↔ Pad 映射" },
  { domain: "net", tab: "nets", label: "Net IR", description: "逻辑/物理网络、端点、Segment 与跨文档链接" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatName(format: string): string {
  return format === "easyeda" ? "EasyEDA / JLCEDA" : format === "kicad" ? "KiCad" : format === "altium" ? "Altium" : format === "allegro" ? "Allegro" : "Unknown";
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

function safeProjectName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, "-").replace(/^-+|-+$/g, "") || "eda-project";
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadJson(value: unknown, fileName: string) {
  downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }), fileName);
}

function downloadBundle(bundle: CanonicalIrBundle) {
  downloadJson(bundle, `${safeProjectName(bundle.project.name)}-canonical-ir.json`);
}

function downloadDomain(bundle: CanonicalIrBundle, domain: IrDomainKey) {
  downloadJson(
    createIrDomainExport(bundle, domain),
    `${safeProjectName(bundle.project.name)}-${domain}-ir.json`,
  );
}

function packageReadme(bundle: CanonicalIrBundle): string {
  return `# ${bundle.project.name} · CANON EDA IR

This package contains deterministic, read-only Canonical IR generated from the uploaded EDA project.

## Files

- project-ir.json — project identity, document graph, settings and opaque extensions
- schematic-ir.json — sheets, pins, wires, junctions, labels and no-connects
- pcb-ir.json — board layers, outline, dimensions, footprints, pads, tracks, vias and zones
- part-ir.json — logical parts, variants, footprints and pin-to-pad mappings
- net-ir.json — logical/physical nets, concrete endpoints and cross-document links
- canonical-bundle.json — complete bundle including inventory, diagnostics, fidelity and source map

Every domain file contains metadata plus a \`data\` field. Net IR keeps both \`data.nets\` and
\`data.crossDocumentLinks\` so downstream tools can resolve schematic-to-PCB relationships.

JavaScript:

\`\`\`js
const netIr = await apiFetch("./net-ir.json").then((response) => response.json());
for (const net of netIr.data.nets) {
  console.log(net.canonicalName, net.endpoints);
}
\`\`\`

Python:

\`\`\`python
import json
with open("pcb-ir.json", encoding="utf-8") as file:
    pcb_ir = json.load(file)
print(pcb_ir["data"][0].get("physicalDimensions"))
\`\`\`
`;
}

function downloadIrPackage(bundle: CanonicalIrBundle) {
  const files: Record<string, Uint8Array> = {
    "README.md": strToU8(packageReadme(bundle)),
    "canonical-bundle.json": strToU8(JSON.stringify(bundle, null, 2)),
  };
  for (const domain of IR_DOMAIN_KEYS) {
    files[`${domain}-ir.json`] = strToU8(JSON.stringify(createIrDomainExport(bundle, domain), null, 2));
  }
  const archive = zipSync(files, { level: 6 });
  downloadBlob(
    new Blob([archive.buffer as ArrayBuffer], { type: "application/zip" }),
    `${safeProjectName(bundle.project.name)}-ir-package.zip`,
  );
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("COPY_FAILED");
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
        安全解析 KiCad、Altium、嘉立创EDA / EasyEDA 工程，在线查看原理图、PCB 2D、板级 3D、BOM 与 Netlist，同时输出可追溯的统一 IR。
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
  const [bomMappings,setBomMappings] = useState<Record<string,import("../lib/bom/types").BomMapping>>({});
  const [sourceAssets,setSourceAssets] = useState<import("../lib/eda/types").InputAsset[]>([]);
  const [bundle, setBundle] = useState<CanonicalIrBundle | null>(null);
  const [activeTab, setActiveTab] = useState<ResultTab>("overview");
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parseStage, setParseStage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dbConfigured, setDbConfigured] = useState<boolean | null>(null);
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [persistedProjectId, setPersistedProjectId] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [expandedNetId, setExpandedNetId] = useState<string | null>(null);
  const [netQuery, setNetQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const parseRunIdRef = useRef(0);

  const refreshProjects = async () => {
    try {
      const response = await apiFetch("/api/projects", { cache: "no-store" });
      const data = await response.json();
      setDbConfigured(Boolean(data.configured));
      setSavedProjects(data.projects ?? []);
    } catch {
      setDbConfigured(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/projects", { cache: "no-store" })
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
    setSourceAssets([]);
    setBomMappings({});
    setIsParsing(true);
    setParseStage(0);
    setView("workspace");
    setActiveTab("overview");
    setSaveState("idle");
    setPersistedProjectId(null);
    setCopyFeedback(null);
    setExpandedNetId(null);
    setNetQuery("");
    try {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const intake = await filesToInputAssets(files);
      const allegro = await prepareAllegroInputs(intake.assets, () => runId === parseRunIdRef.current);
      intake.assets = allegro.assets;
      intake.diagnostics.push(...allegro.diagnostics);
      if (runId !== parseRunIdRef.current) return;
      setParseStage(2);
      await new Promise((resolve) => setTimeout(resolve, 90));
      if (runId !== parseRunIdRef.current) return;
      setParseStage(4);
      let imported: CanonicalIrBundle | undefined;
      if (intake.assets.length === 1 && /\.json$/i.test(intake.assets[0].path)) {
        const value = JSON.parse(new TextDecoder().decode(intake.assets[0].bytes));
        if (value?.parser?.agent === "eda-canonical-ir-agent") imported = validateMiningInput(value);
      }
      const result = imported ?? await parseEdaProject(intake.assets, intake.diagnostics);
      if (runId !== parseRunIdRef.current) return;
      setParseStage(7);
      await new Promise((resolve) => setTimeout(resolve, 110));
      if (runId !== parseRunIdRef.current) return;
      setSourceAssets(intake.assets);
      setBomMappings(result.bomMappings ?? {});
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
    setSourceAssets([]);
    setBomMappings({});
    setView("workspace");
    setActiveTab("overview");
    setIsDragging(false);
    setIsParsing(false);
    setParseStage(0);
    setError(null);
    setSaveState("idle");
    setPersistedProjectId(null);
    setCopyFeedback(null);
    setExpandedNetId(null);
    setNetQuery("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (directoryInputRef.current) directoryInputRef.current.value = "";
  };

  const saveToDatabase = async () => {
    if (!bundle) return;
    setSaveState("saving");
    try {
      const response = await apiFetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({...bundle,bomMappings}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "保存失败");
      setSaveState("saved");
      setPersistedProjectId(data.projectId ?? bundle.project.id);
      await refreshProjects();
    } catch {
      setSaveState("error");
    }
  };

  const openSavedProject = async (id: string) => {
    try {
      const response = await apiFetch(`/api/projects/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("读取失败");
      const data = await response.json();
      setSourceAssets([]);
      setBomMappings(data.bundle.bomMappings ?? {});
      setBundle(data.bundle as CanonicalIrBundle);
      setView("workspace");
      setActiveTab("overview");
      setSaveState("saved");
      setPersistedProjectId(id);
      setCopyFeedback(null);
      setExpandedNetId(null);
      setNetQuery("");
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
        const reference = footprintById.get(pad.footprintId ?? "")?.reference ?? (pad.footprintId?.slice(-8) || "Free pad");
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

  const copyValue = async (value: unknown, feedbackKey: string) => {
    try {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      await writeClipboard(text);
      setCopyFeedback(feedbackKey);
      window.setTimeout(() => setCopyFeedback((current) => current === feedbackKey ? null : current), 1800);
    } catch {
      setCopyFeedback("error");
    }
  };

  const copyApiPath = (path: string, feedbackKey: string) =>
    copyValue(new URL(path, window.location.origin).toString(), feedbackKey);

  const openDomain = (tab: ResultTab) => {
    if (!bundle) return;
    setView("workspace");
    setActiveTab(tab);
  };

  const activeDomain = DOMAIN_NAV.find((item) => item.tab === activeTab);
  const persistedApiBase = persistedProjectId ? `/api/projects/${encodeURIComponent(persistedProjectId)}` : null;
  const domainCount = (domain: IrDomainKey) => {
    if (!bundle) return 0;
    if (domain === "project") return 1;
    if (domain === "schematic") return bundle.schematics.length;
    if (domain === "pcb") return bundle.pcbs.length;
    if (domain === "part") return bundle.parts.length;
    return bundle.nets.length;
  };

  const resultTabs: Array<{ id: ResultTab; label: string; count?: number }> = bundle
    ? [
        { id: "overview", label: "概览" },
        { id: "knowledge", label: "知识挖掘 / 审核" },
        { id: "inventory", label: "源文件", count: bundle.inventory.length },
        { id: "project", label: "Project IR", count: 1 },
        { id: "schematic", label: "原理图查看器", count: bundle.schematics.length },
        { id: "pcb", label: "PCB 2D", count: bundle.pcbs.length },
        { id: "3d", label: "3D", count: bundle.pcbs.length },
        { id: "parts", label: "BOM", count: bundle.parts.length },
        { id: "nets", label: "Netlist", count: bundle.nets.length },
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
          {DOMAIN_NAV.map((item) => (
            <button
              type="button"
              className={bundle && view === "workspace" && activeTab === item.tab ? "active" : ""}
              disabled={!bundle}
              aria-label={`打开 ${item.label}`}
              aria-current={bundle && view === "workspace" && activeTab === item.tab ? "page" : undefined}
              title={bundle ? `查看并导出 ${item.label}` : "请先解析或打开一个工程"}
              onClick={() => openDomain(item.tab)}
              key={item.domain}
            >
              {item.domain === "project" ? <FileJson2 size={16} /> : item.domain === "schematic" ? <Zap size={16} /> : item.domain === "pcb" ? <CircuitBoard size={16} /> : item.domain === "part" ? <PackageCheck size={16} /> : <Network size={16} />}
              <span>{item.label}</span>
              {bundle && <b>{domainCount(item.domain)}</b>}
            </button>
          ))}
        </div>
        <div className="nav-caption viewer-caption">ONLINE VIEWERS</div>
        <div className="viewer-nav-list">
          {[
            { tab: "knowledge" as ResultTab, label: "知识挖掘 / 审核", icon: <Sparkles size={16} />, count: undefined },
            { tab: "schematic" as ResultTab, label: "原理图", icon: <Zap size={16} />, count: bundle?.schematics.length },
            { tab: "pcb" as ResultTab, label: "PCB 2D", icon: <CircuitBoard size={16} />, count: bundle?.pcbs.length },
            { tab: "3d" as ResultTab, label: "PCB 3D", icon: <Box size={16} />, count: bundle?.pcbs.length },
            { tab: "parts" as ResultTab, label: "BOM", icon: <PackageCheck size={16} />, count: bundle?.parts.length },
            { tab: "nets" as ResultTab, label: "Netlist", icon: <Network size={16} />, count: bundle?.nets.length },
          ].map((item) => (
            <button type="button" className={bundle && view === "workspace" && activeTab === item.tab ? "active" : ""} disabled={!bundle} onClick={() => openDomain(item.tab)} key={item.tab}>
              {item.icon}<span>{item.label}</span>{bundle && <b>{item.count}</b>}
            </button>
          ))}
        </div>
        <div className="sidebar-footer">
          <div className={`db-state ${dbConfigured ? "online" : ""}`}><Database size={15} /><span>{dbConfigured ? "PostgreSQL 已连接" : "本地只读模式"}</span></div>
          <small>Parser {bundle?.parser.adapterVersion ?? "1.6.0"} · IR 1.0.0</small>
        </div>
      </aside>

      <main className="main-stage">
        <header className="topbar">
          <div className="breadcrumb"><input aria-label="工作区访问密钥" type="password" placeholder="工作区密钥（仅内存保存）" onChange={event => setApiToken(event.target.value)} onBlur={() => void refreshProjects()} style={{maxWidth:240, padding:8, border:"1px solid #ced8d3",borderRadius:6}} /><span>ezPLM</span><ChevronRight size={14} /><strong>{view === "workspace" ? bundle?.project.name ?? "新建解析" : view === "history" ? "工程记录" : "适配器能力"}</strong></div>
          <div className="top-actions">
            {bundle && view === "workspace" && (
              <>
                <button className="icon-text-button" onClick={() => downloadBundle({...bundle,bomMappings})}><ArrowDownToLine size={16} /> 导出 JSON</button>
                <button className="save-button" onClick={saveToDatabase} disabled={!dbConfigured || saveState === "saving"} title={!dbConfigured ? "设置 DATABASE_URL 后可用" : "保存当前 IR Bundle"}>
                  {saveState === "saved" ? <Check size={16} /> : <Save size={16} />}
                  {saveState === "saving" ? "保存中" : saveState === "saved" ? "已保存" : "保存 Bundle"}
                </button>
              </>
            )}
            <button className="new-project" onClick={startNewProject}><FolderOpen size={16} /> 新工程</button>
          </div>
        </header>

        <button className="icon-text-button" style={{margin:"8px 24px"}} onClick={() => void runParse(miningDemoFiles())}>打开知识挖掘合成示例 · AD9837</button>
        <input ref={fileInputRef} type="file" multiple hidden accept=".pdf,.zip,.pro,.sch,.brd,.lib,.kicad_pro,.kicad_sch,.kicad_pcb,.kicad_sym,.kicad_mod,.PrjPcb,.DsnWrk,.SchDoc,.PcbDoc,.SchLib,.PcbLib,.IntLib,.OutJob,.json,.jsonl,.epro,.eprj,.epru,.esch,.epcb,.esym,.efoo" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) void runParse(files); }} />
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

              {String(bundle.parser.adapterVersion) !== "1.6.0" && <p role="status" className="knowledge-note">此工程使用旧版解析结果。请重新导入原始工程文件，使用当前解析器重新处理。</p>}
              <div className="result-tabs" role="tablist">
                {resultTabs.map((tab) => <button role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)} key={tab.id}>{tab.label}{tab.count !== undefined && <span>{tab.count}</span>}</button>)}
              </div>

              <div className="tab-content">
                {activeDomain && (
                  <div className="ir-domain-toolbar">
                    <div>
                      <span>{activeDomain.label}</span>
                      <p>{activeDomain.description}</p>
                    </div>
                    <div>
                      <button type="button" onClick={() => void copyValue(createIrDomainExport(bundle, activeDomain.domain), `domain-${activeDomain.domain}`)}>
                        {copyFeedback === `domain-${activeDomain.domain}` ? <Check size={14} /> : <Copy size={14} />}
                        {copyFeedback === `domain-${activeDomain.domain}` ? "已复制" : "复制 JSON"}
                      </button>
                      <button type="button" className="primary" onClick={() => downloadDomain(bundle, activeDomain.domain)}><ArrowDownToLine size={14} /> 下载 {activeDomain.label}</button>
                    </div>
                  </div>
                )}

                <div hidden={activeTab !== "knowledge"}><KnowledgeWorkbench key={bundle.bundleId} bundle={bundle} /></div>
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
                          {["Raw source", "Source model", "Canonical IR", bundle.summary.errors > 0 ? "部分失败：查看诊断" : bundle.fidelity.overallStatus === "structure_only" ? "Structure-only bundle" : bundle.fidelity.overallStatus === "partial" ? "部分解析：查看缺口" : "Validated bundle"].map((item, index) => <div key={item}><span>{index + 1}</span><strong>{item}</strong>{index < 3 && <ChevronRight size={15} />}</div>)}
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
                    <div className="data-table"><table><thead><tr><th>文件</th><th>角色</th><th>检测格式</th><th>大小</th><th>SHA-256</th><th>安全状态 / IR</th></tr></thead><tbody>{bundle.inventory.map((asset) => <tr key={asset.id}><td><FileCode2 size={15} /><strong>{asset.relativePath}</strong></td><td>{asset.entryRole}</td><td>{formatName(asset.detectedFormat)}</td><td>{formatBytes(asset.sizeBytes)}</td><td><code>{asset.sha256.slice(0, 12)}…</code></td><td><span className="accepted"><Check size={12} /> accepted</span>{asset.irParticipation === "excluded" && <small>未参与 IR</small>}</td></tr>)}</tbody></table></div>
                  </article>
                )}

                {activeTab === "project" && (
                  <div className="project-ir-layout">
                    <article className="panel project-ir-card">
                      <div className="panel-title"><div><FileJson2 size={18} /><strong>Project IR</strong></div><span>Version {bundle.project.projectIrVersion}</span></div>
                      <div className="project-ir-fields">
                        <div><small>PROJECT ID</small><code>{bundle.project.id}</code></div>
                        <div><small>SOURCE FORMAT</small><strong>{formatName(bundle.project.sourceFormat)}</strong></div>
                        <div><small>SOURCE VERSION</small><strong>{bundle.project.sourceFormatVersion ?? "未声明"}</strong></div>
                        <div><small>TOOL VERSION</small><strong>{bundle.project.sourceToolVersion ?? "未声明"}</strong></div>
                      </div>
                    </article>
                    <article className="panel table-panel">
                      <div className="panel-title"><div><GitCompareArrows size={18} /><strong>Document Graph</strong></div><span>{bundle.project.documentGraph.length} documents</span></div>
                      <div className="data-table"><table><thead><tr><th>ID</th><th>Type</th><th>Name</th><th>Relation</th></tr></thead><tbody>{bundle.project.documentGraph.map((document) => <tr key={document.id}><td><code>{document.id}</code></td><td>{document.type}</td><td><strong>{document.name}</strong></td><td>{document.relation}</td></tr>)}</tbody></table></div>
                    </article>
                    <article className="panel project-metadata-card">
                      <div className="panel-title"><div><Code2 size={18} /><strong>Project metadata</strong></div><span>{bundle.project.opaqueExtensions.length} opaque extensions</span></div>
                      <div className="metadata-columns"><div><small>SETTINGS</small><pre>{JSON.stringify(bundle.project.settings, null, 2)}</pre></div><div><small>OPAQUE EXTENSIONS</small><pre>{JSON.stringify(bundle.project.opaqueExtensions, null, 2)}</pre></div></div>
                    </article>
                  </div>
                )}

                {activeTab === "schematic" && (
                  <SchematicViewer bundle={bundle} />
                )}

                {activeTab === "pcb" && (
                  <div className="object-grid">
                    <PcbViewer bundle={bundle} />
                    {bundle.pcbs.map((pcb) => (
                      <article className="panel pcb-card compact-pcb-card" key={pcb.id}>
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
                  </div>
                )}

                <KeepAlivePanel key={bundle.bundleId} active={activeTab === "3d"}><Board3DViewer bundle={bundle} assets={sourceAssets} active={activeTab === "3d"} /></KeepAlivePanel>

                <div hidden={activeTab !== "parts"}><BomWorkbench key={bundle.bundleId} bundle={bundle} mappings={bomMappings} onMapping={(id,m)=>{setBomMappings(previous=>({...previous,[id]:m}));setSaveState("idle");}} /></div>

                {activeTab === "nets" && (
                  <article className="panel table-panel">
                    <div className="panel-title"><div><Network size={18} /><strong>Netlist · 连接关系</strong></div><NetlistToolbar bundle={bundle} query={netQuery} onQuery={setNetQuery} /></div>
                    <div className="net-summary"><span><i className="logical" /> {bundle.summary.logicalNets} Schematic logical</span><span><i className="physical" /> {bundle.summary.pcbNets} PCB physical</span><span><GitCompareArrows size={15} /> {bundle.crossDocumentLinks.filter((link) => link.type === "schematic_net_to_pcb_net" && link.status === "verified").length} verified cross-links</span></div>
                    <div className="data-table"><table><thead><tr><th>网络名称</th><th>Domain</th><th>Endpoints</th><th>Segments</th><th>Resolution</th><th>Confidence</th></tr></thead><tbody>
                      {bundle.nets.filter((net) => !netQuery || [net.canonicalName, ...net.displayNames, ...net.endpoints.flatMap((endpoint) => Object.values(endpoint.identifier))].join(" ").toLowerCase().includes(netQuery.toLowerCase())).flatMap((net) => {
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
                  <div className="export-center">
                    <article className="panel export-hero">
                      <div>
                        <div className="eyebrow">PORTABLE OUTPUT</div>
                        <h2>保存并使用 Canonical IR</h2>
                        <p>下载不依赖数据库。ZIP 包包含五类独立 IR、完整 Bundle 和可直接运行的 JavaScript / Python 读取示例。</p>
                      </div>
                      <div className="export-hero-actions">
                        <button type="button" onClick={() => downloadBundle({...bundle,bomMappings})}><FileJson2 size={16} /> 完整 Bundle JSON</button>
                        <button type="button" className="primary" onClick={() => downloadIrPackage({...bundle,bomMappings})}><Archive size={16} /> 下载 IR 数据包 ZIP</button>
                      </div>
                    </article>

                    <div className="domain-export-grid">
                      {DOMAIN_NAV.map((item) => (
                        <article className="panel domain-export-card" key={item.domain}>
                          <div className={`export-domain-icon ${item.domain}`}>
                            {item.domain === "project" ? <FileJson2 size={19} /> : item.domain === "schematic" ? <Zap size={19} /> : item.domain === "pcb" ? <CircuitBoard size={19} /> : item.domain === "part" ? <PackageCheck size={19} /> : <Network size={19} />}
                          </div>
                          <div><strong>{item.label}</strong><span>{domainCount(item.domain)} entities</span></div>
                          <p>{item.description}</p>
                          <div className="domain-export-actions">
                            <button type="button" onClick={() => void copyValue(createIrDomainExport(bundle, item.domain), `export-${item.domain}`)}>
                              {copyFeedback === `export-${item.domain}` ? <Check size={13} /> : <Copy size={13} />}
                              {copyFeedback === `export-${item.domain}` ? "已复制" : "复制"}
                            </button>
                            <button type="button" onClick={() => downloadDomain(bundle, item.domain)}><ArrowDownToLine size={13} /> JSON</button>
                          </div>
                        </article>
                      ))}
                    </div>

                    <article className="panel api-usage-card">
                      <div className="panel-title"><div><Database size={18} /><strong>数据库与 API 使用</strong></div><span>{persistedApiBase ? "API ready" : "Save required"}</span></div>
                      <div className="api-usage-content">
                        {persistedApiBase ? (
                          <>
                            <p>该 Bundle 已保存。下游程序可读取完整 Bundle，也可通过 <code>domain</code> 参数只读取一种 IR。</p>
                            <div className="api-endpoint-list">
                              <button type="button" onClick={() => void copyApiPath(persistedApiBase, "api-bundle")}><code>GET {persistedApiBase}</code>{copyFeedback === "api-bundle" ? <Check size={13} /> : <Copy size={13} />}</button>
                              {DOMAIN_NAV.map((item) => {
                                const path = `${persistedApiBase}?domain=${item.domain}`;
                                return <button type="button" onClick={() => void copyApiPath(path, `api-${item.domain}`)} key={item.domain}><code>GET {path}</code>{copyFeedback === `api-${item.domain}` ? <Check size={13} /> : <Copy size={13} />}</button>;
                              })}
                            </div>
                          </>
                        ) : (
                          <div className="api-save-hint">
                            <Database size={23} />
                            <div><strong>下载文件现在即可使用</strong><p>{dbConfigured ? "如需稳定 API 地址，请点击页面右上角“保存 Bundle”。" : "如需在线 API，请先配置 DATABASE_URL；本地 JSON 与 ZIP 导出不受影响。"}</p></div>
                          </div>
                        )}
                      </div>
                    </article>

                    <article className="panel json-panel">
                      <div className="panel-title"><div><Code2 size={18} /><strong>Canonical IR Bundle 预览</strong></div><button type="button" onClick={() => void copyValue({...bundle,bomMappings}, "bundle-json")}>{copyFeedback === "bundle-json" ? <Check size={14} /> : <Copy size={14} />} {copyFeedback === "bundle-json" ? "已复制" : "复制全部"}</button></div>
                      <pre>{JSON.stringify({...bundle,bomMappings}, null, 2)}</pre>
                    </article>
                  </div>
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
              <div className="adapter-grid">{SUPPORT_MATRIX.map((item) => <article className="adapter-card" key={item.format}><div className={`adapter-icon ${item.tone}`}>{item.format.startsWith("KiCad") ? <CircuitBoard size={23} /> : item.format.startsWith("Altium") ? <Layers3 size={23} /> : <Box size={23} />}</div><div><div className="adapter-title"><h3>{item.format}</h3><span className={item.tone}>{item.level}</span></div><p>{item.detail}</p></div><ul>{item.format.startsWith("KiCad") ? <><li><Check size={13} /> S-expression lexer + AST + Source Span</li><li><Check size={13} /> Deterministic junction connectivity</li><li><Check size={13} /> PCB explicit Net assignment</li></> : item.format.startsWith("Altium") ? <><li><Check size={13} /> PrjPcb / DsnWrk / OutJob configuration</li><li><Check size={13} /> CFB signature and bounds intake</li><li className="pending"><Clock3 size={13} /> Proprietary Record semantic mapper</li></> : item.format.startsWith("Allegro") ? <><li><Check size={13} /> BRD content signature + source hashes</li><li><Check size={13} /> KiCad 10+ conversion package</li><li className="pending"><Clock3 size={13} /> Online import requires a configured worker</li></> : item.format.startsWith("JLC") ? <><li><Check size={13} /> EPro ZIP + Project manifest</li><li><Check size={13} /> ESch / EPCB record mapping</li><li className="pending"><Clock3 size={13} /> SQLite private-table semantic mapper</li></> : <><li><Check size={13} /> docType 1 / 3 / 5 routing</li><li><Check size={13} /> Schematic and PCB Shape mapping</li><li className="pending"><Clock3 size={13} /> Rare Shape semantic coverage</li></>}</ul></article>)}</div>
              <article className="panel principles"><div className="panel-title"><div><ShieldCheck size={18} /><strong>不可突破的解析纪律</strong></div></div><div>{["Wire 几何对象不等于 Net", "Cross without Junction 不连接", "同名 Net 不自动跨文档合并", "Unknown Token / Record / Shape 必须保留", "V1 只读，不无损写回", "核心解析与连通性不使用 LLM"].map((item) => <span key={item}><Check size={14} />{item}</span>)}</div></article>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
