import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RehearsalAction, Rule } from "@dex-ai/shared";
import { DeterministicAgentAdapter } from "../agent/deterministic-adapter";
import { buildRehearsalPlanPrompt } from "../agent/prompts";
import { createUserRule, listRules } from "../repositories/rules";
import { listRevisions, listSessionRevisions } from "../repositories/revisions";
import { upsertSession } from "../repositories/sessions";
import { insertTrace, listSessionTraces } from "../repositories/traces";
import { makeSessionDescriptor, openTestDatabase, type TestDatabase } from "../test-server";
import {
  CorrectionPropagationError,
  propagateCorrection,
  type CorrectionPropagationDeps,
} from "./correction-propagation";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await openTestDatabase();
});

afterEach(() => {
  testDb.dispose();
});

function correctionDeps(adapter: DeterministicAgentAdapter): CorrectionPropagationDeps {
  return { database: testDb.database, db: testDb.db, adapter };
}

const PRIOR_FILL: RehearsalAction = {
  kind: "fill",
  selector: "#email",
  value: "wrong-address@example.net",
};
const CORRECTED_FILL: RehearsalAction = {
  kind: "fill",
  selector: "#email",
  value: "jordan.lee@example.com",
};

async function seedRule(condition: unknown, action: unknown, reason: string): Promise<Rule> {
  const { rule } = await createUserRule(testDb.database, testDb.db, {
    scope: "rehearsal.fill",
    condition,
    action,
    confidence: 0.8,
    reason,
  });
  return rule;
}

/** A session with one decision trace citing the given contributing rules. */
async function seedCorrectionSession(contributingRuleIds: string[]): Promise<{
  sessionId: string;
  traceId: string;
}> {
  const session = makeSessionDescriptor();
  await upsertSession(testDb.db, session, new Date());
  const traceId = randomUUID();
  await insertTrace(testDb.db, {
    id: traceId,
    taskId: null,
    sessionId: session.id,
    eventId: null,
    step: 0,
    input: { kind: "rehearsal_planning" },
    reasoning: "planned the wrong email fill",
    output: { contributingRuleIds },
    confidence: null,
    createdAt: new Date(),
  });
  return { sessionId: session.id, traceId };
}

function scriptedCorrectionAdapter(
  ruleUpdates: Array<{
    ruleId: string;
    condition: unknown;
    action: unknown;
    confidence: number;
    changeReason: string;
  }>,
): DeterministicAgentAdapter {
  return new DeterministicAgentAdapter({
    correction: {
      reasoning: ["The user corrected the email value, so the contributing rules must change."],
      result: {
        reasoningTrace: "Every contributing rule now prescribes the corrected email value.",
        ruleUpdates,
      },
    },
  });
}

async function propagateWithDefaults(
  adapter: DeterministicAgentAdapter,
  seeded: { sessionId: string; traceId: string },
) {
  return propagateCorrection(correctionDeps(adapter), {
    sessionId: seeded.sessionId,
    traceId: seeded.traceId,
    priorAction: PRIOR_FILL,
    correctedAction: CORRECTED_FILL,
    correctionReason: "That is not my email address.",
  });
}

