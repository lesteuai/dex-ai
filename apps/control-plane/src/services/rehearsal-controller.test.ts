import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RehearsalAction } from "@dex-ai/shared";
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
import { RehearsalController } from "./rehearsal-controller";
import { pageSnapshotSchema, type PageSnapshot } from "./rehearsal-planner";

const POSTING_URL = "http://127.0.0.1:8787/fixtures/job/posting.html";
const APPLY_URL = "http://127.0.0.1:8787/fixtures/job/apply.html";

let testDb: TestDatabase;
let hub: StreamHub;
let client: RecordingStreamClient;
let sessionId: string;

beforeEach(async () => {
  testDb = await openTestDatabase();
  hub = new StreamHub();
  client = recordingStreamClient();
  hub.subscribe(client);
  const session = makeSessionDescriptor();
  await upsertSession(testDb.db, session, new Date());
  sessionId = session.id;
});

afterEach(() => {
  testDb.dispose();
});

function controller(defaultConfidenceThreshold = 0.7): RehearsalController {
  return new RehearsalController({
    database: testDb.database,
    db: testDb.db,
    hub,
    adapter: new DeterministicAgentAdapter(),
    defaultConfidenceThreshold,
    autonomyRequiredCount: 3,
  });
}

async function startRehearsal(control: RehearsalController, confidenceThreshold?: number) {
  return control.startRehearsal({
    sessionId,
    postingUrl: POSTING_URL,
    ...(confidenceThreshold === undefined ? {} : { confidenceThreshold }),
  });
}

async function currentAction(control: RehearsalController, rehearsalId: string) {
  const view = await control.getRehearsal(rehearsalId);
  if (!view) throw new Error("Expected the rehearsal to exist");
  const current = view.actions.find((action) => action.id === view.rehearsal.currentActionId);
  if (!current) throw new Error("Expected a current rehearsal action");
  return current;
}

function applySnapshot(url: string, fields: PageSnapshot["fields"]): PageSnapshot {
  return pageSnapshotSchema.parse({ url, fields });
}

