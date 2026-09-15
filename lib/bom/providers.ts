/** Read-only adapters based on gongyueetree/bom2buy. No mock fallback; no supplier prices required for identity. */
import {
  createCipheriv,
  createHash,
  createHmac,
  randomUUID,
} from "node:crypto";
import type { PartCandidate, Provider, Probe } from "./types";
// Upstream JSON is untrusted; access through bounded object/list helpers.
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string =>
  typeof v === "string"
    ? v.trim()
    : typeof v === "number"
      ? String(v)
      : textPrimitive(
          obj(v).name ??
            obj(v).Name ??
            obj(v).value ??
            obj(v).Value ??
            obj(v).title,
        );
const textPrimitive = (v: unknown) => (typeof v === "string" ? v.trim() : "");
export function providerStatus() {
  return (["ezplm", "iceasy", "digikey", "mouser"] as Provider[]).map(
    (source) => ({
      source,
      configured:
        source === "ezplm"
          ? !!(process.env.EZPLM_API_BASE && process.env.EZPLM_API_KEY)
          : source === "iceasy"
            ? !!(process.env.ICEASY_ACCOUNT && process.env.ICEASY_PASSWORD)
            : source === "digikey"
              ? !!(
                  process.env.DIGIKEY_CLIENT_ID &&
                  process.env.DIGIKEY_CLIENT_SECRET
                ) && process.env.DIGIKEY_MOCK !== "true"
              : !!process.env.MOUSER_API_KEY,
    }),
  );
}
async function json(
  url: string,
  init: RequestInit = {},
  timeout = 8000,
): Promise<Obj> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "请求限流，请稍后重试"
        : `HTTP ${response.status}${[401, 403].includes(response.status) ? "：鉴权或访问权限失败" : ""}`,
    );
  const body = await response.text();
  if (body.length > 4_000_000) throw new Error("响应过大");
  const parsed: unknown = JSON.parse(body);
  return Array.isArray(parsed) ? { data: parsed } : obj(parsed);
}
function result(source: Provider, p: Obj): PartCandidate | null {
  let mpn = "",
    manufacturer = "",
    description = "",
    pkg = "",
    url = "";
  if (source === "ezplm") {
    mpn = text(p.mpn ?? p.MPN ?? p.partNumber);
    manufacturer = text(p.manufacturer ?? p.mfr);
    description = text(p.description ?? p.desc);
    pkg = text(p.footprint);
    url = text(p.officialUrl);
  }
  if (source === "iceasy") {
    mpn = text(p.partNo);
    manufacturer = text(p.linecard ?? p.linecardCn);
    description = text(p.description);
    pkg = text(p.package);
    url = text(p.url);
  }
  if (source === "digikey") {
    mpn = text(p.ManufacturerProductNumber ?? p.ManufacturerPartNumber);
    manufacturer = text(p.Manufacturer);
    description = text(
      obj(p.Description).ProductDescription ?? p.ProductDescription,
    );
    pkg = text(
      obj(
        arr(p.Parameters).find((v) =>
          /supplier device package|package \/ case/i.test(
            text(obj(v).ParameterText),
          ),
        ),
      ).ValueText,
    );
    url = text(p.ProductUrl);
  }
  if (source === "mouser") {
    mpn = text(p.ManufacturerPartNumber);
    manufacturer = text(p.Manufacturer);
    description = text(p.Description);
    pkg = text(
      obj(
        arr(p.ProductAttributes).find((v) =>
          /package.*case|case.*package/i.test(text(obj(v).AttributeName)),
        ),
      ).AttributeValue,
    );
    url = text(p.ProductDetailUrl);
  }
  if (!mpn) return null;
  return {
    source,
    mpn: mpn.slice(0, 200),
    manufacturer: manufacturer.slice(0, 200),
    description: description.slice(0, 1000),
    package: pkg.slice(0, 300),
    url: /^https?:\/\//i.test(url) ? url : undefined,
    fetchedAt: new Date().toISOString(),
  };
}
export function mapResponse(source: Provider, data: Obj): PartCandidate[] {
  let rows: unknown[] = [];
  if (
    source === "ezplm" &&
    (data.success === false ||
      data.error ||
      !(
        Array.isArray(data.data) ||
        Array.isArray(obj(data.data).list) ||
        Array.isArray(data.items)
      ))
  )
    throw new Error("ezPLM 响应格式或业务状态错误");
  if (source === "ezplm")
    rows = arr(data.data).length
      ? arr(data.data)
      : arr(obj(data.data).list).length
        ? arr(obj(data.data).list)
        : arr(data.items);
  if (source === "iceasy") {
    const code = text(data.code);
    if (code && !["0", "100", "200"].includes(code))
      throw new Error(
        `Iceasy 业务错误 ${code}（请核对账号、IP 白名单或代理配置）`,
      );
    if (!Array.isArray(obj(data.data).rows))
      throw new Error("Iceasy 响应缺少 data.rows");
    rows = arr(obj(data.data).rows);
  }
  if (source === "digikey")
    rows = [...arr(data.ExactMatches), ...arr(data.Products)];
  if (source === "mouser") {
    if (arr(data.Errors).length)
      throw new Error("Mouser 业务错误，请核对 API Key 和额度");
    rows = arr(obj(data.SearchResults).Parts);
  }
  return rows
    .slice(0, 20)
    .map((v) => result(source, obj(v)))
    .filter((p): p is PartCandidate => !!p);
}
export function ezplmHeaders(
  path: string,
  query: string,
  timestamp = String(Math.floor(Date.now() / 1000)),
  nonce: string = randomUUID(),
) {
  const encoding = process.env.EZPLM_SIGN_ENCODING;
  const digest =
    encoding === "hex" || encoding === "base64" ? encoding : "base64url";
  const signature = createHmac(
    "sha256",
    process.env.EZPLM_API_SECRET || process.env.EZPLM_API_KEY || "",
  )
    .update(
      ["GET", path, query, timestamp, nonce].join(
        process.env.EZPLM_SIGN_DELIMITER ?? "\n",
      ),
    )
    .digest(digest);
  return {
    "X-API-Key": process.env.EZPLM_API_KEY || "",
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Signature": signature,
    Accept: "application/json",
  };
}
export function iceasyAuth(account: string, password: string, date: string) {
  const keyText = createHash("md5")
    .update(account + date)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(keyText), null);
  return Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final(),
  ]).toString("base64");
}
let tokenCache: { key: string; token: string; expiry: number } | undefined;
let tokenPromise: Promise<string> | undefined;
async function digiToken(base: string) {
  const key =
    base +
    "|" +
    process.env.DIGIKEY_CLIENT_ID +
    "|" +
    process.env.DIGIKEY_CLIENT_SECRET;
  if (tokenCache?.key === key && tokenCache.expiry > Date.now() + 60000)
    return tokenCache.token;
  if (!tokenPromise)
    tokenPromise = (async () => {
      const data = await json(base + "/v1/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: process.env.DIGIKEY_CLIENT_ID || "",
          client_secret: process.env.DIGIKEY_CLIENT_SECRET || "",
        }),
      });
      const token = text(data.access_token);
      if (!token) throw new Error("DigiKey OAuth 返回缺少 token");
      tokenCache = {
        key,
        token,
        expiry: Date.now() + Number(data.expires_in ?? 600) * 1000,
      };
      return token;
    })().finally(() => {
      tokenPromise = undefined;
    });
  return tokenPromise;
}
const searchCache = new Map<
  string,
  { expires: number; hits: PartCandidate[] }
