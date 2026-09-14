"use client";
import { useEffect, useState } from "react";
import type { CanonicalIrBundle } from "../lib/eda/types";
import { mineKnowledge } from "../lib/knowledge/miner";
import { applyReview } from "../lib/knowledge/review";
import type {
  HardwareBlock,
  MiningResult,
  PinRole,
  ReviewEdit,
} from "../lib/knowledge/types";
import { apiFetch } from "../lib/client-api";
const roleOptions: PinRole[] = [
  "POWER",
  "GROUND",
  "CLOCK",
  "RESET",
  "BOOT",
  "ENABLE",
  "USB",
  "SPI",
  "I2C",
  "SWD",
  "UART",
  "FEEDBACK",
  "SWITCHING",
  "ANALOG",
  "UNKNOWN",
];
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function KnowledgeWorkbench({ bundle }: { bundle: CanonicalIrBundle }) {
  const [result, setResult] = useState<MiningResult>();
  const [blocks, setBlocks] = useState<HardwareBlock[]>([]);
  const [selected, setSelected] = useState("");
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [ack, setAck] = useState(false);
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<ReviewEdit>({});
  useEffect(() => {
    let cancelled = false;
    mineKnowledge(bundle)
      .then((r) => {
        if (!cancelled) {
          setResult(r);
          setBlocks(r.blocks);
          setSelected(r.blocks[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (!cancelled) setMessage(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [bundle]);
  const block = blocks.find((b) => b.id === selected);
  let draft = block;
  if (block && result) {
    try {
      draft = applyReview(result, block, edit);
    } catch {
      /* Invalid draft stays editable; the API validates before persisting. */
    }
  }
  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const response = await apiFetch("/api/knowledge/mine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bundle),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setResult(data.result);
      setBlocks(data.blocks.map((r: { block: HardwareBlock }) => r.block));
      setRevisions(
        Object.fromEntries(
          data.blocks.map((r: { id: string; revision: number }) => [
            r.id,
            r.revision,
          ]),
        ),
      );
      setSaved(true);
      setEdit({});
      setMessage("已保存候选，审核记录将保存在数据库中。");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  async function act(action: string) {
    if (!block) return;
    setBusy(true);
    try {
      const response = await apiFetch(
        `/api/blocks/${encodeURIComponent(block.id)}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            revision: revisions[block.id],
            edit,
            acknowledge: ack,
          }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setBlocks((b) => b.map((v) => (v.id === block.id ? data.block : v)));
      setRevisions((r) => ({ ...r, [block.id]: data.revision }));
      setEdit({});
      setAck(false);
      setMessage(
        action === "publish"
          ? "已发布，可通过知识库 API 查询。"
          : "审核操作已保存。",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  function memberEdit(
    partId: string,
    decision: HardwareBlock["members"][number]["decision"],
    role: string,
  ) {
    setEdit((e) => ({
      ...e,
      ports: undefined,
      members: [
        ...(e.members ?? []).filter((m) => m.partId !== partId),
        { partId, decision, role },
      ],
    }));
  }
  return (
    <section className="knowledge-workbench">
      <header className="knowledge-heading">
        <div>
          <span className="eyebrow">CANON / HARDWARE KNOWLEDGE</span>
          <h2>从参考设计中提取可复用功能块</h2>
          <p>连接来自源 IR，功能分类是候选判断。审核批准后才能发布。</p>
        </div>
        <div className="knowledge-actions">
          <button
            onClick={() =>
              result &&
              download({ ...result, blocks }, "hardware-knowledge.json")
            }
            disabled={!result}
          >
            导出知识 JSON
          </button>
          <button
            className="primary"
            onClick={() => void save()}
            disabled={busy || !result}
          >
            {busy ? "处理中…" : saved ? "刷新已保存版本" : "保存候选到知识库"}
          </button>
        </div>
      </header>
      {message && (
        <p role="status" className="knowledge-message">
          {message}
        </p>
      )}
      {!result ? (
        <p>正在分析源 IR…</p>
      ) : (
        <>
          <div className="knowledge-metrics">
            <div>
              <strong>{result.anchors.length}</strong>核心 IC
            </div>
            <div>
              <strong>{blocks.length}</strong>功能块候选
            </div>
            <div>
              <strong>{result.graph.pins.length}</strong>管脚 / 焊盘
            </div>
            <div>
              <strong>
                {blocks.filter((b) => b.status === "PUBLISHED").length}
              </strong>
              已发布
            </div>
          </div>
          {result.warnings.map((w) => (
            <p key={w} className="knowledge-note">
              {w}
            </p>
          ))}
          <div className="knowledge-layout">
            <aside>
              <input
                aria-label="搜索核心 IC"
                placeholder="搜索 MPN、功能、位号"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {blocks
                .filter((b) =>
                  `${b.name} ${b.anchorReference}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((b) => (
                  <button
                    className={selected === b.id ? "selected" : ""}
                    key={b.id}
                    onClick={() => {
                      setSelected(b.id);
                      setEdit({});
                      setAck(false);
                    }}
                  >
                    <b>{b.name}</b>
                    <small>
                      {b.anchorReference} ·{" "}
                      {
                        b.members.filter((m) => m.decision === "included")
                          .length
                      }{" "}
                      成员 · {b.status}
                    </small>
                  </button>
                ))}
              {!blocks.length && (
                <p>没有可挖掘的核心 IC。请导入包含管脚与网络的工程。</p>
              )}
            </aside>
            {draft && block ? (
              <article>
                <div className="knowledge-actions">
                  <input
                    aria-label="功能块名称"
                    value={edit.name ?? block.name}
                    onChange={(e) =>
                      setEdit((v) => ({ ...v, name: e.target.value }))
                    }
                  />
                  <span>{block.status}</span>
                </div>
                <p className="knowledge-note">
                  连接置信度 {(block.confidence.connectivity * 100).toFixed(0)}%
                  · 语义置信度 {(block.confidence.semantic * 100).toFixed(0)}% ·{" "}
                  {result.graph.domain}。这些数值不是验收准确率。
                </p>
                <h3>成员与功能边界</h3>
                <div className="knowledge-table">
                  <table>
                    <thead>
                      <tr>
                        <th>位号 / 值</th>
                        <th>处理</th>
                        <th>角色</th>
                        <th>关联依据</th>
                      </tr>
                    </thead>
                    <tbody>
                      {draft.members.map((m) => (
                        <tr key={m.partId}>
                          <td>
                            <b>{m.reference}</b>
                            <br />
                            {m.value}
                          </td>
                          <td>
                            <select
                              aria-label={`${m.reference} 边界`}
                              disabled={m.partId === block.anchorId}
                              value={m.decision}
                              onChange={(e) =>
                                memberEdit(
                                  m.partId,
                                  e.target.value as typeof m.decision,
                                  m.role,
                                )
                              }
                            >
                              <option value="included">纳入</option>
                              <option value="review">待确认</option>
                              <option value="boundary">外部边界</option>
                            </select>
                          </td>
                          <td>
                            <input
                              aria-label={`${m.reference} 角色`}
                              disabled={m.partId === block.anchorId}
                              value={m.role}
                              onChange={(e) =>
                                memberEdit(m.partId, m.decision, e.target.value)
                              }
                            />
                          </td>
                          <td>{m.reasons.join("；")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <h3>外部端口</h3>
                <div className="knowledge-table">
                  <table>
                    <thead>
                      <tr>
                        <th>端口</th>
                        <th>功能</th>
                        <th>管脚</th>
                      </tr>
                    </thead>
                    <tbody>
                      {draft.ports.map((p) => (
                        <tr key={p.netId}>
                          <td>
                            <input
                              aria-label={`端口 ${p.netId}`}
                              value={p.name}
                              onChange={(e) =>
                                setEdit((v) => ({
                                  ...v,
                                  ports: [
                                    ...(v.ports ?? []).filter(
                                      (x) => x.netId !== p.netId,
                                    ),
                                    {
                                      netId: p.netId,
                                      name: e.target.value,
                                      role: p.role,
                                    },
                                  ],
                                }))
                              }
                            />
                          </td>
                          <td>
                            <select
                              aria-label={`${p.name} 功能`}
                              value={p.role}
                              onChange={(e) =>
                                setEdit((v) => ({
                                  ...v,
                                  ports: [
                                    ...(v.ports ?? []).filter(
                                      (x) => x.netId !== p.netId,
                                    ),
                                    {
                                      netId: p.netId,
                                      name: p.name,
                                      role: e.target.value as PinRole,
                                    },
                                  ],
                                }))
                              }
                            >
                              {roleOptions.map((r) => (
                                <option key={r}>{r}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            {p.pinIds
                              .map((id) => {
                                const pin = result.graph.pins.find(
                                  (v) => v.id === id,
                                );
                                return `${bundle.parts.find((v) => v.id === pin?.partId)?.reference}.${pin?.number} (${pin?.name})`;
                              })
                              .join(", ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <h3>连接图谱</h3>
                <div className="knowledge-connections">
                  {result.graph.nets
                    .filter((n) => draft.ports.some((p) => p.netId === n.id))
                    .map((n) => (
                      <div key={n.id}>
                        <b>{n.name}</b>
                        <span>
                          {n.pinIds
                            .map((id) => {
                              const p = result.graph.pins.find(
                                (p) => p.id === id,
                              )!;
                              return `${bundle.parts.find((v) => v.id === p.partId)?.reference}.${p.number}`;
                            })
                            .join(" ↔ ")}
                        </span>
                        <small>
                          {n.boundary ? "公共网络 / 扩展边界" : "信号网络"}
                        </small>
                      </div>
                    ))}
                </div>
                <details>
                  <summary>查看源证据（{block.evidence.length}）</summary>
                  {block.evidence.map((e, i) => (
                    <div className="knowledge-evidence" key={e.id + i}>
                      <b>{e.source.path}</b>
                      <code>
                        {e.source.nativeId ?? e.source.jsonPath ?? e.entityId}
                      </code>
                      <p>{e.explanation}</p>
                      <small>
                        SHA256 {e.sha256} · {e.parserVersion}
                      </small>
                    </div>
                  ))}
                </details>
                <details>
                  <summary>相对 PCB 位置（{draft.placement.length}）</summary>
                  <pre>{JSON.stringify(draft.placement, null, 2)}</pre>
                </details>
                <div className="knowledge-review">
                  {block.warnings.map((w) => (
                    <p key={w}>{w}</p>
                  ))}
                  <label>
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    我已检查源证据、成员边界和解析限制
                  </label>
                  <div className="knowledge-actions">
                    <button
                      disabled={!saved || busy}
                      onClick={() => void act("edit")}
                    >
                      保存修改 / 退回候选
                    </button>
                    <button
                      disabled={
                        !saved ||
                        busy ||
                        !ack ||
                        draft.members.some((m) => m.decision === "review")
                      }
                      onClick={() => void act("approve")}
                    >
                      批准
                    </button>
                    <button
                      disabled={!saved || busy}
                      onClick={() => void act("reject")}
                    >
                      驳回
                    </button>
                    <button
                      className="primary"
                      disabled={
                        !saved ||
                        busy ||
                        block.status !== "APPROVED" ||
                        Object.keys(edit).length > 0
                      }
                      onClick={() => void act("publish")}
                    >
                      发布到知识库
                    </button>
                  </div>
                  {!saved && (
                    <small>先保存候选到知识库，才能记录审核与发布。</small>
                  )}
                </div>
              </article>
            ) : (
              <article>
                <p>选择左侧功能块查看成员、端口和证据。</p>
              </article>
            )}
          </div>
        </>
      )}
      {!!bundle.pdfEvidence?.length && (
        <section className="knowledge-pdf">
          <h3>PDF 文档证据</h3>
          <p>
            文字坐标采用旋转后的页面左上角原点，单位为 PDF
            point。位号仅为文本候选，尚未关联管脚或连线。
          </p>
          {bundle.pdfEvidence.map((doc) => (
            <details key={doc.assetId} open>
              <summary>
                {doc.path} · {doc.status} · {doc.pages.length} 页
              </summary>
              {doc.error && <p>{doc.error}</p>}
              {doc.pages.map((page) => (
                <details key={page.page}>
                  <summary>
                    第 {page.page} 页 · {page.text.length} 文本对象 · 位号候选{" "}
                    {page.referenceCandidates.join(", ") || "无"}
                  </summary>
                  <div className="knowledge-table">
                    <table>
                      <thead>
                        <tr>
                          <th>源文本</th>
                          <th>x / y / w / h</th>
                        </tr>
                      </thead>
                      <tbody>
                        {page.text.map((t, i) => (
                          <tr key={i}>
                            <td>{t.text}</td>
                            <td>
                              {t.bbox.map((n) => n.toFixed(1)).join(" / ")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ))}
            </details>
          ))}
        </section>
      )}
    </section>
  );
}
