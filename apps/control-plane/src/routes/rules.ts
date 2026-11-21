import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import {
  createRuleRequestSchema,
  patchRuleRequestSchema,
  type WsEvent,
} from "@dex-ai/shared";
import type { ControlPlaneDb } from "../db/client";
import {
  applyRuleEdit,
  createUserRule,
  listRules,
  type RuleCreation,
  type RuleEdit,
} from "../repositories/rules";
import type { StreamHub } from "../stream/hub";

export interface RulesRouteDeps {
  database: DatabaseSync;
  db: ControlPlaneDb;
  hub: StreamHub;
}

// The hub validates the envelope against the shared schema before fanout.
function wsEnvelope(type: WsEvent["type"], payload: unknown): WsEvent {
  return { type, id: randomUUID(), ts: new Date().toISOString(), payload } as WsEvent;
}

/** GET /api/rules lists rules, POST creates one, PATCH /:id edits one. */
export function createRulesRoute(deps: RulesRouteDeps): Hono<{ Bindings: HttpBindings }> {
  const rules = new Hono<{ Bindings: HttpBindings }>();

  rules.get("/", async (c) => c.json({ rules: await listRules(deps.db) }));

  rules.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request", message: "Request body must be valid JSON" }, 400);
    }
    const request = createRuleRequestSchema.safeParse(body);
    if (!request.success) {
      return c.json(
        {
          error: "invalid_request",
          message: "Invalid rule creation request",
          fieldErrors: z.flattenError(request.error).fieldErrors,
        },
        400,
      );
    }

    const creation: RuleCreation = {
      scope: request.data.scope,
      condition: request.data.condition,
      action: request.data.action,
      confidence: request.data.confidence,
      reason: request.data.reason ?? "Rule created by the user in the rules editor",
    };
    const created = await createUserRule(deps.database, deps.db, creation);
    deps.hub.publish(wsEnvelope("revision.created", { revision: created.revision }));
    return c.json({ rule: created.rule });
  });

  rules.patch("/:id", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_request", message: "Request body must be valid JSON" }, 400);
    }
    const request = patchRuleRequestSchema.safeParse(body);
    if (!request.success) {
      return c.json(
        {
          error: "invalid_request",
          message: "Invalid rule edit request",
          fieldErrors: z.flattenError(request.error).fieldErrors,
        },
        400,
      );
    }
    const { scope, condition, action, confidence, status, reason } = request.data;
    if (
      scope === undefined &&
      condition === undefined &&
      action === undefined &&
      confidence === undefined &&
      status === undefined
    ) {
      return c.json(
        { error: "invalid_request", message: "Provide a field to edit the rule" },
        400,
      );
    }

    const edit: RuleEdit = {
      ...(scope !== undefined ? { scope } : {}),
      ...(condition !== undefined ? { condition } : {}),
      ...(action !== undefined ? { action } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(status !== undefined ? { status } : {}),
      reason: reason ?? "Rule edited by the user in the rules editor",
    };
    const edited = await applyRuleEdit(deps.database, deps.db, c.req.param("id"), edit);
    if (!edited) {
      return c.json({ error: "not_found", message: "Rule does not exist" }, 404);
    }

    deps.hub.publish(wsEnvelope("revision.created", { revision: edited.revision }));
    return c.json({ rule: edited.after });
  });

  return rules;
}
