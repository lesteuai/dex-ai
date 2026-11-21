import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentStartInput } from "./adapter";
import { createAgentAdapter } from "./factory";
import { OpenCodeAgentAdapter } from "./opencode-adapter";

// Constructing the adapter never hosts OpenCode, but the SDK module stays
// mocked so the test does not even load the real package.
vi.mock("@opencode/sdk", () => ({
  OpenCode: { create: vi.fn() },
}));

const TEMP_BASE = "/tmp/opencode";
const createdDataDirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(TEMP_BASE, "dex-ai-factory-"));
  createdDataDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function collectProfileInferenceEvents(
  adapter: ReturnType<typeof createAgentAdapter>,
): Promise<AgentEvent[]> {
  const input: AgentStartInput = {
    taskId: randomUUID(),
    kind: "profile_inference",
    sessionId: randomUUID(),
    prompt: "factory selection probe",
    resultSchema: "profile",
    signal: new AbortController().signal,
  };
  const events: AgentEvent[] = [];
  for await (const event of adapter.start(input)) events.push(event);
  return events;
}

describe("createAgentAdapter selection", () => {
  it("returns the deterministic adapter for kind deterministic", async () => {
    const host = createAgentAdapter({ kind: "deterministic" });

    const events = await collectProfileInferenceEvents(host);
    expect(events.some((event) => event.type === "result")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "status", status: "completed" });
    await host.close();
  });

  it("returns the OpenCode adapter for kind opencode", async () => {
    const host = createAgentAdapter({ kind: "opencode", dataDir: tempDataDir() });

    expect(host).toBeInstanceOf(OpenCodeAgentAdapter);
    // Closing without a started task never reaches the SDK host.
    await host.close();
  });
});