describe("propagateCorrection", () => {
  it("updates every contributing rule and leaves an unrelated rule untouched", async () => {
    const emailRule = await seedRule(
      { selector: "#email" },
      { fillValueFrom: "profile.wrong_email" },
      "Use the wrong email source",
    );
    const labelRule = await seedRule(
      { fieldLabelContains: "email" },
      { fillValueFrom: "profile.wrong_email" },
      "Fill email fields from the wrong source",
    );
    const phoneRule = await seedRule(
      { selector: "#phone" },
      { fillValueFrom: "profile.phone" },
      "Fill the phone from the profile",
    );
    const seeded = await seedCorrectionSession([emailRule.id, labelRule.id]);

    const write = await propagateWithDefaults(
      scriptedCorrectionAdapter([
        {
          ruleId: emailRule.id,
          condition: { selector: "#email" },
          action: { fillValueFrom: "profile.email" },
          confidence: 0.95,
          changeReason: "The corrected fill replaces the wrong email source.",
        },
        {
          ruleId: labelRule.id,
          condition: { fieldLabelContains: "email" },
          action: { fillValueFrom: "profile.email" },
          confidence: 0.9,
          changeReason: "Label-matched email fields need the corrected source too.",
        },
      ]),
      seeded,
    );

    expect(write.updatedRules.map((rule) => rule.id).sort()).toEqual(
      [emailRule.id, labelRule.id].sort(),
    );

    const stored = await listRules(testDb.db);
    expect(stored.find((rule) => rule.id === emailRule.id)).toMatchObject({
      action: { fillValueFrom: "profile.email" },
      confidence: 0.95,
      status: "corrected",
    });
    expect(stored.find((rule) => rule.id === labelRule.id)).toMatchObject({
      action: { fillValueFrom: "profile.email" },
      confidence: 0.9,
      status: "corrected",
    });
    // The phone rule never contributed, so the correction leaves it as it was.
    expect(stored.find((rule) => rule.id === phoneRule.id)).toEqual(phoneRule);

    expect(
      testDb.database.prepare("SELECT kind, status FROM agent_tasks").all(),
    ).toEqual([{ kind: "correction_propagation", status: "completed" }]);
  });

  it("records one trace-linked revision per contributing rule and keeps earlier history", async () => {
    const emailRule = await seedRule(
      { selector: "#email" },
      { fillValueFrom: "profile.wrong_email" },
      "Use the wrong email source",
    );
    const labelRule = await seedRule(
      { fieldLabelContains: "email" },
      { fillValueFrom: "profile.wrong_email" },
      "Fill email fields from the wrong source",
    );
    const seeded = await seedCorrectionSession([emailRule.id, labelRule.id]);

    const write = await propagateWithDefaults(
      scriptedCorrectionAdapter([
        {
          ruleId: emailRule.id,
          condition: { selector: "#email" },
          action: { fillValueFrom: "profile.email" },
          confidence: 0.95,
          changeReason: "The corrected fill replaces the wrong email source.",
        },
        {
          ruleId: labelRule.id,
          condition: { fieldLabelContains: "email" },
          action: { fillValueFrom: "profile.email" },
          confidence: 0.9,
          changeReason: "Label-matched email fields need the corrected source too.",
        },
      ]),
      seeded,
    );

    const revisions = await listSessionRevisions(testDb.db, seeded.sessionId);
    expect(revisions.map((revision) => revision.entityId).sort()).toEqual(
      [emailRule.id, labelRule.id].sort(),
    );
    for (const revision of revisions) {
      expect(revision.actor).toBe("agent");
      expect(revision.sourceSessionId).toBe(seeded.sessionId);
      expect(revision.traceId).toBe(write.trace.id);
    }

    const emailRevision = revisions.find((revision) => revision.entityId === emailRule.id);
    expect(emailRevision?.before).toMatchObject({ action: { fillValueFrom: "profile.wrong_email" } });
    expect(emailRevision?.after).toMatchObject({ action: { fillValueFrom: "profile.email" } });
    expect(emailRevision?.reason).toContain("corrected fill");

    // The correction trace itself is stored in the session it corrected.
    const traces = await listSessionTraces(testDb.db, seeded.sessionId);
    const correctionTrace = traces.find((trace) => trace.id === write.trace.id);
    expect(correctionTrace?.output).toMatchObject({
      contributingRuleIds: [emailRule.id, labelRule.id],
    });

    // The full history keeps the user's creation revisions alongside the new ones.
    const all = await listRevisions(testDb.db, {});
    expect(all.filter((revision) => revision.actor === "user")).toHaveLength(2);
    expect(all.filter((revision) => revision.actor === "agent")).toHaveLength(2);
    expect(all).toHaveLength(4);
  });

  it("does not let the corrected decision recur in the next similar session", async () => {
    const emailRule = await seedRule(
      { selector: "#email" },
      { fillValueFrom: "profile.wrong_email" },
      "Use the wrong email source",
    );
    const seeded = await seedCorrectionSession([emailRule.id]);

    // No explicit trace id: the correction falls back to the session's latest trace.
    const write = await propagateCorrection(
      correctionDeps(
        scriptedCorrectionAdapter([
          {
            ruleId: emailRule.id,
            condition: { selector: "#email" },
            action: { fillValueFrom: "profile.email" },
            confidence: 0.95,
            changeReason: "The corrected fill replaces the wrong email source.",
          },
        ]),
      ),
      {
        sessionId: seeded.sessionId,
        traceId: null,
        priorAction: PRIOR_FILL,
        correctedAction: CORRECTED_FILL,
        correctionReason: "That is not my email address.",
      },
    );
    expect(write.trace.sessionId).toBe(seeded.sessionId);

    // The next similar session's planning task reads the stored rules, and no
    // stored rule still prescribes the prior wrong action.
    const rules = await listRules(testDb.db);
    expect(
      rules.some((rule) => JSON.stringify(rule.action).includes("profile.wrong_email")),
    ).toBe(false);
    expect(rules.some((rule) => JSON.stringify(rule.action).includes("profile.email"))).toBe(true);

    const prompt = buildRehearsalPlanPrompt({
      postingUrl: "http://127.0.0.1:8787/fixtures/job/posting.html",
      entries: [],
      rules,
    });
    expect(prompt).toContain('"fillValueFrom": "profile.email"');
    expect(prompt).not.toContain("profile.wrong_email");
  });

  it("rejects a fabricated rule update outside the contributing set", async () => {
    const emailRule = await seedRule(
      { selector: "#email" },
      { fillValueFrom: "profile.wrong_email" },
      "Use the wrong email source",
    );
    const bystanderRule = await seedRule(
      { selector: "#phone" },
      { fillValueFrom: "profile.phone" },
      "Fill the phone from the profile",
    );
    const seeded = await seedCorrectionSession([emailRule.id]);

    await expect(
      propagateWithDefaults(
        scriptedCorrectionAdapter([
          {
            ruleId: bystanderRule.id,
            condition: { selector: "#phone" },
            action: { fillValueFrom: "profile.phone" },
            confidence: 0.9,
            changeReason: "A fabricated update naming a rule that never contributed.",
          },
        ]),
        seeded,
      ),
    ).rejects.toMatchObject({
      code: "unknown_rule_update",
      httpStatus: 502,
    } satisfies Partial<CorrectionPropagationError>);

    // The failed task and trace stay inspectable, but nothing changed.
    expect(testDb.database.prepare("SELECT status, error FROM agent_tasks").all()).toEqual([
      { status: "failed", error: expect.stringContaining("did not contribute") },
    ]);
    const traces = await listSessionTraces(testDb.db, seeded.sessionId);
    const failedTrace = traces.find((trace) => trace.id !== seeded.traceId);
    expect(failedTrace?.reasoning).toContain("did not contribute");
    expect(failedTrace?.output).toMatchObject({ error: expect.stringContaining("did not contribute") });

    const stored = await listRules(testDb.db);
    expect(stored.find((rule) => rule.id === emailRule.id)).toEqual(emailRule);
    expect(stored.find((rule) => rule.id === bystanderRule.id)).toEqual(bystanderRule);
    expect((await listRevisions(testDb.db, {})).filter((revision) => revision.actor === "agent")).toEqual([]);
  });

  it("records a failed task and trace, then rejects without updating rules", async () => {
    const emailRule = await seedRule(
      { selector: "#email" },
      { fillValueFrom: "profile.wrong_email" },
      "Use the wrong email source",
    );
    const seeded = await seedCorrectionSession([emailRule.id]);
    const adapter = new DeterministicAgentAdapter({
      correction: { reasoning: ["thinking"], result: {}, failWith: "the provider connection dropped" },
    });

    await expect(propagateWithDefaults(adapter, seeded)).rejects.toMatchObject({
      code: "agent_failed",
      httpStatus: 502,
    } satisfies Partial<CorrectionPropagationError>);

    expect(testDb.database.prepare("SELECT status, error FROM agent_tasks").all()).toEqual([
      { status: "failed", error: "the provider connection dropped" },
    ]);
    const traces = await listSessionTraces(testDb.db, seeded.sessionId);
    expect(traces.find((trace) => trace.id !== seeded.traceId)?.reasoning).toBe(
      "the provider connection dropped",
    );
    expect((await listRules(testDb.db)).find((rule) => rule.id === emailRule.id)).toEqual(emailRule);
    expect(await listSessionRevisions(testDb.db, seeded.sessionId)).toEqual([]);
  });

  it("returns typed failures for an unknown session or decision trace", async () => {
    const deps = correctionDeps(new DeterministicAgentAdapter());

    await expect(
      propagateCorrection(deps, {
        sessionId: randomUUID(),
        traceId: null,
        priorAction: PRIOR_FILL,
        correctedAction: CORRECTED_FILL,
        correctionReason: "That is not my email address.",
      }),
    ).rejects.toMatchObject({ code: "session_not_found", httpStatus: 404 });

    const seeded = await seedCorrectionSession([]);
    await expect(
      propagateCorrection(deps, {
        sessionId: seeded.sessionId,
        traceId: randomUUID(),
        priorAction: PRIOR_FILL,
        correctedAction: CORRECTED_FILL,
        correctionReason: "That is not my email address.",
      }),
    ).rejects.toMatchObject({ code: "trace_not_found", httpStatus: 404 });

    // Both failures rejected the request before any task ran.
    expect(testDb.database.prepare("SELECT COUNT(*) AS count FROM agent_tasks").get()).toEqual({
      count: 0,
    });
  });
});
