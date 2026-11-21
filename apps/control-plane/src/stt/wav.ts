/**
 * Parses and validates the WAV shape the Parakeet recognizer accepts:
 * RIFF/WAVE, PCM format, 16 kHz, mono, 16 bits per sample.
 */

const REQUIRED_SAMPLE_RATE = 16000;
const REQUIRED_CHANNELS = 1;
const REQUIRED_BITS_PER_SAMPLE = 16;
const PCM_AUDIO_FORMAT = 1;
const PCM16_RANGE = 32768;

/** Upper bound for one transcription request, about 10 minutes of audio. */
export const MAX_WAV_BYTES = 20 * 1024 * 1024;

export class WavValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavValidationError";
  }
}

export type ParsedWav = {
  samples: Float32Array;
  sampleRate: number;
};

type FmtChunk = {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
};

function readFmtChunk(chunk: Buffer): FmtChunk {
  if (chunk.length < 16) {
    throw new WavValidationError("WAV fmt chunk is shorter than 16 bytes");
  }
  return {
    audioFormat: chunk.readUInt16LE(0),
    channels: chunk.readUInt16LE(2),
    sampleRate: chunk.readUInt32LE(4),
    bitsPerSample: chunk.readUInt16LE(14),
  };
}

function validateFmt(fmt: FmtChunk): void {
  if (fmt.audioFormat !== PCM_AUDIO_FORMAT) {
    throw new WavValidationError(`WAV must be PCM audio format ${PCM_AUDIO_FORMAT}, got ${fmt.audioFormat}`);
  }
  if (fmt.channels !== REQUIRED_CHANNELS) {
    throw new WavValidationError(`WAV must be mono with ${REQUIRED_CHANNELS} channel, got ${fmt.channels}`);
  }
  if (fmt.sampleRate !== REQUIRED_SAMPLE_RATE) {
    throw new WavValidationError(`WAV sample rate must be ${REQUIRED_SAMPLE_RATE} Hz, got ${fmt.sampleRate}`);
  }
  if (fmt.bitsPerSample !== REQUIRED_BITS_PER_SAMPLE) {
    throw new WavValidationError(`WAV must have ${REQUIRED_BITS_PER_SAMPLE} bits per sample, got ${fmt.bitsPerSample}`);
  }
}

function decodeSamples(data: Buffer): Float32Array {
  const sampleCount = Math.floor(data.length / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = data.readInt16LE(i * 2) / PCM16_RANGE;
  }
  return samples;
}

/** Throws WavValidationError unless the buffer is a valid 16 kHz mono 16-bit PCM WAV. */
export function parseMono16kHzWav(buffer: Buffer): ParsedWav {
  if (buffer.length < 12) {
    throw new WavValidationError("WAV data is too short to contain a RIFF header");
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new WavValidationError("WAV data is missing the RIFF/WAVE header");
  }

  let fmt: FmtChunk | undefined;
  let data: Buffer | undefined;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > buffer.length) {
      throw new WavValidationError(`WAV chunk "${chunkId}" is truncated`);
    }
    const chunkData = buffer.subarray(chunkStart, chunkStart + chunkSize);
    if (chunkId === "fmt ") fmt = readFmtChunk(chunkData);
    else if (chunkId === "data") data = chunkData;
    // Chunks are word aligned, so an odd size carries one padding byte.
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt) throw new WavValidationError("WAV data is missing the fmt chunk");
  if (!data) throw new WavValidationError("WAV data is missing the data chunk");
  validateFmt(fmt);
  return { samples: decodeSamples(data), sampleRate: fmt.sampleRate };
}
