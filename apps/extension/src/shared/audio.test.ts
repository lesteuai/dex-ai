import { describe, expect, it } from "vitest";
import { encodeWav16kMono, resampleTo16kMono } from "./audio";

const ascii = (view: DataView, offset: number): string =>
  String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );

describe("encodeWav16kMono", () => {
  it("writes a canonical RIFF/WAVE header for 16 kHz mono 16-bit PCM", () => {
    const wav = encodeWav16kMono(new Float32Array([0, 0.5, -0.5, 1, -1]));
    const view = new DataView(wav);

    expect(wav.byteLength).toBe(54);
    expect(ascii(view, 0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(46);
    expect(ascii(view, 8)).toBe("WAVE");
    expect(ascii(view, 12)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(view, 36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(10);
  });

  it("encodes 16-bit samples and clamps out-of-range values", () => {
    const wav = encodeWav16kMono(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]));
    const view = new DataView(wav);
    const sample = (index: number): number => view.getInt16(44 + index * 2, true);

    expect(sample(0)).toBe(0);
    expect(sample(1)).toBe(16384);
    expect(sample(2)).toBe(-16384);
    expect(sample(3)).toBe(32767);
    expect(sample(4)).toBe(-32768);
    expect(sample(5)).toBe(32767);
    expect(sample(6)).toBe(-32768);
  });
});

describe("resampleTo16kMono", () => {
  it("resamples 48 kHz input down to a third of the length", () => {
    const output = resampleTo16kMono(new Float32Array(48).fill(0.25), 48000);

    expect(output).toHaveLength(16);
    for (const sample of output) expect(sample).toBeCloseTo(0.25);
  });

  it("interpolates a linear ramp at the exact output positions", () => {
    const input = new Float32Array(48);
    for (let index = 0; index < input.length; index += 1) input[index] = index;

    const output = resampleTo16kMono(input, 48000);

    expect(output).toHaveLength(16);
    expect(output[0]).toBe(0);
    expect(output[15]).toBe(47);
    expect(output[8]).toBeCloseTo(8 * (47 / 15), 5);
  });

  it("returns the input unchanged when it is already 16 kHz", () => {
    const input = new Float32Array([0.1, 0.9]);

    expect(resampleTo16kMono(input, 16000)).toBe(input);
  });

  it("returns empty output for empty input", () => {
    expect(resampleTo16kMono(new Float32Array(0), 48000)).toHaveLength(0);
  });

  it("rejects invalid input sample rates", () => {
    expect(() => resampleTo16kMono(new Float32Array(4), 0)).toThrow(/sample rate/i);
    expect(() => resampleTo16kMono(new Float32Array(4), -16000)).toThrow(/sample rate/i);
  });
});
