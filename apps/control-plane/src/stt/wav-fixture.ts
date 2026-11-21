/**
 * Fixture WAV bytes for STT tests: RIFF/WAVE, PCM, 16 kHz, mono, 16-bit.
 * Overrides exist so rejection tests can vary the fmt chunk fields.
 */
export type WavOverrides = {
  audioFormat?: number;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  samples?: number[];
};

const DEFAULT_SAMPLES = [0, 0.25, -0.5, 0.75, -1, 1];
const PCM16_MAX = 32767;

export function buildWavBytes(overrides: WavOverrides = {}): Buffer {
  const audioFormat = overrides.audioFormat ?? 1;
  const channels = overrides.channels ?? 1;
  const sampleRate = overrides.sampleRate ?? 16000;
  const bitsPerSample = overrides.bitsPerSample ?? 16;
  const samples = overrides.samples ?? DEFAULT_SAMPLES;

  // Data is always encoded as PCM16; rejection tests fail on the fmt chunk
  // before the data chunk is decoded, so the declared bit depth only
  // affects the fmt fields.
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    data.writeInt16LE(Math.round(clamped * PCM16_MAX), index * 2);
  });

  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(audioFormat, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 8);
  fmt.writeUInt16LE((channels * bitsPerSample) / 8, 12);
  fmt.writeUInt16LE(bitsPerSample, 14);

  const file = Buffer.alloc(44 + data.length);
  file.write("RIFF", 0, "ascii");
  file.writeUInt32LE(file.length - 8, 4);
  file.write("WAVE", 8, "ascii");
  file.write("fmt ", 12, "ascii");
  file.writeUInt32LE(fmt.length, 16);
  fmt.copy(file, 20);
  file.write("data", 36, "ascii");
  file.writeUInt32LE(data.length, 40);
  data.copy(file, 44);
  return file;
}
