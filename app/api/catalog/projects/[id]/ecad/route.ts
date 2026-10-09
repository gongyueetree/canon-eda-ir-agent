import { authorize } from "../../../../../../lib/auth";
import {
  proxyCatalog,
  validProjectId,
  catalogError,
} from "../../../../../../lib/catalog/server";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    authorize(request);
    return await proxyCatalog(
      request,
      `/catalog/projects/${validProjectId((await params).id)}/ecad`,
    );
  } catch (e) {
    return catalogError(e);
  }
}
