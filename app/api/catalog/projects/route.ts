import { authorize } from "../../../../lib/auth";
import {
  proxyCatalog,
  projectQuery,
  catalogError,
} from "../../../../lib/catalog/server";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    authorize(request);
    return await proxyCatalog(
      request,
      `/catalog/projects?${projectQuery(request.url)}`,
    );
  } catch (e) {
    return catalogError(e);
  }
}
