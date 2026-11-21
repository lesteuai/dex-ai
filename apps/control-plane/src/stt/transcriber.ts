/**
 * Speech transcription contract plus the worker wire protocol.
 * The route layer depends only on the interface, so tests can inject a fake.
 */
export interface SpeechTranscriber {
  transcribe(wav: Buffer): Promise<{ text: string }>;
}

/** Raised when the local model files or native addon are not usable. */
export class SttUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SttUnavailableError";
  }
}

export type TranscriberRequest = {
  type: "transcribe";
  id: number;
  sampleRate: number;
  samples: Float32Array;
};

export type TranscriberReply =
  | { type: "result"; id: number; text: string }
  | { type: "unavailable"; id: number; message: string }
  | { type: "failed"; id: number; message: string };
