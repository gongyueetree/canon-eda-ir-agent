import type { StepMesh } from "./step";

type Job = { bytes: Uint8Array; signal: AbortSignal; resolve: (meshes: StepMesh[]) => void; reject: (error: Error) => void; abort: () => void };
type Slot = { worker: Worker; job?: Job; timer?: ReturnType<typeof setTimeout> };

/** Reuse initialized OCCT workers; never initialize a WASM runtime for each part. */
export class StepWorkerPool {
  private queue: Job[] = [];
  private slots: Slot[] = [];
  private idle?: ReturnType<typeof setTimeout>;
  constructor(private readonly limit = 2, private readonly createWorker = () => new Worker("/workers/step.js"), private readonly timeoutMs = 60000) {}

  convert(bytes: Uint8Array, signal: AbortSignal): Promise<StepMesh[]> {
    if (signal.aborted) return Promise.reject(new Error("cancelled"));
    clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      const job: Job = { bytes, signal, resolve, reject, abort: () => {
        const slot = this.slots.find(s => s.job === job);
        if (slot) this.finish(slot, new Error("cancelled"), undefined, true);
        else { this.queue = this.queue.filter(j => j !== job); reject(new Error("cancelled")); }
      } };
      signal.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private finish(slot: Slot, error?: Error, meshes?: StepMesh[], discard = false) {
    const job = slot.job;
    clearTimeout(slot.timer);
    slot.job = undefined;
    if (discard) { slot.worker.terminate(); this.slots = this.slots.filter(s => s !== slot); }
    if (job) {
      job.signal.removeEventListener("abort", job.abort);
      if (error) job.reject(error); else job.resolve(meshes!);
    }
    this.pump();
  }

  private pump() {
    while (this.queue.length) {
      let slot = this.slots.find(s => !s.job);
      if (!slot) {
        if (this.slots.length >= this.limit) return;
        try { slot = { worker: this.createWorker() }; }
        catch { const job = this.queue.shift()!; job.signal.removeEventListener("abort", job.abort); job.reject(new Error("STEP 转换器加载失败")); continue; }
        const current = slot;
        current.worker.onmessage = event => this.finish(current, event.data.error ? new Error(event.data.error) : undefined, event.data.meshes);
        current.worker.onerror = () => this.finish(current, new Error("STEP 转换器加载失败"), undefined, true);
        this.slots.push(current);
      }
      const current = slot, job = this.queue.shift()!;
      current.job = job;
      current.timer = setTimeout(() => this.finish(current, new Error("STEP 转换超时"), undefined, true), this.timeoutMs);
      try { const copy = job.bytes.slice(); current.worker.postMessage(copy.buffer, [copy.buffer]); }
      catch { this.finish(current, new Error("STEP 转换器通信失败"), undefined, true); }
    }
    if (!this.slots.some(s => s.job)) {
      clearTimeout(this.idle);
      this.idle = setTimeout(() => this.dispose(), 30000);
    }
  }

  dispose() {
    clearTimeout(this.idle);
    for (const job of [...this.queue, ...this.slots.flatMap(s => s.job ? [s.job] : [])]) {
      job.signal.removeEventListener("abort", job.abort); job.reject(new Error("cancelled"));
    }
    for (const slot of this.slots) { clearTimeout(slot.timer); slot.worker.terminate(); }
    this.queue = []; this.slots = [];
  }
}

let pool: StepWorkerPool | undefined;
export function convertStep(bytes: Uint8Array, signal: AbortSignal) {
  pool ??= new StepWorkerPool(typeof navigator !== "undefined" && navigator.hardwareConcurrency <= 4 ? 1 : 2);
  return pool.convert(bytes, signal);
}
