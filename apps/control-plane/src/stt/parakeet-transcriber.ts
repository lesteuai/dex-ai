/**
 * Main-thread SpeechTranscriber backed by the worker thread in worker.ts.
 * Spawns the worker lazily on the first request and keeps one worker for
 * the process lifetime. Audio samples are transferred, never persisted.
 */
import { Worker } from "node:worker_threads";
import { SttUnavailableError, type SpeechTranscriber, type TranscriberReply, type TranscriberRequest } from "./transcriber";
import { parseMono16kHzWav } from "./wav";

type PendingRequest = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
};

export class ParakeetTranscriber implements SpeechTranscriber {
  private readonly modelDir: string;
  private worker?: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;

  constructor(modelDir: string) {
    this.modelDir = modelDir;
  }

  async transcribe(wav: Buffer): Promise<{ text: string }> {
    const { samples, sampleRate } = parseMono16kHzWav(wav);
    const text = await this.requestTranscription(samples, sampleRate);
    return { text };
  }

  /** Stops the worker and fails any in-flight request. */
  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    this.failAllPending(new Error("STT worker closed"));
    await worker?.terminate();
  }

  private requestTranscription(samples: Float32Array, sampleRate: number): Promise<string> {
    const worker = this.ensureWorker();
    const id = this.nextRequestId++;
    const request: TranscriberRequest = { type: "transcribe", id, sampleRate, samples };
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Freshly parsed samples always sit on a plain ArrayBuffer.
      worker.postMessage(request, [samples.buffer as ArrayBuffer]);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: { modelDir: this.modelDir },
    });
    // An idle STT worker must not keep the control plane process alive.
    worker.unref();
    worker.on("message", (reply: TranscriberReply) => this.handleWorkerReply(reply));
    worker.on("error", (error: Error) => this.failAllPending(error));
    worker.on("exit", () => this.handleWorkerExit(worker));
    this.worker = worker;
    return worker;
  }

  private handleWorkerReply(reply: TranscriberReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if (reply.type === "result") pending.resolve(reply.text);
    else if (reply.type === "unavailable") pending.reject(new SttUnavailableError(reply.message));
    else pending.reject(new Error(reply.message));
  }

  private handleWorkerExit(worker: Worker): void {
    if (this.worker === worker) this.worker = undefined;
    this.failAllPending(new Error("STT worker exited before replying"));
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
