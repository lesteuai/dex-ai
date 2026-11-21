/**
 * Worker thread that owns the sherpa-onnx OfflineRecognizer.
 * Loads the Parakeet model lazily on the first transcription request.
 * This file keeps zero runtime imports of sibling modules so it loads
 * in a plain Node worker thread; only node: builtins and the native
 * addon are required at runtime.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { TranscriberReply, TranscriberRequest } from "./transcriber";

const MODEL_FILE_NAMES = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"] as const;
const FEATURE_DIM = 80;
const NUM_THREADS = 2;

/** Thrown when the model files or native addon are not usable on this device. */
class ModelUnavailableError extends Error {}

// sherpa-onnx-node 2.0.2 ships no type declarations; only the slice we call.
type SherpaStream = {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
};
type SherpaRecognizer = {
  createStream(): SherpaStream;
  decode(stream: SherpaStream): void;
  getResult(stream: SherpaStream): { text: string };
};
type SherpaOnnxModule = { OfflineRecognizer: new (config: unknown) => SherpaRecognizer };

const requireAddon = createRequire(import.meta.url);
const setup = workerData as { modelDir: string };

let recognizer: SherpaRecognizer | undefined;

function findMissingModelFiles(): string[] {
  return MODEL_FILE_NAMES.filter((name) => !existsSync(join(setup.modelDir, name)));
}

function loadRecognizer(): SherpaRecognizer {
  if (recognizer) return recognizer;
  const missing = findMissingModelFiles();
  if (missing.length > 0) {
    throw new ModelUnavailableError(`Parakeet model files missing in ${setup.modelDir}: ${missing.join(", ")}`);
  }
  let sherpa: SherpaOnnxModule;
  try {
    sherpa = requireAddon("sherpa-onnx-node") as SherpaOnnxModule;
  } catch (error) {
    throw new ModelUnavailableError(`sherpa-onnx-node addon is unavailable: ${(error as Error).message}`);
  }
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: FEATURE_DIM },
    modelConfig: {
      transducer: {
        encoder: join(setup.modelDir, "encoder.int8.onnx"),
        decoder: join(setup.modelDir, "decoder.int8.onnx"),
        joiner: join(setup.modelDir, "joiner.int8.onnx"),
      },
      tokens: join(setup.modelDir, "tokens.txt"),
      numThreads: NUM_THREADS,
      provider: "cpu",
      debug: 0,
      modelType: "nemo_transducer",
    },
  });
  return recognizer;
}

function recognize(request: TranscriberRequest): string {
  const activeRecognizer = loadRecognizer();
  const stream = activeRecognizer.createStream();
  stream.acceptWaveform({ sampleRate: request.sampleRate, samples: request.samples });
  activeRecognizer.decode(stream);
  return activeRecognizer.getResult(stream).text;
}

function handleRequest(request: TranscriberRequest): void {
  if (request.type !== "transcribe") return;
  let reply: TranscriberReply;
  try {
    reply = { type: "result", id: request.id, text: recognize(request) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply =
      error instanceof ModelUnavailableError
        ? { type: "unavailable", id: request.id, message }
        : { type: "failed", id: request.id, message };
  }
  parentPort?.postMessage(reply);
}

if (parentPort) parentPort.on("message", handleRequest);
