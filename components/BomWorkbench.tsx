"use client";
import { useMemo, useRef, useState, useEffect } from "react";
import type { CanonicalIrBundle } from "../lib/eda/types";
import type { BomQuery, BomMapping, RankedCandidate } from "../lib/bom/types";
import { skipReason } from "../lib/bom/match";
import { apiFetch } from "../lib/client-api";
const labels: Record<BomMapping["status"], string> = {
  VERIFIED: "精确匹配",
  CONFIRMED: "人工确认",
  REVIEW_REQUIRED: "待确认",
  NO_MATCH: "未找到",
  QUERY_FAILED: "查询失败",
  NOT_CONFIGURED: "接口未配置",
  SKIPPED: "不自动选型",
};
export function bomRows(bundle: CanonicalIrBundle) {
  const groups = new Map<
    string,
    BomQuery & { variant: string; quantity: number }
  >();
  for (const p of bundle.parts) {
    const key = JSON.stringify([
      p.mpnRaw,
      p.manufacturerRaw,
      p.value,
      p.footprint,
      p.variantStatus,
    ]);
    const row = groups.get(key) ?? {
      id: p.id,
      references: [],
      value: p.value,
      mpn: p.mpnRaw ?? "",
      manufacturer: p.manufacturerRaw ?? "",
      footprint: p.footprint ?? "",
      description: p.fields.Description ?? "",
      variant: p.variantStatus,
      quantity: 0,
    };
    row.references.push(p.reference);
    row.quantity++;
    groups.set(key, row);
  }
  return [...groups.values()].sort((a, b) =>
    a.references[0].localeCompare(b.references[0], undefined, {
      numeric: true,
    }),
  );
}
const csv = (v: unknown) => {
  let s = String(v ?? "");
  if (/^[=+@\-]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};
export function BomWorkbench({
  bundle,
  mappings,
  onMapping,
}: {
  bundle: CanonicalIrBundle;
  mappings: Record<string, BomMapping>;
  onMapping: (id: string, m: BomMapping) => void;
}) {
  const rows = useMemo(() => bomRows(bundle), [bundle]);
  const [query, setQuery] = useState(""),
    [onlyActive, setOnlyActive] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [expanded, setExpanded] = useState(""),
    [overrides, setOverrides] = useState<Record<string, string>>({});
  const controllers = useRef(new Set<AbortController>()),
    cancelled = useRef(false);
  useEffect(() => {
    const active = controllers.current;
    return () => {
      cancelled.current = true;
      active.forEach((c) => c.abort());
    };
  }, []);
  const eligible = rows.filter(
    (r) =>
      !skipReason(r) && r.variant !== "dnp" && r.variant !== "variant_excluded" && mappings[r.id]?.status !== "CONFIRMED",
  );
  const filtered = rows.filter(
    (r) =>
      (!onlyActive || !skipReason(r)) &&
      [
        r.references.join(" "),
        r.value,
        r.mpn,
        r.manufacturer,
        mappings[r.id]?.selected?.mpn,
        mappings[r.id]?.selected?.manufacturer,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  async function resolve(row: BomQuery) {
    const controller = new AbortController();
    controllers.current.add(controller);
    const q = { ...row, mpn: overrides[row.id] ?? row.mpn };
    try {
      const response = await apiFetch("/api/bom/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(q),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "查询失败");
      if (!cancelled.current) onMapping(row.id, data);
    } catch (e) {
      if (!cancelled.current) {
        const raw = e instanceof Error ? e.message : "查询失败";
        const message =
          raw === "AUTH_NOT_CONFIGURED"
            ? "请在 Vercel 配置 EDA_API_TOKEN，并在页面设置访问密钥"
            : raw === "UNAUTHORIZED"
              ? "请在页面设置正确的 API 访问密钥"
              : raw;
        onMapping(row.id, {
          query: q,
          status: "QUERY_FAILED",
          candidates: [],
          probes: [],
          updatedAt: new Date().toISOString(),
          message,
        });
      }
    } finally {
      controllers.current.delete(controller);
    }
  }
  async function run(items: BomQuery[]) {
    cancelled.current = false;
    setBusy(true);
    let next = 0,
      done = 0;
    setMessage(`正在匹配 0 / ${items.length} 行`);
    try {
      await Promise.all(
        Array.from({ length: Math.min(2, items.length) }, async () => {
          while (next < items.length && !cancelled.current) {
            const row = items[next++];
            await resolve(row);
            done++;
            if (!cancelled.current)
              setMessage(`已处理 ${done} / ${items.length} 行`);
          }
        }),
      );
    } finally {
      setBusy(false);
      if (cancelled.current) setMessage("已停止；已完成的结果已保留");
    }
  }
  function confirm(row: BomQuery, candidate: RankedCandidate) {
    const result = mappings[row.id];
    if (!result) return;
    onMapping(row.id, {
      ...result,
      status: "CONFIRMED",
      selected: candidate,
      updatedAt: new Date().toISOString(),
      message: "用户已确认候选；源工程字段保留不变",
    });
  }
  function exportCsv() {
    const lines = [
      [
        "Qty",
        "References",
        "Value",
        "Footprint",
        "Source Manufacturer",
        "Source MPN",
        "Mapped Manufacturer",
        "Mapped MPN",
        "Status",
        "Sources",
        "Checked At",
      ],
      ...filtered.map((r) => {
        const m = mappings[r.id];
        return [
          r.quantity,
          r.references.join(" "),
          r.value,
          r.footprint,
          r.manufacturer,
          r.mpn,
          m?.selected?.manufacturer ?? r.manufacturer,
          m?.selected?.mpn ?? r.mpn,
          m ? labels[m.status] : skipReason(r) ? "不自动选型" : "未查询",
          m?.selected?.sources.join(";") ?? "",
          m?.updatedAt ?? "",
        ];
      }),
    ];
    const blob = new Blob(
      ["\ufeff" + lines.map((l) => l.map(csv).join(",")).join("\n")],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = bundle.project.name + "-mapped-bom.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <article className="panel bom-mapping">
      <div className="viewer-toolbar">
        <strong>BOM · 物料与厂商映射</strong>
        <div className="viewer-tools">
          <input
            aria-label="搜索 BOM"
            placeholder="位号 / 型号 / 厂商"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={onlyActive}
              onChange={(e) => setOnlyActive(e.target.checked)}
            />
            隐藏阻容感等无源件
          </label>
          <button
            disabled={busy || !eligible.length}
            onClick={() => void run(eligible)}
          >
            匹配非无源器件（{eligible.length} 行）
          </button>
          {busy && (
            <button
              onClick={() => {
                cancelled.current = true;
                controllers.current.forEach((c) => c.abort());
              }}
            >
              停止
            </button>
          )}
          <button onClick={exportCsv}>下载映射后 CSV</button>
        </div>
      </div>
      <p className="knowledge-note">
        优先查询 ezPLM，未精确命中时查询
        Iceasy、DigiKey、Mouser。相似型号和多厂商结果需确认。结果随完整工程 JSON
        导出或“保存 Bundle”保存，不覆盖源设计字段。
      </p>
      <p role="status" className="knowledge-note">
        {message ||
          `${rows.length} 行 · ${bundle.parts.length} 个器件 · ${Object.values(mappings).filter((m) => m.selected).length} 行已确定型号`}
      </p>
      <div className="data-table">
        <table>
          <thead>
            <tr>
              <th>数量 / 位号</th>
              <th>源 Value / 封装</th>
              <th>厂商</th>
              <th>MPN</th>
              <th>状态 / 操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const m = mappings[row.id],
                chosen = m?.selected,
                skip = skipReason(row);
              return (
                <BomEntry
                  key={row.id}
                  row={row}
                  mapping={m}
                  chosen={chosen}
                  skipped={skip}
                  expanded={expanded === row.id}
                  busy={busy}
                  query={overrides[row.id] ?? row.mpn ?? ""}
                  onExpand={() =>
                    setExpanded(expanded === row.id ? "" : row.id)
                  }
                  onQuery={(v) => setOverrides((o) => ({ ...o, [row.id]: v }))}
                  onRun={() => void run([row])}
                  onConfirm={(c) => confirm(row, c)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </article>
  );
}
function BomEntry({
  row,
  mapping: m,
  chosen,
  skipped,
  expanded,
  busy,
  query,
  onExpand,
  onQuery,
  onRun,
  onConfirm,
}: {
  row: BomQuery & { quantity: number };
  mapping?: BomMapping;
  chosen?: RankedCandidate;
  skipped: string;
  expanded: boolean;
  busy: boolean;
  query: string;
  onExpand: () => void;
  onQuery: (v: string) => void;
  onRun: () => void;
  onConfirm: (c: RankedCandidate) => void;
}) {
  return (
    <>
      <tr>
        <td>
          <b>
            {row.quantity} × {row.references.join(", ")}
          </b>
        </td>
        <td>
          {row.value}
          <br />
          <small>{row.footprint}</small>
        </td>
        <td>{chosen?.manufacturer || row.manufacturer || "待补全"}</td>
        <td>
          <code>{chosen?.mpn || row.mpn || "未确认"}</code>
          {chosen && <small>来源：{chosen.sources.join(" / ")}</small>}
        </td>
        <td>
          {m ? labels[m.status] : skipped ? "不自动选型" : "未查询"}
          <br />
          <button type="button" onClick={onExpand}>
            {expanded ? "收起" : "查看 / 匹配"}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5}>
            <div className="bom-candidates">
              <p>
                {m?.message ||
                  skipped ||
                  "使用源 Value 作为检索词；可以补充完整料号缩小范围。"}
              </p>
              <label>
                检索型号{" "}
                <input
                  aria-label={`${row.references[0]} 检索型号`}
                  placeholder={row.value}
                  value={query}
                  onChange={(e) => onQuery(e.target.value)}
                />
              </label>
              <button disabled={busy || !!skipped} onClick={onRun}>
                查询 / 重试
              </button>
              {m?.probes.map((p) => (
                <p key={p.source}>
                  {p.source}：
                  {p.status === "NOT_CONFIGURED"
                    ? "未配置"
                    : p.status === "ERROR"
                      ? "查询失败"
                      : p.status === "SKIPPED"
                        ? "未查询"
                        : "已查询"}{" "}
                  · {p.count} 个结果 {p.message}
                </p>
              ))}
              {m?.candidates.map((c) => (
                <div
                  className="bom-candidate"
                  key={c.mpn + "|" + c.manufacturer}
                >
                  <div>
                    <b>
                      {c.mpn} · {c.manufacturer || "厂商未知"}
                    </b>
                    <p>
                      {c.package} {c.description}
                    </p>
                    <small>
                      {c.exact ? "完整料号相同" : "相似型号 / 型号后缀不同"} ·{" "}
                      {c.sources.join(" / ")}
                    </small>
                    {c.conflicts.length > 0 && (
                      <p role="note">{c.conflicts.join("；")}</p>
                    )}
                  </div>
                  <button
                    disabled={busy || !c.manufacturer}
                    onClick={() => onConfirm(c)}
                  >
                    确认此型号
                  </button>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
