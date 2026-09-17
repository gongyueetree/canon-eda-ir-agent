/** Content signatures, not the shared .brd extension, distinguish Allegro from KiCad/EAGLE. */
export function isAllegroBoard(bytes: Uint8Array): boolean {
  if (bytes.length < 256) return false;
  return bytes[3] === 0 && [0x13, 0x14, 0x15].includes(bytes[2]) ||
    bytes[0xf8] === 0x61 && bytes[0xf9] === 0x6c && bytes[0xfa] === 0x6c;
}

export const ALLEGRO_MANIFEST = "refir-allegro.json";
export type AllegroManifest = {
  format: "refir-allegro";
  version: 1;
  source: { path: string; sha256: string };
  board: { path: string; sha256: string };
  converter: { name: string; version: string };
};

export function readAllegroManifest(bytes: Uint8Array): AllegroManifest {
  if (bytes.length > 65536) throw new Error("转换清单超过 64 KiB");
  const m = JSON.parse(new TextDecoder().decode(bytes)) as AllegroManifest;
  if (m?.format !== "refir-allegro" || m.version !== 1 ||
      typeof m.converter?.name !== "string" || typeof m.converter?.version !== "string") throw new Error("转换清单版本或转换器信息无效");
  for (const file of [m.source, m.board]) {
    if (!file || typeof file.path !== "string" || !file.path ||
        /[\\:\x00]/.test(file.path) || file.path.split("/").some(p => !p || p === "." || p === "..") ||
        typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("转换清单的路径或 SHA-256 无效");
  }
  if (!/\.brd$/i.test(m.source.path) || !/\.kicad_pcb$/i.test(m.board.path)) throw new Error("转换清单必须关联 BRD 与 KiCad PCB");
  return m;
}
