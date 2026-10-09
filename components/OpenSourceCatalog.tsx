"use client";

import { useEffect, useRef, useState } from "react";
import {
  FolderOpen,
  Search,
  Download,
  ExternalLink,
  X,
  LoaderCircle,
} from "lucide-react";
import { catalogJson, importCatalogSource } from "../lib/catalog/client";
import {
  safeWebUrl,
  sourceKind,
  type CatalogCategory,
  type CatalogEcad,
  type CatalogPage,
  type CatalogProject,
  type CatalogProvenance,
} from "../lib/catalog/types";

type Props = {
  onImport: (files: File[], provenance: CatalogProvenance) => Promise<void>;
};
export function OpenSourceCatalog({ onImport }: Props) {
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [category, setCategory] = useState("");
  const [keyword, setKeyword] = useState("");
  const [search, setSearch] = useState("");
  const [projects, setProjects] = useState<CatalogProject[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listBusy, setListBusy] = useState(true);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<CatalogProject | null>(null);
  const [ecad, setEcad] = useState<CatalogEcad | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailBusy, setDetailBusy] = useState(false);
  const [sources, setSources] = useState<number[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const connectionAbort = useRef<AbortController | null>(null);
  const listAbort = useRef<AbortController | null>(null);
  const importAbort = useRef<AbortController | null>(null);
  const upload = useRef<HTMLInputElement>(null);

  async function check() {
    connectionAbort.current?.abort();
    const controller = new AbortController();
    connectionAbort.current = controller;
    setChecking(true);
    setError("");
    try {
      const value = await catalogJson<{ connected: boolean }>("/session", {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setConnected(value.connected);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    connectionAbort.current = controller;
    catalogJson<{ connected: boolean }>("/session", {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setConnected(value.connected);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => {
      controller.abort();
      listAbort.current?.abort();
      importAbort.current?.abort();
    };
  }, []);
  function selectProject(project: CatalogProject | null) {
    setSelected(project);
    setEcad(null);
    setSources([]);
    setDetailError("");
    setImportError("");
    setDetailBusy(Boolean(project));
  }
  function resetList() {
    listAbort.current?.abort();
    setProjects([]);
    setCursor(null);
    selectProject(null);
    setListBusy(true);
    setError("");
  }
  function selectCategory(value: string) {
    if (value === category) return;
    resetList();
    setCategory(value);
  }

  async function login(event: React.FormEvent) {
    event.preventDefault();
    connectionAbort.current?.abort();
    const controller = new AbortController();
    connectionAbort.current = controller;
    setChecking(true);
    setError("");
    const loginPassword = password;
    setPassword("");
    try {
      await catalogJson("/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password: loginPassword }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setConnected(true);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "登录失败。");
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  }
  async function logout() {
    setError("");
    try {
      await catalogJson("/session", { method: "DELETE" });
      setConnected(false);
      setSelected(null);
      setEcad(null);
      setProjects([]);
      setCategories([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "断开失败。");
    }
  }
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    catalogJson<{ data: CatalogCategory[] }>("/categories", {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          if (!Array.isArray(value.data)) throw new Error("分类响应格式无效。");
          setCategories(value.data);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [connected, reload]);
  useEffect(() => {
    if (!connected) return;
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    const query = new URLSearchParams({ pageSize: "20" });
    if (category) query.set("categoryId", category);
    if (search) query.set("keyword", search);
    catalogJson<CatalogPage>(`/projects?${query}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(value.data) || !value.meta)
          throw new Error("项目列表响应格式无效。");
        setProjects(value.data);
        setCursor(value.meta.hasMore ? value.meta.nextCursor : null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setListBusy(false);
      });
    return () => controller.abort();
  }, [connected, category, search, reload]);
  async function more() {
    if (!cursor || listBusy) return;
    const controller = new AbortController();
    listAbort.current?.abort();
    listAbort.current = controller;
    const currentCursor = cursor;
    setListBusy(true);
    setError("");
    const query = new URLSearchParams({ pageSize: "20", cursor });
    if (category) query.set("categoryId", category);
    if (search) query.set("keyword", search);
    try {
      const value = await catalogJson<CatalogPage>(`/projects?${query}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!Array.isArray(value.data) || !value.meta)
        throw new Error("项目列表响应格式无效。");
      setProjects((previous) => [
        ...previous,
        ...value.data.filter((p) => !previous.some((old) => old.id === p.id)),
      ]);
      setCursor(
        value.meta.hasMore && value.meta.nextCursor !== currentCursor
          ? value.meta.nextCursor
          : null,
      );
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "加载失败。");
    } finally {
      if (!controller.signal.aborted) setListBusy(false);
    }
  }
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    catalogJson<{ data: CatalogEcad }>(`/projects/${selected.id}/ecad`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!value.data || !Array.isArray(value.data.sourceLinks))
          throw new Error("工程资料响应格式无效。");
        setEcad(value.data);
        const first = value.data.sourceLinks.findIndex(
          (link) => sourceKind(link.url) !== "page",
        );
        setSources(first < 0 ? [] : [first]);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setDetailError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailBusy(false);
      });
    return () => controller.abort();
  }, [selected]);
  async function extract(localFiles?: File[]) {
    if (!selected || !ecad || importing) return;
    const controller = new AbortController();
    importAbort.current = controller;
    setImporting(true);
    setImportError("");
    try {
      if (localFiles) {
        const files: CatalogProvenance["files"] = [];
        for (const file of localFiles) {
          if (file.size > 75 * 1024 * 1024)
            throw new Error("文件超过 75 MB，请拆分导入。");
          const digest = await crypto.subtle.digest(
            "SHA-256",
            await file.arrayBuffer(),
          );
          files.push({
            name: file.name,
            sha256: [...new Uint8Array(digest)]
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(""),
          });
        }
        if (!controller.signal.aborted)
          await onImport(localFiles, {
            provider: "ezplm",
            projectId: selected.id,
            bomId: ecad.bomId,
            projectName: selected.name,
            importedAt: new Date().toISOString(),
            method: "local_upload",
            files,
          });
      } else {
        const result = await importCatalogSource(
          selected,
          ecad,
          sources,
          controller.signal,
        );
        if (!controller.signal.aborted)
          await onImport(result.files, result.provenance);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setImportError(
          e instanceof Error ? e.message : "下载中断，请重试或上传工程文件。",
        );
    } finally {
      if (!controller.signal.aborted) setImporting(false);
    }
  }
  const categoryButtons = (
    items: CatalogCategory[],
    depth = 0,
  ): React.ReactNode =>
    items.map((item) => (
      <div key={item.id}>
        <button
          type="button"
          aria-pressed={category === item.id}
          disabled={importing}
          style={{ paddingLeft: 12 + depth * 14 }}
          onClick={() => selectCategory(item.id)}
        >
          <span>{item.name}</span>
          <small>{item.projectCount}</small>
        </button>
        {item.children?.length
          ? categoryButtons(item.children, depth + 1)
          : null}
      </div>
    ));
  return (
    <section className="catalog-workbench">
      <div className="catalog-heading">
        <div>
          <div className="eyebrow">ezPLM · OPEN SOURCE</div>
          <h1>开源工程库</h1>
          <p>
            按分类查找参考设计，选择源工程提取 IR，并进入原理图、PCB
            与器件资产工作台。
          </p>
        </div>
        {connected && (
          <button
            className="ghost-button"
            disabled={importing}
            onClick={() => void logout()}
          >
            断开 ezPLM
          </button>
        )}
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
          <button
            onClick={() => {
              if (connected) {
                resetList();
                setReload((n) => n + 1);
              } else void check();
            }}
          >
            重试连接
          </button>
        </div>
      )}
      {!connected ? (
        <form className="catalog-login" onSubmit={login}>
          <h2>连接 ezPLM 账号</h2>
          <p>
            先填写页面顶部的 EDAIR 工作区密钥，再使用具有目录访问权限的 ezPLM
            账号登录。
          </p>
          <label>
            手机号或邮箱
            <input
              autoComplete="username"
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </label>
          <label>
            密码
            <input
              autoComplete="current-password"
              type="password"
              minLength={6}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button className="primary-button" disabled={checking}>
            {checking ? "正在连接…" : "连接并浏览工程"}
          </button>
          <small>登录仅用于获取您可访问的项目目录；密码不会保存到 IR。</small>
        </form>
      ) : (
        <>
          <form
            className="catalog-search"
            onSubmit={(e) => {
              e.preventDefault();
              if (search !== keyword.trim()) {
                resetList();
                setSearch(keyword.trim());
              }
            }}
          >
            <Search size={18} />
            <input
              aria-label="搜索开源工程"
              placeholder="搜索工程名称或描述"
              value={keyword}
              disabled={importing}
              onChange={(e) => setKeyword(e.target.value)}
            />
            <button className="primary-button" disabled={importing}>
              搜索
            </button>
          </form>
          <div className={`catalog-layout ${selected ? "with-detail" : ""}`}>
            <aside className="catalog-categories" aria-label="工程分类">
              <h2>分类</h2>
              <button
                aria-pressed={!category}
                disabled={importing}
                onClick={() => selectCategory("")}
              >
                全部工程
              </button>
              {categoryButtons(categories)}
              {!categories.some((c) => c.id === "uncategorized") && (
                <button
                  aria-pressed={category === "uncategorized"}
                  disabled={importing}
                  onClick={() => selectCategory("uncategorized")}
                >
                  未分类
                </button>
              )}
            </aside>
            <div className="catalog-results">
              <p aria-live="polite">
                已显示 {projects.length} 个工程{listBusy ? " · 加载中…" : ""}
              </p>
              <div className="catalog-cards">
                {projects.map((project) => (
                  <button
                    className="catalog-card"
                    key={project.id}
                    disabled={importing}
                    aria-pressed={selected?.id === project.id}
                    onClick={() => selectProject(project)}
                  >
                    <FolderOpen size={24} />
                    <h3>{project.name}</h3>
                    <p>{project.description || "暂无描述"}</p>
                    <span>查看资料与提取 IR →</span>
                  </button>
                ))}
              </div>
              {!listBusy && !projects.length && !error && (
                <p className="catalog-empty">
                  此分类或关键词下没有工程，请调整筛选。
                </p>
              )}
              {cursor && (
                <button
                  className="ghost-button"
                  disabled={listBusy || importing}
                  onClick={() => void more()}
                >
                  {listBusy ? "加载中…" : "加载更多"}
                </button>
              )}
            </div>
            {selected && (
              <aside className="catalog-detail" aria-label="所选工程">
                <div className="catalog-detail-title">
                  <h2>{selected.name}</h2>
                  <button
                    aria-label="关闭工程详情"
                    disabled={importing}
                    onClick={() => selectProject(null)}
                  >
                    <X size={18} />
                  </button>
                </div>
                <p>{selected.description}</p>
                {detailBusy && <p role="status">正在获取工程资料…</p>}
                {detailError && (
                  <p role="alert">
                    {detailError}
                    <button onClick={() => selectProject({ ...selected })}>
                      重新获取
                    </button>
                  </p>
                )}
                {ecad && (
                  <>
                    <p className="catalog-note">
                      选择工程 ZIP
                      或完整来源文件。预览页面和网表可用标记不包含可解析的工程正文。
                    </p>
                    <div className="catalog-source-list">
                      {ecad.sourceLinks.map((link, index) => (
                        <div key={`${index}-${link.url}`}>
                          <label>
                            <input
                              type="checkbox"
                              disabled={
                                sourceKind(link.url) === "page" || importing
                              }
                              checked={sources.includes(index)}
                              onChange={(e) =>
                                setSources((old) =>
                                  e.target.checked
                                    ? [...old, index]
                                    : old.filter((i) => i !== index),
                                )
                              }
                            />
                            <span>
                              {link.name || `来源 ${index + 1}`}
                              <small>
                                {sourceKind(link.url) === "github"
                                  ? "GitHub 工程快照"
                                  : sourceKind(link.url) === "file"
                                    ? "源文件"
                                    : "资料页面"}
                              </small>
                            </span>
                          </label>
                          {safeWebUrl(link.url) && (
                            <a
                              href={safeWebUrl(link.url)}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`打开来源 ${index + 1}`}
                            >
                              <ExternalLink size={15} />
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                    {!ecad.sourceLinks.length && (
                      <p>该项目尚未提供源工程链接。</p>
                    )}
                    <div className="catalog-preview-links">
                      {safeWebUrl(ecad.ecadUrl) && (
                        <a
                          href={safeWebUrl(ecad.ecadUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          打开 ECAD 预览 ↗
                        </a>
                      )}
                      {safeWebUrl(ecad.altiumUrl) && (
                        <a
                          href={safeWebUrl(ecad.altiumUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          打开 Altium 预览 ↗
                        </a>
                      )}
                    </div>
                    <button
                      className="primary-button"
                      disabled={importing || !sources.length}
                      onClick={() => void extract()}
                    >
                      {importing ? (
                        <LoaderCircle size={16} className="spin" />
                      ) : (
                        <Download size={16} />
                      )}
                      {importing ? "正在下载工程…" : "提取 IR"}
                    </button>
                    {importing && (
                      <button
                        className="ghost-button"
                        onClick={() => {
                          importAbort.current?.abort();
                          setImporting(false);
                        }}
                      >
                        取消下载
                      </button>
                    )}
                    <button
                      className="ghost-button"
                      disabled={importing}
                      onClick={() => upload.current?.click()}
                    >
                      补充源文件并提取
                    </button>
                    <input
                      ref={upload}
                      type="file"
                      multiple
                      hidden
                      accept=".zip,.kicad_sch,.kicad_pcb,.kicad_pro,.sch,.brd,.PrjPcb,.SchDoc,.PcbDoc,.json,.jsonl,.epro,.esch,.epcb"
                      onChange={(event) => {
                        const files = Array.from(event.target.files || []);
                        event.target.value = "";
                        if (files.length) void extract(files);
                      }}
                    />
                    {importError && (
                      <p role="alert" className="inline-error">
                        {importError}
                      </p>
                    )}
                    <small className="catalog-note">
                      只下载所选工程。解析完成后可导出 IR 或保存
                      Bundle，原工程包不在服务器长期保存。
                    </small>
                  </>
                )}
              </aside>
            )}
          </div>
        </>
      )}
    </section>
  );
}