>();
export async function searchProvider(
  source: Provider,
  keyword: string,
): Promise<{ hits: PartCandidate[]; probe: Probe }> {
  if (!providerStatus().find((p) => p.source === source)?.configured)
    return { hits: [], probe: { source, status: "NOT_CONFIGURED", count: 0 } };
  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify([
        source,
        keyword,
        ...Object.entries(process.env)
          .filter(([k]) => /^(EZPLM|ICEASY|DIGIKEY|MOUSER)_/.test(k))
          .sort(),
      ]),
    )
    .digest("hex");
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expires > Date.now())
    return {
      hits: cached.hits,
      probe: {
        source,
        status: "OK",
        count: cached.hits.length,
        message: "近期查询缓存",
      },
    };
  try {
    let data: Obj;
    if (source === "ezplm") {
      const path = "/api/v1/api-key/parts",
        query = "keyword=" + encodeURIComponent(keyword) + "&pageSize=12";
      data = await json(
        process.env.EZPLM_API_BASE!.replace(/\/$/, "") + path + "?" + query,
        { headers: ezplmHeaders(path, query) },
      );
    } else if (source === "iceasy") {
      const fields = new Intl.DateTimeFormat("en-CA", {
        timeZone: process.env.ICEASY_TZ || "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date());
      const date = ["year", "month", "day", "hour", "minute", "second"]
        .map((k) => fields.find((p) => p.type === k)?.value)
        .join("");
      const account = process.env.ICEASY_ACCOUNT!.trim();
      const endpoint =
        process.env.ICEASY_API_URL ||
        "https://www.iceasy.com/external/api/open/list";
      const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
      };
      if (process.env.ICEASY_PROXY_URL) {
        headers["X-Target-Url"] = endpoint;
        if (process.env.ICEASY_PROXY_TOKEN)
          headers["X-Proxy-Token"] = process.env.ICEASY_PROXY_TOKEN;
      }
      data = await json(process.env.ICEASY_PROXY_URL || endpoint, {
        method: "POST",
        headers,
        body: new URLSearchParams({
          account,
          date,
          key: iceasyAuth(account, process.env.ICEASY_PASSWORD!.trim(), date),
          partNoList: keyword,
          pageIndex: "1",
          pageSize: "12",
        }),
      });
    } else if (source === "digikey") {
      const base =
        process.env.DIGIKEY_ENV === "sandbox"
          ? "https://sandbox-api.digikey.com"
          : "https://api.digikey.com";
      const token = await digiToken(base);
      data = await json(base + "/products/v4/search/keyword", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "X-DIGIKEY-Client-Id": process.env.DIGIKEY_CLIENT_ID!,
          "X-DIGIKEY-Locale-Site": "US",
          "X-DIGIKEY-Locale-Language": "en",
          "X-DIGIKEY-Locale-Currency": "USD",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ Keywords: keyword, Limit: 12, Offset: 0 }),
      });
    } else {
      const url = "https://api.mouser.com/api/v1/search/";
      const init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      };
      data = await json(
        url +
          "partnumber?apiKey=" +
          encodeURIComponent(process.env.MOUSER_API_KEY!),
        {
          ...init,
          body: JSON.stringify({
            SearchByPartRequest: {
              mouserPartNumber: keyword,
              partSearchOptions: "Exact",
            },
          }),
        },
      );
      if (
        !arr(data.Errors).length &&
        !arr(obj(data.SearchResults).Parts).length
      )
        data = await json(
          url +
            "keyword?apiKey=" +
            encodeURIComponent(process.env.MOUSER_API_KEY!),
          {
            ...init,
            body: JSON.stringify({
              SearchByKeywordRequest: {
                keyword,
                records: 12,
                startingRecord: 0,
              },
            }),
          },
        );
    }
    const hits = mapResponse(source, data);
    if (searchCache.size >= 256)
      searchCache.delete(searchCache.keys().next().value!);
    searchCache.set(cacheKey, { expires: Date.now() + 3600000, hits });
    return { hits, probe: { source, status: "OK", count: hits.length } };
  } catch (e) {
    const raw = e instanceof Error ? e.message : "";
    const message = /^HTTP |业务错误|请求限流|响应|OAuth/.test(raw)
      ? raw
      : "请求失败或超时，请检查网络、证书及 API 配置";
    return { hits: [], probe: { source, status: "ERROR", count: 0, message } };
  }
}
