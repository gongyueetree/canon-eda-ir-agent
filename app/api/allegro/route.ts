import { authorize, authError } from "../../../lib/auth";
import { boundedBody } from "../../../lib/allegro-http";

export const runtime = "nodejs";
export const maxDuration = 180;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const endpoint = process.env.ALLEGRO_CONVERTER_URL;
  const token = process.env.ALLEGRO_CONVERTER_TOKEN;
  const reply = (error: string, message: string, status: number) => Response.json({ error, message }, { status, headers: { "Cache-Control": "no-store" } });
  if (!endpoint || !token) return reply("ALLEGRO_CONVERTER_NOT_CONFIGURED", "在线 Allegro 转换服务未配置。请使用仓库中的 scripts/allegro-convert.py（需要 KiCad 10+）生成 ZIP 后上传。", 503);
  try { authorize(request); } catch (error) { return authError(error); }
  try {
    const url = new URL(endpoint);
    const localDev = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol !== "https:" && !localDev || url.username || url.password) throw new Error("INVALID_CONVERTER_URL");
    const body = await boundedBody(request.body);
    const upstream = await fetch(url, { method: "POST", headers: { "Content-Type": "application/zip", Authorization: `Bearer ${token}` }, body, redirect: "error", signal: AbortSignal.timeout(150000), cache: "no-store" });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return reply("ALLEGRO_CONVERSION_FAILED", upstream.status === 413 ? "转换数据超过在线 4 MiB 压缩传输上限，请使用本地转换工具。" : upstream.status === 429 ? "转换服务正忙，请稍后重试。" : "Allegro 转换失败，请检查 KiCad 版本与原文件；可用本地转换工具查看详细错误。", upstream.status === 413 ? 413 : upstream.status === 429 ? 429 : 502);
    }
    const bytes = await boundedBody(upstream.body);
    return new Response(bytes, { headers: { "Content-Type": "application/zip", "Cache-Control": "no-store" } });
  } catch (error) {
    const limit = error instanceof Error && error.message === "ALLEGRO_WEB_LIMIT";
    return reply(limit ? "ALLEGRO_WEB_LIMIT" : "ALLEGRO_CONVERSION_FAILED", limit ? "超过在线 4 MiB 压缩传输上限，请本地转换后上传 ZIP。" : "转换服务超时或不可用；原文件仍保留，可改用本地转换。", limit ? 413 : 502);
  }
}
