import test from "node:test";
import assert from "node:assert/strict";
import {
  sessionRoute,
  proxyCatalog,
  projectQuery,
} from "../lib/catalog/server";
import {
  downloadSource,
  validateDownloadUrl,
  DOWNLOAD_LIMIT,
} from "../lib/catalog/download";
import { sourceKind, safeWebUrl } from "../lib/catalog/types";
import { POST as downloadRoute } from "../app/api/catalog/projects/[id]/download/route";
import { importCatalogSource } from "../lib/catalog/client";
import { setApiToken } from "../lib/client-api";
import { filesToInputAssets, createDemoFiles } from "../lib/eda/archive";
import { parseEdaProject } from "../lib/eda/parse";
import { zipSync } from "fflate";

const id = "11111111-1111-4111-8111-111111111111";
const token = "test-workspace-secret-at-least-24";
function setup() {
  process.env.EDA_API_TOKEN = token;
  process.env.EZPLM_CATALOG_API_BASE = "https://catalog.example/api/v1";
  process.env.EZPLM_CATALOG_DOWNLOAD_HOSTS = "files.example";
}
function req(path: string, cookie = "", body?: unknown) {
  return new Request(`https://eda.example/api/catalog${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      cookie,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function login() {
  return (
    await sessionRoute(
      req("/session", "", {
        identifier: "user@example.com",
        password: "secret-pass",
      }),
    )
  ).headers
    .get("set-cookie")!
    .split(";")[0];
}

test("catalog pagination preserves opaque cursor and validates category UUID/pageSize", () => {
  const cursor = "a+b/=汉字";
  const q = projectQuery(
    `https://eda.example/?categoryId=uncategorized&keyword=sensor&cursor=${encodeURIComponent(cursor)}&pageSize=20`,
  );
  const parsed = new URLSearchParams(q);
  assert.equal(parsed.get("cursor"), cursor);
  assert.equal(parsed.get("categoryId"), "uncategorized");
  assert.throws(() => projectQuery("https://eda.example/?pageSize=0"));
  assert.throws(() => projectQuery("https://eda.example/?pageSize=1.2"));
  assert.throws(() => projectQuery("https://eda.example/?categoryId=电源"));
});

test("viewers and unsafe URLs cannot masquerade as source archives", () => {
  setup();
  assert.equal(
    sourceKind("https://view.example/viewer?file=https://files.example/a.zip"),
    "page",
  );
  assert.equal(sourceKind("https://github.com/org/board"), "github");
  assert.equal(
    sourceKind("https://files.example/project.zip?signature=x"),
    "file",
  );
  assert.equal(safeWebUrl("javascript:alert(1)"), undefined);
  for (const url of [
    "http://files.example/a.zip",
    "https://files.example.evil/a.zip",
    "https://files.example:8443/a.zip",
    "https://user:pass@files.example/a.zip",
    "https://127.0.0.1/a.zip",
  ])
    assert.throws(() => validateDownloadUrl(url));
});

