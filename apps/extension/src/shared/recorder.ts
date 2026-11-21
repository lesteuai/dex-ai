import { encodeWav16kMono, resampleTo16kMono } from "./audio";

/**
 * Microphone capture through the Web Audio API. Collects mono chunks while
 * recording and produces one 16 kHz mono 16-bit WAV, ready for the local
 * transcription endpoint. No audio leaves the device from this module.
 */

export type VoiceCaptureFailureKind =
  | "permission_denied"
  | "no_microphone"
  | "unsupported"
  | "capture_failed";

export class VoiceRecorderError extends Error {
  readonly failureKind: VoiceCaptureFailureKind;

  constructor(failureKind: VoiceCaptureFailureKind, message: string) {
    super(message);
    this.name = "VoiceRecorderError";
    this.failureKind = failureKind;
  }
}

function voiceRecorderError(failureKind: VoiceCaptureFailureKind, message: string): VoiceRecorderError {
  return new VoiceRecorderError(failureKind, message);
}

// Browser denial, missing device and unsupported context each keep typed
// teaching usable, so the messages say so directly.
function toVoiceRecorderError(error: unknown): VoiceRecorderError {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return voiceRecorderError(
      "permission_denied",
      "Microphone permission was denied. Allow the microphone for this extension in the browser settings and try again, or keep using typed teaching.",
    );
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return voiceRecorderError(
      "no_microphone",
      "No microphone is available on this device. Typed teaching still works.",
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return voiceRecorderError("capture_failed", `Microphone capture failed: ${detail}`);
}

function concatMonoChunks(chunks: readonly Float32Array[]): Float32Array {
  let totalLength = 0;
  for (const chunk of chunks) totalLength += chunk.length;
  const samples = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return samples;
}

// 120 s of 16 kHz mono 16-bit audio is about 3.8 MB, well under the 20 MB
// WAV limit the control plane enforces.
const DEFAULT_MAX_DURATION_MS = 120_000;

export class VoiceRecorder {
  private capturedChunks: Float32Array[] = [];
  private captureSampleRate = 0;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private stream: MediaStream | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private wavResult: ArrayBuffer | null = null;

  constructor(private readonly maxDurationMs: number = DEFAULT_MAX_DURATION_MS) {}

  get isRecording(): boolean {
    return this.processor !== null;
  }

  /** Request the microphone and begin collecting mono chunks. */
  async start(): Promise<void> {
    if (this.processor !== null) {
      throw voiceRecorderError("capture_failed", "This recorder is already recording");
    }
    if (this.wavResult !== null) {
      throw voiceRecorderError("capture_failed", "This recorder has already finished");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw voiceRecorderError(
        "unsupported",
        "This browser context does not expose microphone capture. Typed teaching still works.",
      );
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      throw toVoiceRecorderError(error);
    }
    this.stream = stream;
    const audioContext = new AudioContext();
    this.audioContext = audioContext;
    this.captureSampleRate = audioContext.sampleRate;
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    this.processor = processor;
    // ScriptProcessorNode fires only while connected to a destination; a
    // zero-gain sink keeps it running without playing the mic back.
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    processor.onaudioprocess = (event) => this.handleAudioChunk(event);
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);
    this.maxDurationTimer = setTimeout(() => {
      void this.stop();
    }, this.maxDurationMs);
  }

  /** Stop capture, release the microphone and return the resampled WAV. */
  async stop(): Promise<ArrayBuffer> {
    if (this.wavResult !== null) return this.wavResult;
    if (this.processor === null) {
      throw voiceRecorderError("capture_failed", "The recorder was never started");
    }
    if (this.maxDurationTimer !== null) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    this.processor.onaudioprocess = null;
    this.processor.disconnect();
    this.processor = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    if (this.audioContext !== null) {
      await this.audioContext.close();
      this.audioContext = null;
    }
    const samples = concatMonoChunks(this.capturedChunks);
    this.wavResult = encodeWav16kMono(resampleTo16kMono(samples, this.captureSampleRate));
    return this.wavResult;
  }

  private handleAudioChunk(event: AudioProcessingEvent): void {
    const input = event.inputBuffer;
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < input.numberOfChannels; channel++) {
      channels.push(input.getChannelData(channel));
    }
    const primary = channels[0];
    if (channels.length === 1) {
      // The processor reuses its buffer, so copy the samples out.
      this.capturedChunks.push(new Float32Array(primary));
      return;
    }
    const mixed = new Float32Array(primary.length);
    for (let sampleIndex = 0; sampleIndex < primary.length; sampleIndex++) {
      let sum = 0;
      for (const channelData of channels) sum += channelData[sampleIndex];
      mixed[sampleIndex] = sum / channels.length;
    }
    this.capturedChunks.push(mixed);
  }
}
