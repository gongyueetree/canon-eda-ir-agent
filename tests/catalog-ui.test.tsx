import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { OpenSourceCatalog } from "../components/OpenSourceCatalog";
import type { CatalogProvenance } from "../lib/catalog/types";

const categoryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const project = {
  id: projectId,
  name: "Sensor A",
  description: "Reference board",
  imageUrl: null,
};
const ecad = {
  bomId: secondId,
  name: "Sensor",
  description: null,
  sourceLinks: [
    { name: "Project ZIP", url: "https://files.example/project.zip" },
  ],
  ecadUrl: null,
  altiumUrl: null,
  hasNetlist: true,
};
async function mount(
  fetcher: typeof fetch,
  onImport: (
    files: File[],
    source: CatalogProvenance,
  ) => Promise<void> = async () => {},
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://eda.example",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<OpenSourceCatalog onImport={onImport} />));
  return {
    dom,
    close: async () => {
      await act(async () => root.unmount());
      globalThis.fetch = original;
      dom.window.close();
    },
  };
}
async function click(text: string) {
  const buttons = [...document.querySelectorAll("button")];
  const button =
    buttons.find((b) => b.textContent === text) ||
    buttons.find((b) => b.textContent?.includes(text));
  assert.ok(button, text);
  await act(async () => button.click());
}
function initial(url: string) {
  if (url.endsWith("/session")) return Response.json({ connected: true });
  if (url.endsWith("/categories"))
    return Response.json({
      data: [
        { id: categoryId, name: "传感器", projectCount: 31, children: [] },
      ],
    });
}

test("category UUID and opaque cursor are used, filter persists across pages", async () => {
  const calls: string[] = [];
  const cursor = "next+/=cursor";
  const harness = await mount(async (input) => {
    const s = String(input);
    calls.push(s);
    const response = initial(s);
    if (response) return response;
    const q = new URL(s, "https://eda.example").searchParams;
    return Response.json({
      data: q.has("cursor")
        ? [{ ...project, id: secondId, name: "Sensor B" }]
        : [project],
      meta: {
        hasMore: !q.has("cursor"),
        nextCursor: q.has("cursor") ? null : cursor,
      },
    });
  });
  try {
    await click("传感器");
    await click("加载更多");
    assert.equal(document.querySelectorAll(".catalog-card").length, 2);
    const last = new URL(calls.at(-1)!, "https://eda.example");
    assert.equal(last.searchParams.get("categoryId"), categoryId);
    assert.equal(last.searchParams.get("cursor"), cursor);
    assert.ok(!last.searchParams.has("page"));
    assert.ok(
      ![...document.querySelectorAll("button")].some(
        (b) => b.textContent === "加载更多",
      ),
    );
  } finally {
    await harness.close();
  }
});

test("viewer-only project has upload fallback and cannot falsely extract IR", async () => {
  let imports = 0;
  const harness = await mount(
    async (input) => {
      const s = String(input);
      const response = initial(s);
      if (response) return response;
      if (s.endsWith("/ecad"))
        return Response.json({
          data: {
            ...ecad,
            sourceLinks: [
              { name: "Viewer", url: "https://viewer.example/?file=a.zip" },
            ],
            ecadUrl: "https://viewer.example/board",
          },
        });
      return Response.json({
        data: [project],
        meta: { hasMore: false, nextCursor: null },
      });
    },
    async () => {
      imports++;
    },
  );
  try {
    await click("Sensor A");
    const extract = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "提取 IR",
    )!;
    assert.equal(extract.disabled, true);
    assert.ok(document.body.textContent!.includes("补充源文件并提取"));
    assert.equal(
      document.querySelector('a[href="https://viewer.example/board"]')
        ?.textContent,
      "打开 ECAD 预览 ↗",
    );
    await act(async () => extract.click());
    assert.equal(imports, 0);
  } finally {
    await harness.close();
  }
});

test("select project and extract passes downloaded file and provenance to existing parser", async () => {
  let imported: { files: File[]; provenance: CatalogProvenance } | undefined;
  const harness = await mount(
    async (input, init) => {
      const s = String(input);
      const response = initial(s);
      if (response) return response;
      if (s.endsWith("/ecad")) return Response.json({ data: ecad });
      if (s.endsWith("/download")) {
        assert.equal(JSON.parse(String(init?.body)).sourceIndex, 0);
        return new Response("test-project-bytes", {
          headers: {
            "X-EDA-Filename": "sensor.zip",
            "X-EDA-Source": encodeURIComponent(ecad.sourceLinks[0].url),
          },
        });
      }
      return Response.json({
        data: [project],
        meta: { hasMore: false, nextCursor: null },
      });
    },
    async (files, provenance) => {
      imported = { files, provenance };
    },
  );
  try {
    await click("Sensor A");
    await click("提取 IR");
    // WebCrypto completes outside React's microtask queue.
    for (let i = 0; i < 20 && !imported; i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    assert.ok(imported);
    assert.equal(imported.files[0].name, "sensor.zip");
    assert.equal(await imported.files[0].text(), "test-project-bytes");
    assert.equal(imported.provenance.projectId, projectId);
    assert.equal(imported.provenance.bomId, secondId);
  } finally {
    await harness.close();
  }
});
