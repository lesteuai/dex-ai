import type { HttpBindings } from "@hono/node-server";
import { type Context, Hono } from "hono";
import type { ControlPlaneConfig } from "../config";
import { ParakeetTranscriber } from "../stt/parakeet-transcriber";
import { SttUnavailableError, type SpeechTranscriber } from "../stt/transcriber";
import { MAX_WAV_BYTES, WavValidationError } from "../stt/wav";

type SttContext = Context<{ Bindings: HttpBindings }>;

function rejectSttRequest(c: SttContext, status: 400 | 413 | 500 | 503, error: string, message: string) {
  return c.json({ error, message }, status);
}

/**
 * POST /api/stt/transcribe takes a 16 kHz mono 16-bit WAV body and returns
 * only { text }. No audio or transcript is persisted on this path.
 */
export function createSttRoute(
  config: ControlPlaneConfig,
  transcriber: SpeechTranscriber = new ParakeetTranscriber(config.parakeetModelPath),
): Hono<{ Bindings: HttpBindings }> {
  const stt = new Hono<{ Bindings: HttpBindings }>();
  stt.post("/transcribe", async (c) => {
    const declaredSize = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_WAV_BYTES) {
      return rejectSttRequest(c, 413, "payload_too_large", `WAV body exceeds the ${MAX_WAV_BYTES} byte limit`);
    }
    const body = Buffer.from(await c.req.arrayBuffer());
    if (body.byteLength > MAX_WAV_BYTES) {
      return rejectSttRequest(c, 413, "payload_too_large", `WAV body exceeds the ${MAX_WAV_BYTES} byte limit`);
    }
    try {
      const { text } = await transcriber.transcribe(body);
      return c.json({ text });
    } catch (error) {
      if (error instanceof WavValidationError) {
        return rejectSttRequest(c, 400, "invalid_wav", error.message);
      }
      if (error instanceof SttUnavailableError) {
        return rejectSttRequest(c, 503, "stt_unavailable", error.message);
      }
      const message = error instanceof Error ? error.message : "Unknown transcription failure";
      return rejectSttRequest(c, 500, "transcription_failed", message);
    }
  });
  return stt;
}
