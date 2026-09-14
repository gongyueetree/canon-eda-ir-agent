/** Single-workspace access keys. Never trust caller-supplied tenant headers. */
export function authorize(request: Request): string {
  const expected = process.env.EDA_API_TOKEN;
  if (!expected || expected.length < 24) throw new Error("AUTH_NOT_CONFIGURED");
  const actual =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (actual.length !== expected.length) throw new Error("UNAUTHORIZED");
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  if (diff) throw new Error("UNAUTHORIZED");
  return process.env.EDA_WORKSPACE_ID || "gongyueetree";
}
export function authError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "REQUEST_FAILED";
  return Response.json(
    { error: message },
    {
      status:
        message === "AUTH_NOT_CONFIGURED"
          ? 503
          : message === "UNAUTHORIZED"
            ? 401
            : 400,
    },
  );
}
