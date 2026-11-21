import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentTaskKindSchema,
  normalizeAgentEvent,
  type AgentAdapter,
  type AgentEvent,
  type AgentResultSchemaName,
  type AgentStartInput,
  type AgentTaskKind,
} from "./adapter";
import { defaultScriptedFixtures, DeterministicAgentAdapter } from "./deterministic-adapter";
import { parseAgentResult } from "./results";

const KIND_TO_RESULT_SCHEMA: Record<AgentTaskKind, AgentResultSchemaName> = {
  profile_inference: "profile",
  teaching: "rules",
  rehearsal_planning: "rehearsalPlan",
  correction_propagation: "correction",
};

const TASK_KINDS = agentTaskKindSchema.options;

function startInput(
  kind: AgentTaskKind,
  signal: AbortSignal = new AbortController().signal,
): AgentStartInput {
  return {
    taskId: randomUUID(),
    kind,
    sessionId: randomUUID(),
    prompt: `deterministic fixture prompt for ${kind}`,
    resultSchema: KIND_TO_RESULT_SCHEMA[kind],
    signal,
  };
}

// Collecting normalizes every event, so a drifted emission fails the test.
async function collectEvents(adapter: AgentAdapter, input: AgentStartInput): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of adapter.start(input)) {
    events.push(normalizeAgentEvent(event));
  }
  return events;
}

const resultIndex = (events: AgentEvent[]) => events.findIndex((event) => event.type === "result");

describe("DeterministicAgentAdapter", () => {
  const adapter = new DeterministicAgentAdapter();

  for (const kind of TASK_KINDS) {
    it(`emits a schema-valid ${KIND_TO_RESULT_SCHEMA[kind]} result for ${kind}`, async () => {
      const events = await collectEvents(adapter, startInput(kind));
      const result = events.find((event) => event.type === "result");

      expect(result).toBeDefined();
      expect(() => parseAgentResult(KIND_TO_RESULT_SCHEMA[kind], result?.value)).not.toThrow();
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events.at(-1)).toEqual({ type: "status", status: "completed" });
    });
  }

  it("emits reasoning events only before the result", async () => {
    for (const kind of TASK_KINDS) {
      const events = await collectEvents(adapter, startInput(kind));
      const afterResult = resultIndex(events);

      expect(events.filter((event) => event.type === "reasoning").length).toBeGreaterThan(0);
      for (const [index, event] of events.entries()) {
        if (event.type === "reasoning") {
          expect(index).toBeLessThan(afterResult);
        }
      }
    }
  });

  it("opens with a running status event", async () => {
    const events = await collectEvents(adapter, startInput("profile_inference"));
    expect(events.at(0)).toEqual({ type: "status", status: "running" });
  });

  it("stops before any emission when the AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collectEvents(adapter, startInput("teaching", controller.signal));

    expect(events).toEqual([{ type: "status", status: "cancelled" }]);
  });

  it("cancels a mid-stream task through cancel() without emitting a result", async () => {
    const input = startInput("profile_inference");
    const stream = adapter.start(input)[Symbol.asyncIterator]();

    expect((await stream.next()).value).toEqual({ type: "status", status: "running" });
    expect((await stream.next()).value?.type).toBe("reasoning");
    await adapter.cancel(input.taskId);

    const rest: AgentEvent[] = [];
    for (;;) {
      const next = await stream.next();
      if (next.done) break;
      rest.push(normalizeAgentEvent(next.value));
    }
    expect(rest).toEqual([{ type: "status", status: "cancelled" }]);
    expect(resultIndex(rest)).toBe(-1);
  });

  it("cancels a task that has not started yet through cancel()", async () => {
    const input = startInput("correction_propagation");
    await adapter.cancel(input.taskId);

    expect(await collectEvents(adapter, input)).toEqual([{ type: "status", status: "cancelled" }]);
  });

  it("keeps emitted reasoning when a fixture fails and ends failed without a result", async () => {
    const failing = new DeterministicAgentAdapter({
      ...defaultScriptedFixtures,
      rules: {
        reasoning: ["The transcript maps to one salary fill rule."],
        result: { rules: [] },
        failWith: "fixture provider unavailable",
      },
    });
    const events = await collectEvents(failing, startInput("teaching"));

    expect(events.some((event) => event.type === "reasoning")).toBe(true);
    expect(events).toContainEqual({ type: "error", message: "fixture provider unavailable" });
    expect(resultIndex(events)).toBe(-1);
    expect(events.at(-1)).toEqual({ type: "status", status: "failed" });
  });

  it("fails a task kind with no scripted fixture", async () => {
    const empty = new DeterministicAgentAdapter({});
    const events = await collectEvents(empty, startInput("rehearsal_planning"));

    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "error", message: "No scripted fixture for result schema rehearsalPlan" },
      { type: "status", status: "failed" },
    ]);
  });

  it("turns a fixture result that fails schema validation into an error and failed status", async () => {
    const invalid = new DeterministicAgentAdapter({
      profile: {
        reasoning: ["The fixture drifted from the profile schema."],
        result: {
          sections: [
            {
              section: "user_facts",
              entries: [
                {
                  key: "full_name",
                  value: "Jordan Lee",
                  confidence: 0.9,
                  sourceEventIds: [],
                  reasoningTrace: "No observed event backs this value.",
                },
              ],
            },
          ],
        },
      },
    });
    const events = await collectEvents(invalid, startInput("profile_inference"));

    const error = events.find((event) => event.type === "error");
    expect(error?.message).toContain("Agent profile result failed validation");
    expect(resultIndex(events)).toBe(-1);
    expect(events.at(-1)).toEqual({ type: "status", status: "failed" });
  });
});