describe("RehearsalController", () => {
  it("auto-approves confident actions and completes the rehearsal", async () => {
    const control = controller();
    const { rehearsal } = await startRehearsal(control);
    expect(rehearsal.status).toBe("running");

    const first = await currentAction(control, rehearsal.id);
    expect(first.status).toBe("approved");

    const afterFirst = await control.reportExecuted(rehearsal.id, first.id);
    expect(afterFirst.action?.status).toBe("executed");
    const second = await currentAction(control, rehearsal.id);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("approved");

    await control.reportExecuted(rehearsal.id, second.id);
    const third = await currentAction(control, rehearsal.id);
    expect(third.status).toBe("approved");

    const final = await control.reportExecuted(rehearsal.id, third.id);
    expect(final.rehearsal.status).toBe("completed");
    expect(final.rehearsal.currentActionId).toBeNull();

    const view = await control.getRehearsal(rehearsal.id);
    expect(view?.actions.map((action) => action.status)).toEqual([
      "executed",
      "executed",
      "executed",
    ]);
    expect(streamMessagesOfType(client.messages, "rehearsal.executed")).toHaveLength(3);
  });

  it("pauses a low-confidence action before execution and executes it only after approval", async () => {
    const control = controller();
    const { rehearsal } = await startRehearsal(control, 0.99);
    expect(rehearsal.status).toBe("paused");

    const proposed = await currentAction(control, rehearsal.id);
    expect(proposed.status).toBe("proposed");
    await expect(control.reportExecuted(rehearsal.id, proposed.id)).rejects.toMatchObject({
      status: 409,
      error: "rehearsal_not_running",
    });

    const approved = await control.applyDecision(rehearsal.id, {
      type: "approve",
      actionId: proposed.id,
    });
    expect(approved.rehearsal.status).toBe("running");
    expect(approved.action?.status).toBe("approved");

    const executed = await control.reportExecuted(rehearsal.id, proposed.id);
    expect(executed.action?.status).toBe("executed");
    expect(streamMessagesOfType(client.messages, "rehearsal.paused").at(-1)?.payload.reason).toBe(
      "low_confidence",
    );
  });

  it("changes the proposed action when the user corrects it", async () => {
    const control = controller();
    const { rehearsal } = await startRehearsal(control, 0.99);
    const proposed = await currentAction(control, rehearsal.id);
    const corrected: RehearsalAction = { kind: "fill", selector: "#full-name", value: "Jordan Corrected" };

    const decided = await control.applyDecision(rehearsal.id, {
      type: "correct",
      actionId: proposed.id,
      action: corrected,
    });

    expect(decided.action?.action).toEqual(corrected);
    expect(decided.action?.confidence).toBe(1);
    expect(decided.action?.status).toBe("approved");
    expect(decided.rehearsal.status).toBe("running");
  });

  it("pauses on a user pause decision and resumes on the resume decision", async () => {
    const control = controller();
    const { rehearsal } = await startRehearsal(control);

    const paused = await control.applyDecision(rehearsal.id, { type: "pause" });
    expect(paused.rehearsal.status).toBe("paused");
    const proposed = await currentAction(control, rehearsal.id);
    expect(proposed.status).toBe("proposed");
    await expect(control.reportExecuted(rehearsal.id, proposed.id)).rejects.toMatchObject({
      status: 409,
      error: "rehearsal_not_running",
    });

    const resumed = await control.applyDecision(rehearsal.id, { type: "resume" });
    expect(resumed.rehearsal.status).toBe("running");
    const current = await currentAction(control, rehearsal.id);
    expect(current.status).toBe("approved");
  });

  it("executes nothing after a disconnect until the rehearsal is explicitly resumed", async () => {
    const control = controller();
    const { rehearsal } = await startRehearsal(control);

    const disconnected = await control.markDisconnected(rehearsal.id);
    expect(disconnected.rehearsal.status).toBe("paused");
    const proposed = await currentAction(control, rehearsal.id);
    expect(proposed.status).toBe("proposed");
    expect(streamMessagesOfType(client.messages, "rehearsal.paused").at(-1)?.payload.reason).toBe(
      "disconnected",
    );

    // Approval alone does not resume a disconnected rehearsal.
    const approved = await control.applyDecision(rehearsal.id, {
      type: "approve",
      actionId: proposed.id,
    });
    expect(approved.rehearsal.status).toBe("paused");
    await expect(control.reportExecuted(rehearsal.id, proposed.id)).rejects.toMatchObject({
      status: 409,
      error: "rehearsal_not_running",
    });

    const resumed = await control.applyDecision(rehearsal.id, { type: "resume" });
    expect(resumed.rehearsal.status).toBe("running");
    const executed = await control.reportExecuted(rehearsal.id, proposed.id);
    expect(executed.action?.status).toBe("executed");
  });

  it("records a submit attempt the extension guard refused to perform", async () => {
    const control = controller();
    const { rehearsal } = await startRehearsal(control);
    const submitUrl = "http://127.0.0.1:8787/fixtures/job/apply/submit";

    const recorded = await control.recordBlockedAttempt(rehearsal.id, {
      reason: "submit_navigation",
      url: submitUrl,
    });

    expect(recorded.action?.status).toBe("blocked");
    expect(recorded.action?.action).toEqual({ kind: "navigate", url: submitUrl });
    expect(recorded.action?.sequence).toBe(4);
    const view = await control.getRehearsal(rehearsal.id);
    expect(view?.actions.filter((action) => action.status === "blocked")).toHaveLength(1);
    expect(streamMessagesOfType(client.messages, "rehearsal.blocked")).toHaveLength(1);
  });

  it("records a submit-shaped correction as blocked and keeps it blocked after approval", async () => {
    const control = controller();
    const { rehearsal } = await startRehearsal(control, 0.99);
    const proposed = await currentAction(control, rehearsal.id);

    const decided = await control.applyDecision(rehearsal.id, {
      type: "correct",
      actionId: proposed.id,
      action: { kind: "click_non_submit", selector: "#submit-application" },
    });
    expect(decided.action?.status).toBe("blocked");
    expect(streamMessagesOfType(client.messages, "rehearsal.blocked").at(-1)?.payload.reason).toBe(
      "submit_activation",
    );

    await expect(
      control.applyDecision(rehearsal.id, { type: "approve", actionId: proposed.id }),
    ).rejects.toMatchObject({ status: 409, error: "submit_blocked" });

    const view = await control.getRehearsal(rehearsal.id);
    expect(view?.actions.find((action) => action.id === proposed.id)?.status).toBe("blocked");
  });

  it("keeps executed and approved actions when replanning from a snapshot", async () => {
    const control = controller();
    const { rehearsal } = await startRehearsal(control);
    const first = await currentAction(control, rehearsal.id);
    await control.reportExecuted(rehearsal.id, first.id);
    // The second action is confident, so it was auto-approved and is current.
    const approved = await currentAction(control, rehearsal.id);
    expect(approved.status).toBe("approved");

    const view = await control.acceptPageSnapshot(
      rehearsal.id,
      applySnapshot(APPLY_URL, [{ selector: "#full-name" }, { selector: "#email" }]),
    );

    expect(view.actions.find((action) => action.id === first.id)?.status).toBe("executed");
    expect(view.actions.find((action) => action.id === approved.id)?.status).toBe("approved");
    expect(view.rehearsal.currentActionId).toBe(approved.id);
    // The undecided proposal was discarded and the fresh plan follows it.
    expect(view.actions.some((action) => action.sequence === 3)).toBe(false);
    expect(
      view.actions
        .filter((action) => action.sequence >= 4)
        .map((action) => action.status),
    ).toEqual(["proposed", "proposed", "proposed"]);
  });

  it("blocks an approved action the snapshot reveals to be a submit control", async () => {
    const control = controller();
    const { rehearsal } = await startRehearsal(control);
    const first = await currentAction(control, rehearsal.id);
    await control.reportExecuted(rehearsal.id, first.id);
    const approved = await currentAction(control, rehearsal.id);

    const view = await control.acceptPageSnapshot(
      rehearsal.id,
      applySnapshot(APPLY_URL, [{ selector: "#full-name", submits: true }]),
    );

    expect(view.actions.find((action) => action.id === approved.id)?.status).toBe("blocked");
    // The replan of the same submit control is blocked as well.
    expect(view.actions.find((action) => action.sequence === 5)?.status).toBe("blocked");
    // The pointer moved to a fresh confident proposal, so the rehearsal keeps running.
    expect(view.rehearsal.status).toBe("running");
    const next = view.actions.find((action) => action.id === view.rehearsal.currentActionId);
    expect(next?.status).toBe("approved");
    expect(
      streamMessagesOfType(client.messages, "rehearsal.blocked").map((event) => event.payload.reason),
    ).toEqual(["submit_control", "submit_control"]);
  });
});
