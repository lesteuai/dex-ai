import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Revision, Rule } from "@dex-ai/shared";
import { entryStatusSchema } from "@dex-ai/shared";
import { runInTransaction, type ControlPlaneDb } from "../db/client";
import { rules } from "../db/schema";
import { insertRevision, toApiRevision, type NewRevision } from "./revisions";

type RuleRow = typeof rules.$inferSelect;

type EntryStatus = z.infer<typeof entryStatusSchema>;

export interface NewRule {
  id: string;
  scope: string;
  condition: unknown;
  action: unknown;
  confidence: number;
  status: EntryStatus;
  sourceSessionId: string | null;
  contributingRuleIds: string[];
  updatedAt: Date;
}

export function toRule(row: RuleRow): Rule {
  return {
    id: row.id,
    scope: row.scope,
    condition: row.condition,
    action: row.action,
    confidence: row.confidence,
    status: row.status,
    sourceSessionId: row.sourceSessionId,
    contributingRuleIds: row.contributingRuleIds,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listRules(db: ControlPlaneDb): Promise<Rule[]> {
  const rows = await db
    .select()
    .from(rules)
    .orderBy(asc(rules.scope), asc(rules.updatedAt));
  return rows.map(toRule);
}

export async function getRule(db: ControlPlaneDb, id: string): Promise<Rule | null> {
  const [row] = await db.select().from(rules).where(eq(rules.id, id));
  return row ? toRule(row) : null;
}

export async function insertRule(db: ControlPlaneDb, rule: NewRule): Promise<void> {
  await db.insert(rules).values(rule).run();
}

export async function updateRule(
  db: ControlPlaneDb,
  id: string,
  changes: Partial<Omit<NewRule, "id">>,
): Promise<void> {
  await db
    .update(rules)
    .set(changes)
    .where(eq(rules.id, id))
    .run();
}

export interface RuleCreation {
  scope: string;
  condition: unknown;
  action: unknown;
  confidence?: number;
  reason: string;
}

export interface CreatedRule {
  rule: Rule;
  revision: Revision;
}

/** Store one user-authored rule and its first revision in a single transaction. */
export async function createUserRule(
  database: DatabaseSync,
  db: ControlPlaneDb,
  creation: RuleCreation,
): Promise<CreatedRule> {
  const now = new Date();
  const record: NewRule = {
    id: randomUUID(),
    scope: creation.scope,
    condition: creation.condition,
    action: creation.action,
    confidence: creation.confidence ?? 1,
    // The user authored the rule directly, so it starts out confirmed.
    status: "confirmed",
    sourceSessionId: null,
    contributingRuleIds: [],
    updatedAt: now,
  };
  const rule: Rule = { ...record, updatedAt: now.toISOString() };

  return runInTransaction(database, async () => {
    await insertRule(db, record);
    const newRevision: NewRevision = {
      id: randomUUID(),
      entityType: "rule",
      entityId: rule.id,
      sourceSessionId: null,
      traceId: null,
      actor: "user",
      before: null,
      after: rule,
      reason: creation.reason,
      createdAt: now,
    };
    await insertRevision(db, newRevision);
    return { rule, revision: toApiRevision(newRevision) };
  });
}

export interface RuleEdit {
  scope?: string;
  condition?: unknown;
  action?: unknown;
  confidence?: number;
  status?: EntryStatus;
  reason: string;
}

export interface RuleEditResult {
  before: Rule;
  after: Rule;
  revision: Revision;
}

/** Apply one user edit and its revision row in a single transaction. */
export async function applyRuleEdit(
  database: DatabaseSync,
  db: ControlPlaneDb,
  id: string,
  edit: RuleEdit,
): Promise<RuleEditResult | null> {
  const before = await getRule(db, id);
  if (!before) return null;

  const now = new Date();
  const after: Rule = {
    ...before,
    scope: edit.scope ?? before.scope,
    condition: edit.condition !== undefined ? edit.condition : before.condition,
    action: edit.action !== undefined ? edit.action : before.action,
    confidence: edit.confidence ?? before.confidence,
    status: edit.status ?? "corrected",
    updatedAt: now.toISOString(),
  };

  return runInTransaction(database, async () => {
    await updateRule(db, id, {
      scope: after.scope,
      condition: after.condition,
      action: after.action,
      confidence: after.confidence,
      status: after.status,
      updatedAt: now,
    });
    const newRevision: NewRevision = {
      id: randomUUID(),
      entityType: "rule",
      entityId: id,
      sourceSessionId: null,
      traceId: null,
      actor: "user",
      before,
      after,
      reason: edit.reason,
      createdAt: now,
    };
    await insertRevision(db, newRevision);
    return { before, after, revision: toApiRevision(newRevision) };
  });
}
