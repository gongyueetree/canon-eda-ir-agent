import type { InputAsset } from "../eda/types";
import type { StepMesh } from "./step";

export type ModelData = { kind: "step"; meshes: StepMesh[] } | { kind: "wrl"; text: string };
type Entry = { promise: Promise<ModelData>; signal: AbortSignal; ready: boolean; size: number };

/** CPU data only: disposing a scene cannot invalidate cached GPU geometry shared with another scene. */
export class ModelDataCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  constructor(private readonly budget = 128 * 1024 * 1024) {}
  get(key: string, signal: AbortSignal, load: () => Promise<ModelData>): Promise<ModelData> {
    const old = this.entries.get(key);
    if (old && (old.ready || !old.signal.aborted)) {
      this.entries.delete(key); this.entries.set(key, old); return old.promise;
    }
    if (old) this.entries.delete(key);
    const entry: Entry = { signal, ready: false, size: 0, promise: Promise.resolve().then(load).then(data => {
      if (signal.aborted) throw new Error("cancelled");
      if (this.entries.get(key) !== entry) return data;
      entry.ready = true;
      entry.size = data.kind === "wrl" ? data.text.length * 2 : data.meshes.reduce((n, m) => n + (m.attributes.position.array.length + (m.attributes.normal?.array.length ?? 0) + m.index.array.length) * 8, 0);
      this.bytes += entry.size;
      for (const [candidate, item] of this.entries) {
        if (this.bytes <= this.budget) break;
        if (item.ready) { this.entries.delete(candidate); this.bytes -= item.size; }
      }
      return data;
    }).catch(error => {
      // A failed download or cancelled conversion must be retryable, not cached forever.
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }) };
    this.entries.set(key, entry); return entry.promise;
  }
}

const sessions = new WeakMap<InputAsset[], ModelDataCache>();
const assemblies = new WeakMap<InputAsset, ModelDataCache>();
export function modelCacheForAsset(asset:InputAsset) {
  let cache=assemblies.get(asset);
  if(!cache){cache=new ModelDataCache();assemblies.set(asset,cache);}
  return cache;
}
export function modelCacheFor(assets: InputAsset[]) {
  let cache = sessions.get(assets);
  if (!cache) { cache = new ModelDataCache(); sessions.set(assets, cache); }
  return cache;
}
