import { proxyCatalog } from "../../../../lib/catalog/server";
export const runtime = "nodejs";
export const GET = (request: Request) =>
  proxyCatalog(request, "/catalog/categories");
