import { describe, expect, it } from "vitest";
import { z } from "zod";
import { wsEventSchema, type WsEvent } from "./index";

const ts = "2026-11-21T10:00:00.000Z";
const envelopeId = "0197a0f0-0000-7000-8000-000000000030";
const sessionId = "0197a0f0-0000-7000-8000-000000000031";
const traceId = "0197a0f0-0000-7000-8000-000000000032";
const taskId = "0197a0f0-0000-7000-8000-000000000033";
const entryId = "0197a0f0-0000-7000-8000-000000000034";
const revisionId = "0197a0f0-0000-7000-8000-000000000035";
const rehearsalId = "0197a0f0-0000-7000-8000-000000000036";
const actionId = "0197a0f0-0000-7000-8000-000000000037";

const sessionSummary = {
  id: sessionId,
  browserKind: "firefox",
  sourceUrl: "https://jobs.example.com/search",
  postingUrl: null,
  status: "active",
  startedAt: ts,
  endedAt: null,
};

const trace = {
  id: traceId,
  taskId,
  sessionId,
  eventId: null,
  step: 2,
  input: { prompt: "plan the next action" },
  reasoning: "the email field is empty",
  output: { kind: "fill" },
  confidence: 0.82,
  createdAt: ts,
};

const profileEntry = {
  id: entryId,
  section: "preferences",
  key: "team_size",
  value: "small teams",
  confidence: 0.6,
  status: "inferred",
  sourceEventIds: [traceId],
  updatedAt: ts,
};

const revision = {
  id: revisionId,
  entityType: "profile_entry",
  entityId: entryId,
  sourceSessionId: sessionId,
  traceId,
  actor: "user",
  before: "any team size",
  after: "small teams",
  reason: "user correction in the teaching console",
  createdAt: ts,
};

const actionRecordOf = (status: string) => ({
  id: actionId,
  rehearsalId,
  sequence: 1,
  action: { kind: "fill", selector: "#email", value: "ada@example.com" },
  confidence: 0.55,
  status,
  traceId,
  createdAt: ts,
});

const envelopeOf = (type: string, payload: unknown) => ({ type, id: envelopeId, ts, payload });

const failingPathsOf = (schema: z.ZodType, value: unknown): string[] => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected validation failure");
  return result.error.issues.map((issue) => issue.path.join("."));
};

// Switching on the parsed type narrows each payload. Typecheck enforces this.
const streamLabelOf = (event: WsEvent): string => {
  switch (event.type) {
    case "session.updated":
      return `session:${event.payload.session.status}`;
    case "trace.started":
      return `trace:${event.payload.trace.step}`;
    case "trace.delta":
      return `delta:${event.payload.traceId}`;
    case "trace.completed":
      return `trace:${event.payload.trace.step}`;
    case "task.failed":
      return `task:${event.payload.message}`;
    case "profile.updated":
      return `profile:${event.payload.entry.key}`;
    case "revision.created":
      return `revision:${event.payload.revision.actor}`;
    case "rehearsal.proposed":
      return `proposed:${event.payload.action.sequence}`;
    case "rehearsal.paused":
      return `paused:${event.payload.reason}`;
    case "rehearsal.executed":
      return `executed:${event.payload.action.sequence}`;
    case "rehearsal.blocked":
      return `blocked:${event.payload.reason}`;
  }
};

const sampleWsEvents: [unknown, string][] = [
  [envelopeOf("session.updated", { session: sessionSummary }), "session:active"],
  [envelopeOf("trace.started", { trace }), "trace:2"],
  [envelopeOf("trace.delta", { traceId, text: "checking the form" }), `delta:${traceId}`],
  [envelopeOf("trace.completed", { trace }), "trace:2"],
  [
    envelopeOf("task.failed", { taskId, message: "provider unavailable" }),
    "task:provider unavailable",
  ],
  [envelopeOf("profile.updated", { entry: profileEntry }), "profile:team_size"],
  [envelopeOf("revision.created", { revision }), "revision:user"],
  [
    envelopeOf("rehearsal.proposed", { action: actionRecordOf("proposed"), reasoning: "fill email" }),
    "proposed:1",
  ],
  [
    envelopeOf("rehearsal.paused", {
      rehearsalId,
      actionId,
      reason: "low_confidence",
    }),
    "paused:low_confidence",
  ],
  [envelopeOf("rehearsal.executed", { action: actionRecordOf("executed") }), "executed:1"],
  [
    envelopeOf("rehearsal.blocked", {
      action: actionRecordOf("blocked"),
      reason: "submit_activation",
    }),
    "blocked:submit_activation",
  ],
];

describe("WebSocket event union", () => {
  it.each(sampleWsEvents)("parses and narrows the %s envelope", (sample, expectedLabel) => {
    const parsed = wsEventSchema.parse(sample);

    expect(streamLabelOf(parsed)).toBe(expectedLabel);
  });

  it("rejects an undocumented event type at the discriminator", () => {
    const paths = failingPathsOf(wsEventSchema, envelopeOf("rehearsal.submitted", {}));

    expect(paths).toContain("type");
  });

  it("rejects a malformed payload with a field-specific error", () => {
    const paths = failingPathsOf(wsEventSchema, envelopeOf("trace.delta", { traceId }));

    expect(paths).toContain("payload.text");
  });

  it("rejects an undocumented pause reason", () => {
    const paths = failingPathsOf(
      wsEventSchema,
      envelopeOf("rehearsal.paused", { rehearsalId, actionId: null, reason: "user_cancelled" }),
    );

    expect(paths).toContain("payload.reason");
  });
});
