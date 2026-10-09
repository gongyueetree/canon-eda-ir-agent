import { apiFetch } from "../client-api";
import type { CatalogEcad, CatalogProject, CatalogProvenance } from "./types";
// One request at a time also prevents rotating-refresh races across serverless instances.
// Web Locks shares this ordering across tabs where available; the promise covers older browsers.
let pending: Promise<unknown> = Promise.resolve();
function withCatalogLock<T>(run: () => Promise<T>): Promise<T> {
  const task: Promise<T> = pending
    .catch(() => {})
    .then(async (): Promise<T> => {
      if (typeof navigator !== "undefined" && navigator.locks)
        return await navigator.locks.request("eda-catalog-auth", run);
      return await run();
    });
  pending = task.catch(() => {});
  return task;
}
export function catalogJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return withCatalogLock(async () => {
    init.signal?.throwIfAborted();
    const response = await apiFetch(`/api/catalog${path}`, {
      ...init,
      cache: "no-store",
    });
    const value = await response.json();
    if (!response.ok)
      throw new Error(
        `${typeof value.error === "string" ? value.error : "目录请求失败"}${value.requestId ? `（请求 ${value.requestId}）` : ""}`,
      );
    return value as T;
  });
}
export async function importCatalogSource(
  project: CatalogProject,
  ecad: CatalogEcad,
  indices: number[],
  signal: AbortSignal,
) {
  const files: File[] = [];
  const records: CatalogProvenance["files"] = [];
  let total = 0;
  // Sequential transfers avoid token refresh races, excess memory and upstream bursts.
  for (const sourceIndex of indices) {
    const response = await withCatalogLock(async () => {
      signal.throwIfAborted();
      return apiFetch(
        `/api/catalog/projects/${encodeURIComponent(project.id)}/download`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceIndex }),
          signal,
        },
      );
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "工程下载失败。");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("来源没有返回文件。");
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        total += value.byteLength;
        if (size > 75 * 1024 * 1024 || total > 150 * 1024 * 1024)
          throw new Error("下载文件过大，请分批导入。");
        chunks.push(new Uint8Array(value));
      }
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    }
    if (!size) throw new Error("来源文件为空。");
    const name = decodeURIComponent(
      response.headers.get("X-EDA-Filename") || "project.zip",
    );
    if (files.some((f) => f.name === name))
      throw new Error(
        "所选来源包含同名文件，请分别导入或将完整工程打包后上传。",
      );
    const file = new File(chunks, name, { type: "application/octet-stream" });
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await file.arrayBuffer(),
    );
    const sha256 = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    records.push({
      name,
      sha256,
      sourceUrl: decodeURIComponent(response.headers.get("X-EDA-Source") || ""),
      revision: response.headers.get("X-EDA-Revision") || undefined,
    });
    files.push(file);
  }
  if (!files.length) throw new Error("请选择至少一个可下载的工程来源。");
  return {
    files,
    provenance: {
      provider: "ezplm",
      projectId: project.id,
      bomId: ecad.bomId,
      projectName: project.name,
      importedAt: new Date().toISOString(),
      method: "source_download",
      files: records,
    } satisfies CatalogProvenance,
  };
}
