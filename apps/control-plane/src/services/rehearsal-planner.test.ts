import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rehearsalActionSchema, type RehearsalAction } from "@dex-ai/shared";
import { DeterministicAgentAdapter } from "../agent/deterministic-adapter";
import { upsertSession } from "../repositories/sessions";
import { StreamHub } from "../stream/hub";
import {
  makeSessionDescriptor,
  openTestDatabase,
  recordingStreamClient,
  streamMessagesOfType,
  type RecordingStreamClient,
  type TestDatabase,
} from "../test-server";
import {
  classifySubmitAttempt,
  pageSnapshotSchema,
  planRehearsal,
  RehearsalPlannerError,
  type PageSnapshot,
  type RehearsalPlannerDeps,
} from "./rehearsal-planner";

const POSTING_URL = "http://127.0.0.1:8787/fixtures/job/posting.html";
const APPLY_URL = "http://127.0.0.1:8787/fixtures/job/apply.html";
const SUBMIT_URL = "http://127.0.0.1:8787/fixtures/job/apply/submit";

const NAVIGATE_TO_APPLY: RehearsalAction = { kind: "navigate", url: APPLY_URL };
const FILL_NAME: RehearsalAction = { kind: "fill", selector: "#full-name", value: "Jordan Lee" };

let testDb: TestDatabase;
let hub: StreamHub;
let client: RecordingStreamClient;

beforeEach(async () => {
  testDb = await openTestDatabase();
  hub = new StreamHub();
  client = recordingStreamClient();
  hub.subscribe(client);
});

afterEach(() => {
  testDb.dispose();
});

async function seedSessionId(): Promise<string> {
  const session = makeSessionDescriptor();
  await upsertSession(testDb.db, session, new Date());
  return session.id;
}

function plannerDeps(adapter: DeterministicAgentAdapter): RehearsalPlannerDeps {
  return { database: testDb.database, db: testDb.db, hub, adapter };
}

function scriptedPlanAdapter(
  actions: Array<{ action: RehearsalAction; confidence: number }>,
): DeterministicAgentAdapter {
  return new DeterministicAgentAdapter({
    rehearsalPlan: {
      reasoning: ["Scripted planning reasoning."],
      result: {
        postingUrl: POSTING_URL,
        reasoningTrace: "Scripted plan for the test.",
        actions: actions.map((item) => ({
          action: item.action,
          confidence: item.confidence,
          reasoning: "Scripted action reasoning.",
        })),
      },
    },
  });
}

const SUBMIT_MARKED_SNAPSHOT: PageSnapshot = pageSnapshotSchema.parse({
  url: APPLY_URL,
  fields: [{ selector: "#full-name" }, { selector: "#submit-application", submits: true }],
});

describe("classifySubmitAttempt", () => {
  it("flags navigation to a submit url as submit_navigation", () => {
    const reason = classifySubmitAttempt({ kind: "navigate", url: SUBMIT_URL }, SUBMIT_MARKED_SNAPSHOT);
    expect(reason).toBe("submit_navigation");
  });

  it("flags activation of a submit-named control as submit_activation", () => {
    const reason = classifySubmitAttempt(
      { kind: "click_non_submit", selector: "#submit-application" },
      SUBMIT_MARKED_SNAPSHOT,
    );
    expect(reason).toBe("submit_activation");
  });

  it("flags any interaction with a snapshot-marked submit control", () => {
    const reason = classifySubmitAttempt(
      { kind: "fill", selector: "#submit-application", value: "pressed" },
      SUBMIT_MARKED_SNAPSHOT,
    );
    expect(reason).toBe("submit_control");
  });

  it("allows benign navigation, filling, scrolling and waiting", () => {
    expect(classifySubmitAttempt(NAVIGATE_TO_APPLY, SUBMIT_MARKED_SNAPSHOT)).toBeNull();
    expect(classifySubmitAttempt(FILL_NAME, SUBMIT_MARKED_SNAPSHOT)).toBeNull();
    expect(classifySubmitAttempt({ kind: "scroll", deltaY: 200 }, SUBMIT_MARKED_SNAPSHOT)).toBeNull();
    expect(classifySubmitAttempt({ kind: "wait", durationMs: 200 }, SUBMIT_MARKED_SNAPSHOT)).toBeNull();
  });
});

describe("planRehearsal", () => {
  it("returns only the shared action vocabulary and records the completed task and trace", async () => {
    const sessionId = await seedSessionId();
    const outcome = await planRehearsal(plannerDeps(new DeterministicAgentAdapter()), {
      sessionId,
      postingUrl: POSTING_URL,
      snapshot: null,
    });

    expect(outcome.actions.map((planned) => planned.action.kind)).toEqual(["navigate", "fill", "fill"]);
    for (const planned of outcome.actions) {
      // The vocabulary has no submit kind, so every planned action parses
      // against the shared schema that excludes it.
      expect(() => rehearsalActionSchema.parse(planned.action)).not.toThrow();
      expect(planned.blockReason).toBeNull();
      expect(planned.reasoning.length).toBeGreaterThan(0);
    }
    expect(() => rehearsalActionSchema.parse({ kind: "submit", selector: "#apply" })).toThrow();

    const task = testDb.database
      .prepare("SELECT status, error FROM agent_tasks WHERE id = ?")
      .get(outcome.taskId) as { status: string; error: string | null };
    expect(task.status).toBe("completed");
    expect(task.error).toBeNull();
    expect(
      testDb.database.prepare("SELECT COUNT(*) AS count FROM traces WHERE task_id = ?").get(outcome.taskId),
    ).toEqual({ count: 1 });
    expect(streamMessagesOfType(client.messages, "trace.completed")).toHaveLength(1);
    expect(streamMessagesOfType(client.messages, "trace.delta")).toHaveLength(3);
  });

  it("flags submit-shaped actions in the plan instead of proposing them", async () => {
    const sessionId = await seedSessionId();
    const outcome = await planRehearsal(
      plannerDeps(
        scriptedPlanAdapter([
          { action: { kind: "navigate", url: SUBMIT_URL }, confidence: 0.9 },
          { action: FILL_NAME, confidence: 0.9 },
        ]),
      ),
      { sessionId, postingUrl: POSTING_URL, snapshot: null },
    );

    expect(outcome.actions[0]?.blockReason).toBe("submit_navigation");
    expect(outcome.actions[1]?.blockReason).toBeNull();
  });

  it("fails the task without storing an action when the plan proposes a submit kind", async () => {
    const sessionId = await seedSessionId();
    const adapter = new DeterministicAgentAdapter({
      rehearsalPlan: {
        reasoning: ["Thinking about submitting."],
        result: {
          postingUrl: POSTING_URL,
          reasoningTrace: "Invalid plan.",
          actions: [
            {
              action: { kind: "submit", selector: "#apply" },
              confidence: 0.9,
              reasoning: "Try to submit the application.",
            },
          ],
        },
      },
    });

    await expect(
      planRehearsal(plannerDeps(adapter), { sessionId, postingUrl: POSTING_URL, snapshot: null }),
    ).rejects.toBeInstanceOf(RehearsalPlannerError);

    const tasks = testDb.database
      .prepare("SELECT status, error FROM agent_tasks")
      .all() as Array<{ status: string; error: string | null }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("failed");
    expect(tasks[0]?.error).toContain("rehearsalPlan");
    expect(testDb.database.prepare("SELECT COUNT(*) AS count FROM traces").get()).toEqual({ count: 1 });
    expect(streamMessagesOfType(client.messages, "task.failed")).toHaveLength(1);
  });
});
