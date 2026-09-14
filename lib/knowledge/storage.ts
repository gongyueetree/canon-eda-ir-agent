import { saveBundle } from "../database";
import { neon } from "@neondatabase/serverless";
import { mineKnowledge } from "./miner";
import { applyReview, assertApprovable } from "./review";
import type { CanonicalIrBundle } from "../eda/types";
import type { HardwareBlock, MiningResult, ReviewEdit } from "./types";
let schema: Promise<void> | undefined;
function sql() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_NOT_CONFIGURED");
  return neon(process.env.DATABASE_URL);
}
async function ensure() {
  if (!schema)
    schema = (async () => {
      const q = sql();
      await q`CREATE TABLE IF NOT EXISTS eda_knowledge_runs (id TEXT NOT NULL, tenant_id TEXT NOT NULL, bundle_id TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(tenant_id,id))`;
      await q`CREATE TABLE IF NOT EXISTS eda_knowledge_blocks (id TEXT NOT NULL, tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, mpn TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'CANDIDATE', revision INTEGER NOT NULL DEFAULT 0, block JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,run_id) REFERENCES eda_knowledge_runs(tenant_id,id))`;
      await q`CREATE TABLE IF NOT EXISTS eda_knowledge_reviews (id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, block_id TEXT NOT NULL, action TEXT NOT NULL, revision INTEGER NOT NULL, snapshot JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`;
      await q`CREATE INDEX IF NOT EXISTS eda_knowledge_search ON eda_knowledge_blocks(tenant_id,status,mpn)`;
    })().catch((e) => {
      schema = undefined;
      throw e;
    });
  await schema;
}
export async function saveMining(tenant: string, bundle: CanonicalIrBundle) {
  await ensure();
  await saveBundle(tenant, bundle);
  const result = await mineKnowledge(bundle);
  const id = `${result.sourceHash}:${result.minerVersion}`;
  const q = sql();
  await q.transaction([
    q`INSERT INTO eda_knowledge_runs(id,tenant_id,bundle_id,result) VALUES(${id},${tenant},${bundle.bundleId},${JSON.stringify(result)}::jsonb) ON CONFLICT DO NOTHING`,
    ...result.blocks.map(
      (block) =>
        q`INSERT INTO eda_knowledge_blocks(id,tenant_id,run_id,mpn,block) VALUES(${block.id},${tenant},${id},${block.mpn},${JSON.stringify(block)}::jsonb) ON CONFLICT DO NOTHING`,
    ),
  ]);
  return {
    runId: id,
    result,
    blocks:
      await q`SELECT id, block, status, revision FROM eda_knowledge_blocks WHERE tenant_id=${tenant} AND run_id=${id}`,
  };
}
export async function listBlocks(
  tenant: string,
  mpn: string,
  published: boolean,
) {
  await ensure();
  return sql()`SELECT id,run_id,mpn,status,revision,block FROM eda_knowledge_blocks WHERE tenant_id=${tenant} AND (${mpn}='' OR mpn ILIKE ${"%" + mpn + "%"}) AND (${published}=false OR status='PUBLISHED') ORDER BY updated_at DESC LIMIT 200`;
}
export async function reviewBlock(
  tenant: string,
  id: string,
  action: string,
  revision: number,
  edit: ReviewEdit,
  acknowledge: boolean,
) {
  await ensure();
  const q = sql();
  const rows =
    await q`SELECT b.*,r.result FROM eda_knowledge_blocks b JOIN eda_knowledge_runs r ON r.id=b.run_id AND r.tenant_id=b.tenant_id WHERE b.tenant_id=${tenant} AND b.id=${id}`;
  const row = rows[0];
  if (!row) throw new Error("BLOCK_NOT_FOUND");
  if (row.revision !== revision) throw new Error("REVISION_CONFLICT");
  if (!["edit", "approve", "reject", "publish"].includes(action))
    throw new Error("INVALID_ACTION");
  const block =
    action === "publish"
      ? (row.block as HardwareBlock)
      : applyReview(
          row.result as MiningResult,
          row.block as HardwareBlock,
          edit,
        );
  if (action === "publish" && row.status !== "APPROVED")
    throw new Error("APPROVAL_REQUIRED");
  if (action === "approve") assertApprovable(block, acknowledge);
  block.status =
    action === "approve"
      ? "APPROVED"
      : action === "reject"
        ? "REJECTED"
        : action === "publish"
          ? "PUBLISHED"
          : "CANDIDATE";
  // One statement: optimistic update + immutable audit snapshot are atomic.
  const changed =
    await q`WITH changed AS (UPDATE eda_knowledge_blocks SET block=${JSON.stringify(block)}::jsonb,status=${block.status},revision=revision+1,updated_at=now() WHERE tenant_id=${tenant} AND id=${id} AND revision=${revision} RETURNING *) INSERT INTO eda_knowledge_reviews(tenant_id,block_id,action,revision,snapshot) SELECT tenant_id,id,${action},revision,block FROM changed RETURNING revision,snapshot`;
  if (!changed.length) throw new Error("REVISION_CONFLICT");
  return { revision: changed[0].revision, block: changed[0].snapshot };
}
