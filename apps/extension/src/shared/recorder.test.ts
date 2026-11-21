import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { FakeAudioContext, audioChunkEvent, fakeStream } from "../testing/webaudio";
import { VoiceRecorder, VoiceRecorderError } from "./recorder";

let getUserMediaMock: Mock<(...args: unknown[]) => Promise<unknown>>;
let streamTracks: Array<{ stop: ReturnType<typeof vi.fn> }>;

beforeEach(() => {
  getUserMediaMock = vi.fn();
  streamTracks = [{ stop: vi.fn() }];
  FakeAudioContext.instances.length = 0;
  FakeAudioContext.sampleRate = 48000;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: (...args: unknown[]) => getUserMediaMock(...args) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settleMicrotasks(): Promise<void> {
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
}

async function startFailure(): Promise<VoiceRecorderError> {
  const failure = await new VoiceRecorder().start().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(VoiceRecorderError);
  return failure as VoiceRecorderError;
}

function currentContext(): FakeAudioContext {
  const context = FakeAudioContext.instances.at(-1);
  if (context === undefined) throw new Error("no audio context was created");
  return context;
}

async function startRecording(): Promise<VoiceRecorder> {
  getUserMediaMock.mockResolvedValue({
    getTracks: () => streamTracks,
  } as unknown as MediaStream);
  const recorder = new VoiceRecorder();
  await recorder.start();
  return recorder;
}

describe("capture failures keep typed teaching usable", () => {
  it("maps a browser permission denial to a friendly failure", async () => {
    getUserMediaMock.mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));

    const failure = await startFailure();

    expect(failure.failureKind).toBe("permission_denied");
    expect(failure.message).toMatch(/typed teaching/i);
    expect(getUserMediaMock).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  });

  it("maps a missing microphone to a friendly failure", async () => {
    getUserMediaMock.mockRejectedValue(new DOMException("No device", "NotFoundError"));

    const failure = await startFailure();

    expect(failure.failureKind).toBe("no_microphone");
    expect(failure.message).toMatch(/typed teaching/i);
  });

  it("reports an unsupported context when getUserMedia is missing", async () => {
    vi.stubGlobal("navigator", {});

    const failure = await startFailure();

    expect(failure.failureKind).toBe("unsupported");
    expect(failure.message).toMatch(/typed teaching/i);
  });

  it("wraps any other capture error with its detail", async () => {
    getUserMediaMock.mockRejectedValue(new Error("hardware detached"));

    const failure = await startFailure();

    expect(failure.failureKind).toBe("capture_failed");
    expect(failure.message).toContain("hardware detached");
  });
});

describe("capture", () => {
  it("produces a 16 kHz mono WAV from 48 kHz chunks and releases the microphone", async () => {
    const recorder = await startRecording();
    expect(recorder.isRecording).toBe(true);
    const context = currentContext();
    expect(context.processorBufferSize).toBe(4096);

    context.processor.onaudioprocess?.(audioChunkEvent([new Array<number>(48).fill(0.5)]));
    context.processor.onaudioprocess?.(audioChunkEvent([new Array<number>(48).fill(0.5)]));

    const wav = await recorder.stop();
    expect(recorder.isRecording).toBe(false);

    const view = new DataView(wav);
    expect(wav.byteLength).toBe(44 + 64);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(64);
    expect(view.getInt16(44, true)).toBe(16384);
    expect(context.closed).toBe(true);
    expect(context.processor.disconnect).toHaveBeenCalled();
    expect(streamTracks[0]!.stop).toHaveBeenCalled();
  });

  it("downmixes stereo chunks to one mono channel", async () => {
    FakeAudioContext.sampleRate = 16000;
    const recorder = await startRecording();

    currentContext().processor.onaudioprocess?.(
      audioChunkEvent([
        [0.2, 0.4],
        [0.4, 0.8],
      ]),
    );

    const view = new DataView(await recorder.stop());
    expect(view.getUint32(40, true)).toBe(4);
    expect(view.getInt16(44, true)).toBe(Math.round(0.3 * 0x7fff));
    expect(view.getInt16(46, true)).toBe(Math.round(0.6 * 0x7fff));
  });

  it("stops itself at the configured maximum duration", async () => {
    vi.useFakeTimers();
    getUserMediaMock.mockResolvedValue({
      getTracks: () => streamTracks,
    } as unknown as MediaStream);
    const recorder = new VoiceRecorder(1200);
    await recorder.start();

    await vi.advanceTimersByTimeAsync(1200);
    await settleMicrotasks();
    const wav = await recorder.stop();

    expect(recorder.isRecording).toBe(false);
    expect(new DataView(wav).getUint32(40, true)).toBe(0);
  });

  it("guards start and stop misuse", async () => {
    const neverStarted = await new VoiceRecorder().stop().catch((error: unknown) => error);
    expect(neverStarted).toBeInstanceOf(VoiceRecorderError);
    expect((neverStarted as VoiceRecorderError).message).toContain("never started");

    getUserMediaMock.mockResolvedValue(fakeStream() as unknown as MediaStream);
    const alreadyRecording = new VoiceRecorder();
    await alreadyRecording.start();
    const secondStart = await alreadyRecording.start().catch((error: unknown) => error);
    expect(secondStart).toBeInstanceOf(VoiceRecorderError);
    expect((secondStart as VoiceRecorderError).message).toContain("already recording");

    await alreadyRecording.stop();
    const reuseAfterFinish = await alreadyRecording.start().catch((error: unknown) => error);
    expect(reuseAfterFinish).toBeInstanceOf(VoiceRecorderError);
    expect((reuseAfterFinish as VoiceRecorderError).message).toContain("already finished");
  });

  it("returns the same WAV from a repeated stop", async () => {
    const recorder = await startRecording();
    currentContext().processor.onaudioprocess?.(
      audioChunkEvent([new Array<number>(16).fill(0.25)]),
    );

    const first = await recorder.stop();
    const second = await recorder.stop();

    expect(second).toBe(first);
  });
});