test("workspace gate, encrypted connection cookie, no bearer exposed, single refresh/retry", async () => {
  setup();
  const original = globalThis.fetch;
  let refreshCount = 0;
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.endsWith("/auth/login"))
      return Response.json({
        data: { accessToken: "old-secret", refreshToken: "refresh-secret" },
      });
    if (s.endsWith("/auth/refresh")) {
      refreshCount++;
      return Response.json({
        data: { accessToken: "new-secret", refreshToken: "new-refresh" },
      });
    }
    if (new Headers(init?.headers).get("authorization") === "Bearer old-secret")
      return Response.json({ error: {} }, { status: 401 });
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer new-secret",
    );
    return Response.json({ data: [] });
  };
  try {
    assert.equal(
      (
        await sessionRoute(
          new Request("https://eda.example/api/catalog/session"),
        )
      ).status,
      401,
    );
    const response = await sessionRoute(
      req("/session", "", {
        identifier: "user@example.com",
        password: "secret-pass",
      }),
    );
    assert.deepEqual(await response.json(), { connected: true });
    const header = response.headers.get("set-cookie")!;
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    assert.ok(!header.includes("old-secret"));
    const cookie = header.split(";")[0];
    const results = await Promise.all([
      proxyCatalog(req("/categories", cookie), "/catalog/categories"),
      proxyCatalog(req("/projects", cookie), "/catalog/projects"),
    ]);
    assert.equal(refreshCount, 1);
    for (const result of results) {
      assert.equal(result.status, 200);
      assert.ok(result.headers.get("set-cookie"));
    }
    const bad = await proxyCatalog(
      req("/categories", `${cookie}x`),
      "/catalog/categories",
    );
    assert.equal(bad.status, 401);
    const loggedOut = await sessionRoute(
      new Request("https://eda.example/api/catalog/session", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}`, cookie },
      }),
    );
    assert.match(loggedOut.headers.get("set-cookie")!, /Max-Age=0/);
  } finally {
    globalThis.fetch = original;
  }
});

test("403 and 429 do not refresh; status, requestId and retry information survive", async () => {
  setup();
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/auth/login"))
      return Response.json({
        data: { accessToken: "access", refreshToken: "refresh-errors" },
      });
    count++;
    return Response.json(
      {
        error: { message: "secret upstream details" },
        meta: { requestId: "request-42" },
      },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  };
  try {
    const cookie = await login();
    const response = await proxyCatalog(
      req("/categories", cookie),
      "/catalog/categories",
    );
    assert.equal(response.status, 429);
    assert.equal(count, 1);
    assert.equal(response.headers.get("Retry-After"), "60");
    const data = await response.json();
    assert.equal(data.requestId, "request-42");
    assert.ok(!data.error.includes("secret"));
  } finally {
    globalThis.fetch = original;
  }
});

test("download validates every redirect, rejects HTML and enforces streaming size limit", async () => {
  setup();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://127.0.0.1/internal.zip" },
      });
    await assert.rejects(
      downloadSource("https://files.example/a.zip"),
      /下载域名/,
    );
    globalThis.fetch = async () =>
      new Response("<html>login</html>", {
        headers: { "Content-Type": "text/html" },
      });
    await assert.rejects(downloadSource("https://files.example/a.zip"), /网页/);
    globalThis.fetch = async () =>
      new Response("x", {
        headers: { "Content-Length": String(DOWNLOAD_LIMIT + 1) },
      });
    await assert.rejects(
      downloadSource("https://files.example/a.zip"),
      /75 MB/,
    );
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(DOWNLOAD_LIMIT + 1));
            c.close();
          },
        }),
      );
    const result = await downloadSource("https://files.example/a.zip");
    await assert.rejects(result.arrayBuffer(), /DOWNLOAD_TOO_LARGE/);
  } finally {
    globalThis.fetch = original;
  }
});

test("GitHub source resolves an immutable commit and records revision", async () => {
  setup();
  const original = globalThis.fetch;
  const sha = "a".repeat(40);
  const urls: string[] = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    if (String(url).endsWith("/org/board"))
      return Response.json({ default_branch: "main" });
    if (String(url).includes("/commits/")) return Response.json({ sha });
    return new Response("zip");
  };
  try {
    const response = await downloadSource("https://github.com/org/board");
    assert.equal(response.headers.get("X-EDA-Revision"), sha);
    assert.equal(
      urls.at(-1),
      `https://codeload.github.com/org/board/zip/${sha}`,
    );
    await response.arrayBuffer();
  } finally {
    globalThis.fetch = original;
  }
});

test("catalog source -> authenticated download -> browser intake -> real KiCad IR", async () => {
  setup();
  const original = globalThis.fetch;
  const demo = createDemoFiles();
  const entries: Record<string, Uint8Array> = {};
  for (const f of demo) entries[f.name] = new Uint8Array(await f.arrayBuffer());
  const bytes = zipSync(entries);
  const project = {
    id,
    name: "Reference sensor",
    description: null,
    imageUrl: null,
  };
  const ecad = {
    bomId: "22222222-2222-4222-8222-222222222222",
    name: "Reference sensor",
    description: null,
    sourceLinks: [
      {
        name: "Sources",
        url: "https://files.example/project.zip?signature=private",
      },
    ],
    ecadUrl: null,
    altiumUrl: null,
    hasNetlist: true,
  };
  let cookie = "";
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith("/api/catalog/"))
      return downloadRoute(
        req(`/projects/${id}/download`, cookie, JSON.parse(String(init?.body))),
        { params: Promise.resolve({ id }) },
      );
    if (s.endsWith("/auth/login"))
      return Response.json({
        data: {
          accessToken: "access-download",
          refreshToken: "refresh-download",
        },
      });
    if (s.endsWith("/ecad")) return Response.json({ data: ecad });
    assert.equal(s, ecad.sourceLinks[0].url);
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    return new Response(bytes);
  };
  try {
    cookie = await login();
    setApiToken(token);
    const invalid = await downloadRoute(
      req(`/projects/${id}/download`, cookie, {
        sourceIndex: 9,
        url: "https://evil.example/a.zip",
      }),
      { params: Promise.resolve({ id }) },
    );
    assert.equal(invalid.status, 404);
    const result = await importCatalogSource(
      project,
      ecad,
      [0],
      new AbortController().signal,
    );
    assert.equal(result.provenance.projectId, id);
    assert.notEqual(result.provenance.bomId, id);
    assert.match(result.provenance.files[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(
      result.provenance.files[0].sourceUrl,
      "https://files.example/project.zip",
    );
    const intake = await filesToInputAssets(result.files);
    const bundle = await parseEdaProject(intake.assets, intake.diagnostics);
    assert.ok(bundle.schematics.length);
    assert.ok(bundle.pcbs.length);
    assert.equal(bundle.parts.length, 2);
  } finally {
    globalThis.fetch = original;
    setApiToken("");
  }
});
