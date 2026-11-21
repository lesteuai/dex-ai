import { describe, expect, it } from "vitest";
import { buildWavBytes } from "./wav-fixture";
import { parseMono16kHzWav, WavValidationError } from "./wav";

function parseExpectingError(buffer: Buffer): WavValidationError {
  try {
    parseMono16kHzWav(buffer);
  } catch (error) {
    expect(error).toBeInstanceOf(WavValidationError);
    return error as WavValidationError;
  }
  throw new Error("Expected parseMono16kHzWav to reject the WAV bytes");
}

/** Minimal RIFF/WAVE file holding one chunk, used for missing-chunk errors. */
function buildSingleChunkWav(chunkId: "data" | "fmt ", content: Buffer): Buffer {
  const file = Buffer.alloc(20 + content.length);
  file.write("RIFF", 0, "ascii");
  file.writeUInt32LE(file.length - 8, 4);
  file.write("WAVE", 8, "ascii");
  file.write(chunkId, 12, "ascii");
  file.writeUInt32LE(content.length, 16);
  content.copy(file, 20);
  return file;
}

describe("parseMono16kHzWav", () => {
  it("accepts a valid 16 kHz mono 16-bit WAV and decodes its samples", () => {
    const samples = [0, 0.25, -0.5, 0.75, -1, 1];

    const parsed = parseMono16kHzWav(buildWavBytes({ samples }));

    expect(parsed.sampleRate).toBe(16000);
    expect(parsed.samples).toHaveLength(samples.length);
    samples.forEach((expected, index) => {
      expect(parsed.samples[index]).toBeCloseTo(expected, 3);
    });
  });

  it("rejects bytes too short for a RIFF header", () => {
    expect(parseExpectingError(Buffer.alloc(8)).message).toContain("too short");
  });

  it("rejects bytes without the RIFF/WAVE magic", () => {
    expect(parseExpectingError(Buffer.alloc(64, 0x41)).message).toContain("RIFF/WAVE header");
  });

  it("rejects a non-PCM audio format", () => {
    expect(parseExpectingError(buildWavBytes({ audioFormat: 3 })).message).toContain("PCM");
  });

  it("rejects stereo audio", () => {
    expect(parseExpectingError(buildWavBytes({ channels: 2 })).message).toContain("mono");
  });

  it("rejects a sample rate other than 16 kHz", () => {
    expect(parseExpectingError(buildWavBytes({ sampleRate: 44100 })).message).toContain("16000");
  });

  it("rejects a bit depth other than 16", () => {
    expect(parseExpectingError(buildWavBytes({ bitsPerSample: 8 })).message).toContain("bits per sample");
  });

  it("rejects a chunk that extends past the end of the buffer", () => {
    const wav = buildWavBytes();
    // The data chunk size sits at offset 40; overstate it past the file end.
    wav.writeUInt32LE(wav.length, 40);

    expect(parseExpectingError(wav).message).toContain("truncated");
  });

  it("rejects a WAV without a fmt chunk", () => {
    const validDataChunk = buildWavBytes().subarray(44);

    const error = parseExpectingError(buildSingleChunkWav("data", validDataChunk));

    expect(error.message).toContain("fmt chunk");
  });

  it("rejects a WAV without a data chunk", () => {
    const validFmtChunk = buildWavBytes().subarray(20, 36);

    const error = parseExpectingError(buildSingleChunkWav("fmt ", validFmtChunk));

    expect(error.message).toContain("data chunk");
  });
});
