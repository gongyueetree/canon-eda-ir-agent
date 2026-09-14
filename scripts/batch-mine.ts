/** Sequential isolated jobs; resumable manifest for thousands of existing projects. */
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  lstat,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { filesToInputAssets } from "../lib/eda/archive";
import { parseEdaProject } from "../lib/eda/parse";
import { mineKnowledge, MINER_VERSION } from "../lib/knowledge/miner";
const VERSION = `canon-parser-1.1.0:pdfjs-text-1.0.0:${MINER_VERSION}`;
type Entry = {
  path: string;
  conversionSource?: "ALTIUM";
  conversionTool?: string;
  conversionVersion?: string;
  originalFileHash?: string;
};
async function files(root: string): Promise<string[]> {
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) throw new Error("SYMLINK_REJECTED");
  if (stat.isFile()) return [root];
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    if ([".git", "node_modules", ".history"].includes(e.name)) continue;
    out.push(...(await files(path.join(root, e.name))));
    if (out.length > 5000) throw new Error("FILE_LIMIT");
  }
  return out;
}
async function one(entry: Entry, out: string) {
  const input = path.resolve(entry.path);
  const names = (await files(input)).sort();
  const isDir = (await lstat(input)).isDirectory();
  let total = 0;
  const inputs: File[] = [];
  const snapshot = createHash("sha256")
    .update(VERSION)
    .update(JSON.stringify(entry));
  for (const name of names) {
    const stat = await lstat(name);
    if (stat.size > 75 * 1024 * 1024) throw new Error("FILE_SIZE_LIMIT");
    total += stat.size;
    if (total > 200 * 1024 * 1024) throw new Error("PROJECT_SIZE_LIMIT");
    const bytes = await readFile(name);
    const relative = isDir ? path.relative(input, name) : path.basename(name);
    snapshot.update(relative).update(bytes);
    inputs.push(new File([bytes], relative));
  }
  const key = snapshot.digest("hex");
  const target = path.join(out, key);
  await mkdir(target, { recursive: true });
  try {
    const existing = JSON.parse(
      await readFile(path.join(target, "complete.json"), "utf8"),
    );
    if (existing.version === VERSION) {
      console.log(JSON.stringify({ status: "CACHED", input, key }));
      return;
    }
  } catch {}
  const intake = await filesToInputAssets(inputs);
  // Preserve raw bytes as immutable, content-addressed files, plus per-project inventory.
  const raw = path.join(out, "raw");
  await mkdir(raw, { recursive: true });
  const rawManifest = [];
  for (const asset of intake.assets) {
    const sha = createHash("sha256").update(asset.bytes).digest("hex");
    try {
      await writeFile(path.join(raw, sha), asset.bytes, { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    rawManifest.push({ path: asset.path, sha256: sha, object: `raw/${sha}` });
  }
  await writeFile(
    path.join(target, "raw-manifest.json"),
    JSON.stringify(rawManifest, null, 2),
  );
  const bundle = await parseEdaProject(intake.assets, intake.diagnostics);
  bundle.project.settings.sourceProvenance = entry;
  const result = await mineKnowledge(bundle);
  await writeFile(
    path.join(target, "bundle.json"),
    JSON.stringify(bundle, null, 2),
  );
  await writeFile(
    path.join(target, "knowledge.json"),
    JSON.stringify(result, null, 2),
  );
  await writeFile(
    path.join(target, "complete.tmp"),
    JSON.stringify({
      version: VERSION,
      input,
      key,
      blocks: result.blocks.length,
      errors: bundle.summary.errors,
      completedAt: new Date().toISOString(),
    }),
  );
  await rename(
    path.join(target, "complete.tmp"),
    path.join(target, "complete.json"),
  );
  console.log(
    JSON.stringify({
      status: "COMPLETED",
      input,
      key,
      blocks: result.blocks.length,
      errors: bundle.summary.errors,
    }),
  );
}
if (process.argv[2] === "--one") {
  await one(JSON.parse(process.argv[3]), path.resolve(process.argv[4]));
} else {
  const manifest = process.argv[2];
  const output = path.resolve(process.argv[3] ?? "outputs/mining");
  if (!manifest)
    throw new Error("Usage: npm run mine:batch -- manifest.json [output-dir]");
  const entries: Entry[] = JSON.parse(await readFile(manifest, "utf8"));
  if (!Array.isArray(entries) || entries.length > 10000)
    throw new Error("INVALID_MANIFEST");
  await mkdir(output, { recursive: true });
  const log = [];
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string")
      throw new Error("INVALID_ENTRY");
    const started = Date.now();
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--max-old-space-size=1536",
          "--import",
          "tsx",
          fileURLToPath(import.meta.url),
          "--one",
          JSON.stringify(entry),
          output,
        ],
        { stdio: "inherit" },
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    log.push({
      path: entry.path,
      status: code === 0 ? "COMPLETED" : "FAILED",
      durationMs: Date.now() - started,
    });
    await writeFile(
      path.join(output, "batch-status.json"),
      JSON.stringify(log, null, 2),
    );
  }
  if (log.some((x) => x.status === "FAILED")) process.exitCode = 1;
}
