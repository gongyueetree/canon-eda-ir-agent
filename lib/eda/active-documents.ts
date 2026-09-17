import type { InputAsset, SourceAsset, ParseDiagnostic } from "./types";
import { decodeUtf8, diagnostic, sourceRef } from "./util";

const normalize = (path: string) => {
  const parts: string[] = [];
  for (const p of path.replace(/\\/g, "/").split("/")) {
    if (p === "..") parts.pop(); else if (p && p !== ".") parts.push(p);
  }
  return parts.join("/");
};
const historic = (path: string) => path.split(/[\\/]/).some(p => /^_autosave-|^~|^history$|^rescue-backup$|(?:-backups?|-bak)$|\.bak$/i.test(p));

export function activeKicadDocuments(inputs: InputAsset[], inventory: SourceAsset[], diagnostics: ParseDiagnostic[]): Set<string> {
  const eligible = inventory.filter(a => !historic(a.relativePath));
  const paths = new Map(eligible.map(a => [normalize(a.relativePath).toLowerCase(), a.relativePath]));
  const projects = eligible.filter(a => a.extension === ".kicad_pro" || a.extension === ".pro" && !paths.has(a.relativePath.replace(/\.pro$/i, ".kicad_pro").toLowerCase()));
  const selected = new Set<string>();
  const byPath = new Map(inputs.map(a => [a.path, a]));
  if (projects.length > 1) {
    diagnostics.push(diagnostic("PROJECT_SELECTION_REQUIRED", `检测到多个工程入口：${projects.map(p => p.relativePath).join(", ")}。请单独上传所需工程目录；未自动合并设计。`, "error", "structure"));
    return selected;
  }
  if (!projects.length) return new Set(eligible.map(a => a.relativePath));
  const project = projects[0], stem = project.relativePath.replace(/\.(kicad_pro|pro)$/i, "");
  const root = paths.get(`${stem}.kicad_sch`.toLowerCase()) ?? paths.get(`${stem}.sch`.toLowerCase());
  const pcb = paths.get(`${stem}.kicad_pcb`.toLowerCase()) ?? paths.get(`${stem}.brd`.toLowerCase());
  if (pcb) selected.add(pcb);
  if (!root && !pcb) diagnostics.push(diagnostic("PROJECT_DOCUMENT_MISSING", `${project.relativePath} 未附带同名根原理图或 PCB。请上传完整工程 ZIP。`, "error", "structure", sourceRef(project.id, project.relativePath)));
  const queue = root ? [root] : [];
  while (queue.length) {
    const path = queue.shift()!;
    if (selected.has(path)) continue;
    selected.add(path);
    const input = byPath.get(path); if (!input) continue;
    const directory = path.split("/").slice(0, -1).join("/");
    const text = decodeUtf8(input.bytes);
    const children = path.endsWith(".kicad_sch")
      ? [...text.matchAll(/\(property\s+"Sheet\s*file"\s+"([^"\n]+)"/gi)].map(m => m[1])
      : [...text.matchAll(/^F1\s+"([^"\n]+\.sch)"/gm)].map(m => m[1]);
    for (const child of children) {
      const target = normalize(`${directory}/${child}`), actual = paths.get(target.toLowerCase());
      if (actual) queue.push(actual);
      else diagnostics.push(diagnostic("PROJECT_DOCUMENT_MISSING", `${path} 引用的子页 ${target} 未上传。`, "error", "structure"));
    }
  }
  return selected;
}
