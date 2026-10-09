import { CatalogError } from "./server";
import { publicSourceUrl, sourceKind } from "./types";
export const DOWNLOAD_LIMIT = 75 * 1024 * 1024;
const BUILTIN_HOSTS = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
];
export function validateDownloadUrl(value: string): URL {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new CatalogError(400, "来源链接无效。");
  }
  const allowed = [
    ...BUILTIN_HOSTS,
    ...(process.env.EZPLM_CATALOG_DOWNLOAD_HOSTS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ];
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    !allowed.includes(u.hostname.toLowerCase())
  )
    throw new CatalogError(
      422,
      "此下载域名尚未获准。请由管理员配置 EZPLM_CATALOG_DOWNLOAD_HOSTS，或下载工程后在下方上传。",
    );
  return u;
}
// Exact, administrator-controlled host allowlist. Never forward catalog authorization to file hosts.
async function fetchSource(
  value: string,
  signal: AbortSignal,
): Promise<Response> {
  let url = value;
  for (let redirects = 0; redirects <= 4; redirects++) {
    const u = validateDownloadUrl(url);
    let response: Response;
    try {
      response = await fetch(u, {
        redirect: "manual",
        signal,
        headers: {
          Accept: "application/octet-stream, application/json",
          "User-Agent": "EDAIR-Catalog",
        },
        cache: "no-store",
      });
    } catch {
      throw new CatalogError(
        502,
        "工程下载失败或超时，请稍后重试或上传源文件。",
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) break;
      url = new URL(location, u).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CatalogError(
        response.status === 429 ? 429 : 502,
        `工程来源返回 HTTP ${response.status}，请检查来源链接。`,
      );
    }
    return response;
  }
  throw new CatalogError(502, "工程来源重定向过多。");
}
export async function downloadSource(
  value: string,
  requestSignal?: AbortSignal,
) {
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, AbortSignal.timeout(120000)])
    : AbortSignal.timeout(120000);
  let url = value;
  let revision: string | undefined;
  let name: string;
  const kind = sourceKind(value);
  if (kind === "page")
    throw new CatalogError(
      422,
      "此链接是资料或查看器页面，无法作为工程文件解析。请补充源工程 ZIP。",
    );
  const u = validateDownloadUrl(value);
  if (kind === "github") {
    const [owner, repo] = u.pathname.split("/").filter(Boolean);
    const repository = repo.replace(/\.git$/, "");
    const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
    const info = await (await fetchSource(api, signal)).json();
    if (typeof info.default_branch !== "string")
      throw new CatalogError(502, "无法确定 GitHub 默认分支。");
    const head = await (
      await fetchSource(
        `${api}/commits/${encodeURIComponent(info.default_branch)}`,
        signal,
      )
    ).json();
    if (typeof head.sha !== "string" || !/^[0-9a-f]{40}$/i.test(head.sha))
      throw new CatalogError(502, "无法确定 GitHub 工程版本。");
    revision = head.sha;
    url = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/zip/${revision}`;
    name = `${repository}-${revision!.slice(0, 12)}.zip`;
  } else {
    // GitHub blob links refer to HTML, so explicitly use the raw endpoint.
    if (
      u.hostname === "github.com" &&
      /^\/[^/]+\/[^/]+\/blob\//.test(u.pathname)
    )
      url = `https://raw.githubusercontent.com${u.pathname.replace("/blob/", "/")}`;
    try {
      name = decodeURIComponent(
        new URL(url).pathname.split("/").pop() || "project.zip",
      );
    } catch {
      name = "project.zip";
    }
  }
  name = name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 200);
  const upstream = await fetchSource(url, signal);
  const type = upstream.headers.get("content-type") || "";
  if (/text\/html|application\/xhtml/i.test(type)) {
    await upstream.body?.cancel();
    throw new CatalogError(
      422,
      "来源返回了网页而非工程文件，请使用直接下载链接或上传源工程。",
    );
  }
  if (Number(upstream.headers.get("content-length")) > DOWNLOAD_LIMIT) {
    await upstream.body?.cancel();
    throw new CatalogError(413, "工程包超过 75 MB，请下载后拆分导入。");
  }
  if (!upstream.body) throw new CatalogError(502, "来源未返回工程文件。");
  const reader = upstream.body.getReader();
  let bytes = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          if (!bytes) throw new Error("EMPTY_DOWNLOAD");
          controller.close();
          return;
        }
        bytes += result.value.byteLength;
        if (bytes > DOWNLOAD_LIMIT) {
          await reader.cancel();
          throw new Error("DOWNLOAD_TOO_LARGE");
        }
        controller.enqueue(result.value);
      } catch (e) {
        controller.error(e);
        await reader.cancel().catch(() => {});
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-EDA-Filename": encodeURIComponent(name),
    "X-EDA-Source": encodeURIComponent(publicSourceUrl(value)),
  });
  if (revision) headers.set("X-EDA-Revision", revision);
  return new Response(stream, { headers });
}
