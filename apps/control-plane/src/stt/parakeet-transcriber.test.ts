import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ParakeetTranscriber } from "./parakeet-transcriber";
import { SttUnavailableError } from "./transcriber";
import { buildWavBytes } from "./wav-fixture";
import { WavValidationError } from "./wav";

// These tests run without the Parakeet model package and without the native
// sherpa-onnx addon: the worker checks the model files first, so a missing
// model directory exercises the typed unavailability path before any native
// code would load.
const TEMP_BASE = "/tmp/opencode";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(TEMP_BASE, "dex-ai-parakeet-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const missingModelDir = (): string => join(workDir, "missing-parakeet-model");

async function transcribeExpectingError(transcriber: ParakeetTranscriber, wav: Buffer): Promise<Error> {
  try {
    await transcriber.transcribe(wav);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected transcribe to fail");
}

describe("ParakeetTranscriber with the local model absent", () => {
  it("rejects with the typed unavailability error listing the missing files", async () => {
    const transcriber = new ParakeetTranscriber(missingModelDir());
    try {
      const error = await transcribeExpectingError(transcriber, buildWavBytes());

      expect(error).toBeInstanceOf(SttUnavailableError);
      expect(error.message).toContain("encoder.int8.onnx");
      expect(error.message).toContain("tokens.txt");
    } finally {
      await transcriber.close();
    }
  });

  it("rejects an invalid WAV with the WAV validation error", async () => {
    const transcriber = new ParakeetTranscriber(missingModelDir());
    try {
      const error = await transcribeExpectingError(transcriber, Buffer.from("not a wav header"));

      expect(error).toBeInstanceOf(WavValidationError);
    } finally {
      await transcriber.close();
    }
  });

  it("spawns a fresh worker after close and still reports the typed error", async () => {
    const transcriber = new ParakeetTranscriber(missingModelDir());
    await transcriber.close();
    try {
      const error = await transcribeExpectingError(transcriber, buildWavBytes());

      expect(error).toBeInstanceOf(SttUnavailableError);
    } finally {
      await transcriber.close();
    }
  });
});
