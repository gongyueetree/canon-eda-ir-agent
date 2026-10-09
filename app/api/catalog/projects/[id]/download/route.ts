import { authorize } from "../../../../../../lib/auth";
import {
  catalogRequest,
  validProjectId,
  catalogError,
  CatalogError,
} from "../../../../../../lib/catalog/server";
import { downloadSource } from "../../../../../../lib/catalog/download";
import type { CatalogEcad } from "../../../../../../lib/catalog/types";
export const runtime = "nodejs";
export const maxDuration = 180;
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let setCookie: string | undefined;
  try {
    authorize(request);
    const id = validProjectId((await params).id);
    const { sourceIndex } = await request.json();
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0)
      throw new CatalogError(400, "请选择一个工程来源。");
    const result = await catalogRequest(
      request,
      `/catalog/projects/${id}/ecad`,
    );
    setCookie = result.setCookie;
    const ecad = (result.value as { data?: CatalogEcad }).data;
    const link = ecad?.sourceLinks?.[sourceIndex];
    if (!link || typeof link.url !== "string")
      throw new CatalogError(404, "工程来源不存在，请刷新项目资料。");
    const response = await downloadSource(link.url, request.signal);
    if (setCookie) response.headers.set("Set-Cookie", setCookie);
    return response;
  } catch (e) {
    const response = catalogError(e);
    if (setCookie) response.headers.set("Set-Cookie", setCookie);
    return response;
  }
}
