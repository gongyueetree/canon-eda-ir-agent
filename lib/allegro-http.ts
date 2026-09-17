export const ALLEGRO_WEB_LIMIT = 4 * 1024 * 1024;

export async function boundedBody(stream: ReadableStream<Uint8Array> | null, limit = ALLEGRO_WEB_LIMIT): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) throw new Error("EMPTY_BODY");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new Error("ALLEGRO_WEB_LIMIT"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
