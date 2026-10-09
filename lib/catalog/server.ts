import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { authorize } from "../auth";

const COOKIE = "eda_catalog_session";
const TTL = 8 * 60 * 60;
type Session = {
  accessToken: string;
  refreshToken: string;
  expires: number;
  scope: string;
};
export class CatalogError extends Error {
  constructor(
    public status: number,
    message: string,
    public requestId?: string,
    public retryAfter?: string,
  ) {
    super(message);
  }
}
export function catalogBase(): string {
  const raw = process.env.EZPLM_CATALOG_API_BASE;
  if (!raw)
    throw new CatalogError(
      503,
      "请在部署中配置 EZPLM_CATALOG_API_BASE（以 /api/v1 结尾）。",
    );
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !/\/api\/v1\/?$/.test(u.pathname)
  )
    throw new CatalogError(
      503,
      "EZPLM_CATALOG_API_BASE 必须是 HTTPS API 基址并以 /api/v1 结尾。",
    );
  return u.href.replace(/\/$/, "");
}
function key() {
  return createHash("sha256")
    .update(`catalog-v1:${process.env.EDA_API_TOKEN}`)
    .digest();
}
function scope() {
  return `${catalogBase()}|${process.env.EDA_WORKSPACE_ID || "gongyueetree"}`;
}
function seal(session: Session): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const content = Buffer.concat([
    cipher.update(JSON.stringify(session)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), content]).toString(
    "base64url",
  );
}
function readSession(request: Request): Session | undefined {
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!raw || raw.length > 12000) return;
  try {
    const bytes = Buffer.from(raw, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(),
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    const value = JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString(),
    ) as Session;
    if (
      value.expires > Date.now() &&
      value.scope === scope() &&
      value.accessToken &&
      value.refreshToken
    )
      return value;
  } catch {
    return;
  }
}
function cookie(request: Request, value: string, age: number) {
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/api/catalog; Max-Age=${age}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export function catalogResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
export function catalogError(error: unknown): Response {
  if (error instanceof CatalogError) {
    const response = catalogResponse(
      { error: error.message, requestId: error.requestId },
      error.status,
    );
    if (error.retryAfter && /^\d{1,6}$/.test(error.retryAfter))
      response.headers.set("Retry-After", error.retryAfter);
    return response;
  }
  const message = error instanceof Error ? error.message : "";
  if (message === "UNAUTHORIZED")
    return catalogResponse({ error: "请先填写 EDAIR 工作区访问密钥。" }, 401);
  if (message === "AUTH_NOT_CONFIGURED")
    return catalogResponse(
      { error: "部署尚未配置 EDA_API_TOKEN（至少 24 字符）。" },
      503,
    );
  return catalogResponse({ error: "目录请求失败，请稍后重试。" }, 502);
}
async function upstream(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${catalogBase()}${path}`, {
      ...init,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
      headers: { "x-lang": "zh-CN", ...init.headers },
    });
  } catch (e) {
    if (e instanceof CatalogError) throw e;
    throw new CatalogError(502, "无法连接 ezPLM，请检查 API 基址或稍后重试。");
  }
}
async function jsonResponse(response: Response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: "ezPLM 请求参数无效。",
      401: "ezPLM 登录已失效，请重新连接。",
      403: "当前 ezPLM 账号无权访问此资源。",
      404: "工程不存在或没有可访问的 ECAD 资料。",
      429: "ezPLM 请求过于频繁，请稍后重试。",
    };
    throw new CatalogError(
      response.status >= 500 ? 502 : response.status,
      messages[response.status] || "ezPLM 请求失败。",
      typeof data?.meta?.requestId === "string"
        ? data.meta.requestId
        : undefined,
      response.headers.get("retry-after") || undefined,
    );
  }
  if (!data || typeof data !== "object")
    throw new CatalogError(502, "ezPLM 响应格式无效。");
  return data;
}
function tokens(value: unknown): { accessToken: string; refreshToken: string } {
  const v = value as {
    data?: { accessToken?: unknown; refreshToken?: unknown };
  };
  if (
    typeof v?.data?.accessToken !== "string" ||
    typeof v?.data?.refreshToken !== "string" ||
    !v.data.accessToken ||
    !v.data.refreshToken
  )
    throw new CatalogError(502, "ezPLM 未返回有效登录凭据。");
  return { accessToken: v.data.accessToken, refreshToken: v.data.refreshToken };
}
export async function sessionRoute(request: Request): Promise<Response> {
  try {
    authorize(request);
    catalogBase();
    if (request.method === "DELETE") {
      const r = catalogResponse({ connected: false });
      r.headers.set("Set-Cookie", cookie(request, "", 0));
      return r;
    }
    if (request.method === "GET")
      return catalogResponse({
        configured: true,
        connected: Boolean(readSession(request)),
      });
    const body = await request.json();
    if (
      typeof body.identifier !== "string" ||
      !body.identifier.trim() ||
      body.identifier.length > 255 ||
      typeof body.password !== "string" ||
      body.password.length < 6 ||
      body.password.length > 1024
    )
      throw new CatalogError(400, "请输入有效账号和至少 6 位密码。");
    const value = tokens(
      await jsonResponse(
        await upstream("/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identifier: body.identifier.trim(),
            password: body.password,
          }),
        }),
      ),
    );
    const sealed = seal({
      ...value,
      expires: Date.now() + TTL * 1000,
      scope: scope(),
    });
    if (sealed.length > 3700)
      throw new CatalogError(
        502,
        "授权凭据超过会话容量，请联系管理员配置服务端会话存储。",
      );
    const r = catalogResponse({ connected: true });
    r.headers.set("Set-Cookie", cookie(request, sealed, TTL));
    return r;
  } catch (e) {
    return catalogError(e);
  }
}
// Coalesce refreshes within this worker; cache rotated tokens briefly for concurrent requests.
const refreshes = new Map<
  string,
  {
    until: number;
    promise: Promise<{ accessToken: string; refreshToken: string }>;
  }
>();
async function refresh(session: Session) {
  const id = createHash("sha256").update(session.refreshToken).digest("hex");
  for (const [k, v] of refreshes) if (v.until < Date.now()) refreshes.delete(k);
  const found = refreshes.get(id);
  if (found) return found.promise;
  if (refreshes.size >= 128)
    throw new CatalogError(429, "连接繁忙，请稍后重试。");
  const promise = (async () =>
    tokens(
      await jsonResponse(
        await upstream("/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        }),
      ),
    ))();
  refreshes.set(id, { until: Date.now() + 30000, promise });
  return promise;
}
export async function catalogRequest(
  request: Request,
  path: string,
): Promise<{ value: unknown; setCookie?: string }> {
  authorize(request);
  const session = readSession(request);
  if (!session) throw new CatalogError(401, "请先连接您的 ezPLM 账号。");
  let response = await upstream(path, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  let setCookie: string | undefined;
  if (response.status === 401) {
    await response.body?.cancel();
    const rotated = await refresh(session);
    Object.assign(session, rotated);
    setCookie = cookie(
      request,
      seal(session),
      Math.max(1, Math.floor((session.expires - Date.now()) / 1000)),
    );
    response = await upstream(path, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
  }
  return { value: await jsonResponse(response), setCookie };
}
export function validProjectId(id: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw new CatalogError(400, "项目 ID 必须是目录返回的 UUID。");
  return id;
}
export function projectQuery(url: string) {
  const input = new URL(url).searchParams;
  const out = new URLSearchParams();
  const category = input.get("categoryId");
  if (category)
    out.set(
      "categoryId",
      category === "uncategorized" ? category : validProjectId(category),
    );
  for (const [key, max] of [
    ["keyword", 500],
    ["cursor", 4096],
  ] as const) {
    const value = input.get(key);
    if (value) {
      if (value.length > max) throw new CatalogError(400, `${key} 过长。`);
      out.set(key, value);
    }
  }
  const size = input.get("pageSize") || "20";
  if (!/^\d+$/.test(size) || Number(size) < 1 || Number(size) > 100)
    throw new CatalogError(400, "pageSize 必须是 1–100 的整数。");
  out.set("pageSize", size);
  return out.toString();
}
export async function proxyCatalog(request: Request, path: string) {
  try {
    const result = await catalogRequest(request, path);
    const r = catalogResponse(result.value);
    if (result.setCookie) r.headers.set("Set-Cookie", result.setCookie);
    return r;
  } catch (e) {
    return catalogError(e);
  }
}
