import type { Mock } from "vitest";
import { vi } from "vitest";

/**
 * Fake Web Audio plumbing shared by the voice capture tests. The fakes record
 * just enough state (sample rate, processor node, closed flag) for assertions;
 * no real audio hardware is involved.
 */

export class FakeScriptProcessorNode {
  onaudioprocess: ((event: unknown) => void) | null = null;
  connect: Mock<(...args: unknown[]) => void> = vi.fn();
  disconnect: Mock<(...args: unknown[]) => void> = vi.fn();
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** Sample rate reported by every context created afterwards. */
  static sampleRate = 48000;

  readonly sampleRate: number;
  readonly processor = new FakeScriptProcessorNode();
  readonly destination: Record<string, never> = {};
  closed = false;
  processorBufferSize = 0;
  sourceStream: unknown = null;

  constructor() {
    this.sampleRate = FakeAudioContext.sampleRate;
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource(stream: unknown): { connect: () => void } {
    this.sourceStream = stream;
    return { connect: vi.fn() };
  }

  createScriptProcessor(...requested: number[]): FakeScriptProcessorNode {
    // VoiceRecorder requests (4096, 1, 1); only the buffer size is observable.
    this.processorBufferSize = requested[0] ?? 0;
    return this.processor;
  }

  createGain(): { gain: { value: number }; connect: () => void } {
    return { gain: { value: 1 }, connect: vi.fn() };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** AudioProcessingEvent-shaped object with one Float32Array per channel. */
export const audioChunkEvent = (channels: number[][]): unknown => ({
  inputBuffer: {
    numberOfChannels: channels.length,
    getChannelData: (channel: number) => new Float32Array(channels[channel]),
  },
});

/** MediaStream-shaped object whose tracks record their own stop calls. */
export const fakeStream = (): { getTracks: () => Array<{ stop: ReturnType<typeof vi.fn> }> } => ({
  getTracks: () => [{ stop: vi.fn() }],
});
