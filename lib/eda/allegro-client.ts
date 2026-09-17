import { zipSync } from "fflate";
import { apiFetch } from "../client-api";
import { ALLEGRO_WEB_LIMIT, boundedBody } from "../allegro-http";
import { filesToInputAssets } from "./archive";
import { ALLEGRO_MANIFEST, isAllegroBoard, readAllegroManifest } from "./allegro-format";
import type { InputAsset, ParseDiagnostic } from "./types";
import { basename, diagnostic, sha256 } from "./util";

/** Network conversion is an explicit UI intake step; the deterministic parser never fetches files. */
export async function prepareAllegroInputs(inputs: InputAsset[], active: () => boolean = () => true): Promise<{ assets: InputAsset[]; diagnostics: ParseDiagnostic[] }> {
  // An offline package already contains the conversion. Validate it in the adapter, without network calls.
  if (inputs.some(i => basename(i.path) === ALLEGRO_MANIFEST)) return { assets: inputs, diagnostics: [] };
  const assets = [...inputs];
  const diagnostics: ParseDiagnostic[] = [];
  for (const input of inputs.filter(i => /\.brd$/i.test(i.path) && isAllegroBoard(i.bytes))) {
    if (!active()) break;
    try {
      const body = zipSync({ "source.brd": input.bytes });
      if (body.length > ALLEGRO_WEB_LIMIT) throw new Error("超过在线 4 MiB 压缩传输上限，请使用本地 Allegro 转换工具生成 ZIP。");
      const response = await apiFetch("/api/allegro", { method: "POST", headers: { "Content-Type": "application/zip" }, body: new Uint8Array(body), signal: AbortSignal.timeout(165000) });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message ?? (response.status === 401 ? "请先在工作区访问密钥中填写 EDA_API_TOKEN，再使用在线 Allegro 转换。" : "在线 Allegro 转换失败，请使用本地转换工具。"));
      }
      const bytes = await boundedBody(response.body);
      const converted = await filesToInputAssets([new File([bytes], "allegro.zip")]);
      const manifestAsset = converted.assets.find(a => a.path === ALLEGRO_MANIFEST);
      if (!manifestAsset) throw new Error("转换服务没有返回来源清单。");
      const manifest = readAllegroManifest(manifestAsset.bytes);
      if (manifest.source.sha256 !== await sha256(input.bytes)) throw new Error("转换服务返回的源文件哈希不匹配。");
      const source = converted.assets.find(a => a.path === manifest.source.path);
      if (!source || await sha256(source.bytes) !== manifest.source.sha256) throw new Error("转换包缺少原文件或原文件内容不匹配。");
      const originalName = basename(input.path);
      if (converted.assets.some(a => a !== source && a.path === originalName)) throw new Error("转换文件名与原文件冲突。");
      source.path = originalName;
      manifest.source.path = originalName;
      manifestAsset.bytes = new TextEncoder().encode(JSON.stringify(manifest));
      const prefix = `${input.path}.refir/`;
      const additions = converted.assets.map(a => ({ ...a, path: prefix + a.path }));
      if (additions.some(a => assets.some(b => b.path === a.path))) throw new Error("转换文件路径与已上传文件冲突。");
      if (!active()) break;
      assets.splice(assets.indexOf(input), 1, ...additions);
      diagnostics.push(...converted.diagnostics);
    } catch (error) {
      diagnostics.push(diagnostic("ALLEGRO_ONLINE_CONVERSION_FAILED", `${input.path}：${error instanceof Error ? error.message : "转换失败"}`, "error", "unsupported"));
      // Keep the original in the manifest and let the parser report a required conversion.
    }
  }
  return { assets, diagnostics };
}