describe("normalizeAgentEvent", () => {
  it("accepts the four normalized event shapes", () => {
    expect(normalizeAgentEvent({ type: "status", status: "running" })).toEqual({
      type: "status",
      status: "running",
    });
    expect(normalizeAgentEvent({ type: "reasoning", text: "Observed one search event." })).toEqual({
      type: "reasoning",
      text: "Observed one search event.",
    });
    expect(normalizeAgentEvent({ type: "result", value: { rules: [] } })).toEqual({
      type: "result",
      value: { rules: [] },
    });
    expect(normalizeAgentEvent({ type: "error", message: "provider unavailable" })).toEqual({
      type: "error",
      message: "provider unavailable",
    });
  });

  it("rejects unknown event types and empty payloads", () => {
    expect(() => normalizeAgentEvent({ type: "tool_call", name: "browser" })).toThrow();
    expect(() => normalizeAgentEvent({ type: "status", status: "done" })).toThrow();
    expect(() => normalizeAgentEvent({ type: "reasoning", text: "" })).toThrow();
    expect(() => normalizeAgentEvent({ type: "error", message: "" })).toThrow();
    expect(() => normalizeAgentEvent(null)).toThrow();
  });
});

describe("agent contract boundary", () => {
  // The deterministic path must stay importable without OpenCode or a network client.
  const CONTRACT_MODULES = [
    "adapter.ts",
    "deterministic-adapter.ts",
    "results.ts",
    "prompts.ts",
  ] as const;

  const BANNED_REFERENCES = [
    "@opencode",
    "@anthropic-ai",
    "@openai",
    "node:http",
    "node:https",
    "node:net",
    "undici",
    "fetch(",
    "WebSocket",
  ];

  it("imports neither OpenCode nor any network client", () => {
    const agentDir = dirname(fileURLToPath(import.meta.url));
    for (const name of CONTRACT_MODULES) {
      const source = readFileSync(join(agentDir, name), "utf8");
      for (const banned of BANNED_REFERENCES) {
        expect(source, `${name} must not reference ${banned}`).not.toContain(banned);
      }
    }
  });
});
