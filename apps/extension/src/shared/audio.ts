/**
 * Pure audio helpers for voice capture: resample one mono channel to 16 kHz
 * and encode it as 16-bit PCM WAV, the exact shape the local Parakeet
 * transcription endpoint accepts. No Web Audio dependency, so the math stays
 * verifiable outside a browser.
 */

export const TARGET_SAMPLE_RATE = 16000;

/** Linear-interpolation resample of one mono channel to 16 kHz. */
export function resampleTo16kMono(samples: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate <= 0) {
    throw new Error(`Invalid input sample rate: ${inputSampleRate}`);
  }
  if (samples.length === 0) return new Float32Array(0);
  if (inputSampleRate === TARGET_SAMPLE_RATE) return samples;
  const outputLength = Math.max(1, Math.round((samples.length * TARGET_SAMPLE_RATE) / inputSampleRate));
  const output = new Float32Array(outputLength);
  const step = (samples.length - 1) / Math.max(1, outputLength - 1);
  for (let index = 0; index < outputLength; index++) {
    const position = index * step;
    const left = Math.min(Math.floor(position), samples.length - 1);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = position - left;
    output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index++) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/** Encode 16 kHz mono samples as a RIFF/WAVE file with one 16-bit PCM data chunk. */
export function encodeWav16kMono(samples: Float32Array): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  // PCM format, mono, 16 kHz, 2 bytes per sample.
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    // Full negative range is 0x8000, full positive range is 0x7fff.
    view.setInt16(offset, Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), true);
    offset += 2;
  }
  return buffer;
}
