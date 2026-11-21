import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Rule } from "@dex-ai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StreamHub } from "../stream/hub";
import {
  openTestDatabase,
  recordingStreamClient,
  streamMessagesOfType,
  type TestDatabase,
} from "../test-server";
import { createRulesRoute } from "./rules";

let testDb: TestDatabase;
let hub: StreamHub;

beforeEach(async () => {
  testDb = await openTestDatabase();
  hub = new StreamHub();
});

afterEach(() => {
  hub.close();
  testDb.dispose();
});

function mountRulesRoute(): Hono {
  const app = new Hono();
  app.route("/api/rules", createRulesRoute({ database: testDb.database, db: testDb.db, hub }));
  return app;
}

async function callRoute(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
}

const SALARY_RULE = {
  scope: "rehearsal.fill",
  condition: { fieldLabelContains: "salary" },
  action: { fillValueFrom: "profile.salary_range" },
  confidence: 0.9,
  reason: "Always answer salary with the stored range",
};

async function createSalaryRule(app: Hono): Promise<Rule> {
  const response = await callRoute(app, "/api/rules", {
    method: "POST",
    body: JSON.stringify(SALARY_RULE),
  });
  if (response.status !== 200) throw new Error(`Expected rule creation to succeed, got ${response.status}`);
  return ((await response.json()) as { rule: Rule }).rule;
}

describe("POST /api/rules", () => {
  it("creates a user rule with its first revision and lists it", async () => {
    const app = mountRulesRoute();
    const client = recordingStreamClient();
    hub.subscribe(client);

    const rule = await createSalaryRule(app);

    expect(rule).toMatchObject({
      scope: "rehearsal.fill",
      condition: { fieldLabelContains: "salary" },
      action: { fillValueFrom: "profile.salary_range" },
      confidence: 0.9,
      status: "confirmed",
      sourceSessionId: null,
      contributingRuleIds: [],
    });

    const revisions = streamMessagesOfType(client.messages, "revision.created");
    expect(revisions).toHaveLength(1);
    expect(revisions[0].payload.revision).toMatchObject({
      entityType: "rule",
      entityId: rule.id,
      actor: "user",
      sourceSessionId: null,
      after: { id: rule.id, scope: "rehearsal.fill" },
    });
    expect(revisions[0].payload.revision.before).toBeUndefined();

    const listed = await callRoute(app, "/api/rules");
    expect(((await listed.json()) as { rules: Rule[] }).rules).toEqual([rule]);
  });

  it("rejects an invalid creation without storing a rule", async () => {
    const app = mountRulesRoute();

    const response = await callRoute(app, "/api/rules", {
      method: "POST",
      body: JSON.stringify({ scope: "", condition: {}, action: {}, confidence: 2 }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; fieldErrors: Record<string, string[]> };
    expect(body.error).toBe("invalid_request");
    expect(body.fieldErrors.scope?.length).toBeGreaterThan(0);
    expect(body.fieldErrors.confidence?.length).toBeGreaterThan(0);

    const listed = await callRoute(app, "/api/rules");
    expect(((await listed.json()) as { rules: Rule[] }).rules).toEqual([]);
  });
});

describe("PATCH /api/rules/:id", () => {
  it("persists a rule edit and records before and after in a revision", async () => {
    const app = mountRulesRoute();
    const client = recordingStreamClient();
    hub.subscribe(client);
    const created = await createSalaryRule(app);

    const response = await callRoute(app, `/api/rules/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        action: { fillValueFrom: "profile.preferred_salary_note" },
        reason: "Use the preferred note instead of the bare range",
      }),
    });

    expect(response.status).toBe(200);
    const { rule } = (await response.json()) as { rule: Rule };
    expect(rule).toMatchObject({
      id: created.id,
      action: { fillValueFrom: "profile.preferred_salary_note" },
      status: "corrected",
    });

    const revisions = streamMessagesOfType(client.messages, "revision.created");
    expect(revisions).toHaveLength(2);
    const editRevision = revisions[1].payload.revision;
    expect(editRevision.actor).toBe("user");
    expect(editRevision.before).toMatchObject({ action: { fillValueFrom: "profile.salary_range" } });
    expect(editRevision.after).toMatchObject({ action: { fillValueFrom: "profile.preferred_salary_note" } });

    const listed = await callRoute(app, "/api/rules");
    const rules = ((await listed.json()) as { rules: Rule[] }).rules;
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toEqual({ fillValueFrom: "profile.preferred_salary_note" });
  });

  it("returns 404 when editing an unknown rule", async () => {
    const app = mountRulesRoute();

    const response = await callRoute(app, `/api/rules/${randomUUID()}`, {
      method: "PATCH",
      body: JSON.stringify({ scope: "rehearsal.fill" }),
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("not_found");
  });

  it("rejects an edit with no field to change", async () => {
    const app = mountRulesRoute();
    const created = await createSalaryRule(app);

    const response = await callRoute(app, `/api/rules/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toContain("field");
  });
});
