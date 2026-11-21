import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import type { ControlPlaneConfig } from "../config";
import { openSqliteDatabase } from "../db/client";
import { runMigrations } from "../db/migrate";
import { SttUnavailableError, type SpeechTranscriber } from "../stt/transcriber";
import { buildWavBytes } from "../stt/wav-fixture";
import { MAX_WAV_BYTES, parseMono16kHzWav } from "../stt/wav";
import { createSttRoute } from "./stt";

const TEMP_BASE = "/tmp/opencode";

function buildSttRouteConfig(dataDir: string): ControlPlaneConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    token: "t".repeat(64),
    dataDir,
    extensionOrigins: [],
    localUiOrigin: "http://127.0.0.1:8787",
    lowConfidenceThreshold: 0.7,
    parakeetModelPath: join(dataDir, "models"),
  };
}

type SttApp = Hono<{ Bindings: HttpBindings }>;

function buildSttApp(config: ControlPlaneConfig, transcriber: SpeechTranscriber): SttApp {
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.route("/", createSttRoute(config, transcriber));
  return app;
}

/** Mirrors ParakeetTranscriber: WAV validation runs before recognition. */
function fakeTranscriber(text: string) {
  const transcribe = vi.fn(async (wav: Buffer): Promise<{ text: string }> => {
    parseMono16kHzWav(wav);
    return { text };
  });
  return { transcribe, transcriber: { transcribe } satisfies SpeechTranscriber };
}

function failingTranscriber(error: Error): SpeechTranscriber {
  return { transcribe: () => Promise.reject(error) };
}

const postWav = async (app: SttApp, body: Buffer): Promise<Response> =>
  app.request("/transcribe", { method: "POST", body });

const readErrorBody = async (response: Response): Promise<{ error: string; message: string }> =>
  (await response.json()) as { error: string; message: string };

describe("POST /api/stt/transcribe", () => {
  it("returns the transcript produced by a fake transcriber", async () => {
    const { transcribe, transcriber } = fakeTranscriber("prefer remote roles with modern stacks");
    const app = buildSttApp(buildSttRouteConfig(join(TEMP_BASE, "dex-ai-stt-route")), transcriber);
    const wav = buildWavBytes();

    const response = await postWav(app, wav);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "prefer remote roles with modern stacks" });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0]?.[0]).toEqual(wav);
  });

  it("rejects an invalid WAV header with an actionable error", async () => {
    const { transcriber } = fakeTranscriber("never returned");
    const app = buildSttApp(buildSttRouteConfig(join(TEMP_BASE, "dex-ai-stt-route")), transcriber);

    const response = await postWav(app, Buffer.alloc(64, 0x41));

    expect(response.status).toBe(400);
    const body = await readErrorBody(response);
    expect(body.error).toBe("invalid_wav");
    expect(body.message).toContain("RIFF/WAVE header");
  });

  it("rejects a WAV whose sample rate is not 16 kHz", async () => {
    const { transcriber } = fakeTranscriber("never returned");
    const app = buildSttApp(buildSttRouteConfig(join(TEMP_BASE, "dex-ai-stt-route")), transcriber);

    const response = await postWav(app, buildWavBytes({ sampleRate: 44100 }));

    expect(response.status).toBe(400);
    const body = await readErrorBody(response);
    expect(body.error).toBe("invalid_wav");
    expect(body.message).toContain("16000");
  });

  it("rejects an oversized body before invoking the transcriber", async () => {
    const { transcribe, transcriber } = fakeTranscriber("never returned");
    const app = buildSttApp(buildSttRouteConfig(join(TEMP_BASE, "dex-ai-stt-route")), transcriber);

    const response = await postWav(app, Buffer.alloc(MAX_WAV_BYTES + 1, 0));

    expect(response.status).toBe(413);
    const body = await readErrorBody(response);
    expect(body.error).toBe("payload_too_large");
    expect(body.message).toContain(String(MAX_WAV_BYTES));
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("returns the typed unavailability error when the local model is missing", async () => {
    const config = buildSttRouteConfig(join(TEMP_BASE, "dex-ai-stt-route"));
    const app = buildSttApp(config, failingTranscriber(new SttUnavailableError(`Parakeet model files missing in ${config.parakeetModelPath}`)));

    const response = await postWav(app, buildWavBytes());

    expect(response.status).toBe(503);
    const body = await readErrorBody(response);
    expect(body.error).toBe("stt_unavailable");
    expect(body.message).toContain("model files missing");
  });

  it("reports an unexpected transcription failure as a server error", async () => {
    const app = buildSttApp(
      buildSttRouteConfig(join(TEMP_BASE, "dex-ai-stt-route")),
      failingTranscriber(new Error("worker crashed")),
    );

    const response = await postWav(app, buildWavBytes());

    expect(response.status).toBe(500);
    const body = await readErrorBody(response);
    expect(body.error).toBe("transcription_failed");
    expect(body.message).toBe("worker crashed");
  });

  it("performs no database write for a successful transcription", async () => {
    const dataDir = mkdtempSync(join(TEMP_BASE, "dex-ai-stt-db-"));
    const database = openSqliteDatabase(join(dataDir, "control-plane.sqlite"));
    try {
      await runMigrations(database);
      const statements: string[] = [];
      const originalPrepare = database.prepare.bind(database);
      const originalExec = database.exec.bind(database);
      database.prepare = (sql: string) => {
        statements.push(sql);
        return originalPrepare(sql);
      };
      database.exec = (sql: string) => {
        statements.push(sql);
        return originalExec(sql);
      };

      const { transcriber } = fakeTranscriber("local transcript only");
      const app = buildSttApp(buildSttRouteConfig(dataDir), transcriber);
      const response = await postWav(app, buildWavBytes());

      expect(response.status).toBe(200);
      // AC-16: audio and transcripts stay on the device; nothing is persisted.
      expect(statements).toEqual([]);
      for (const table of ["events", "teaching_drafts", "traces"]) {
        const count = (
          database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
        ).count;
        expect(count).toBe(0);
      }
    } finally {
      database.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
