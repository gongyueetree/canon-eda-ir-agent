type Props = Record<string, string>;
const decoder = new TextDecoder("windows-1252");
export function altiumProperties(data: Uint8Array): Props {
  const result: Props = Object.create(null);
  for (const entry of decoder.decode(data).replace(/\0+$/, "").split("|")) {
    const i = entry.indexOf("=");
    if (i > 0) result[entry.slice(0, i).toUpperCase()] = entry.slice(i + 1);
  }
  // UTF-8 properties override their legacy code-page equivalents.
  for (const entry of new TextDecoder().decode(data).replace(/\0+$/, "").split("|")) {
    const i = entry.indexOf("=");
    if (entry.startsWith("%UTF8%") && i > 6) result[entry.slice(6, i).toUpperCase()] = entry.slice(i + 1);
  }
  return result;
}
export function altiumBlocks(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = 0; offset < data.length;) {
    if (offset + 4 > data.length || out.length >= 100000) throw new Error("Invalid or excessive AD records");
    const size = view.getUint32(offset, true) & 0xffffff;
    offset += 4;
    if (!size || offset + size > data.length) throw new Error("Truncated AD record");
    out.push(data.subarray(offset, offset + size)); offset += size;
  }
  return out;
}

