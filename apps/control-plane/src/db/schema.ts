import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

const BROWSER_KINDS = ["chrome", "firefox"] as const;
const SESSION_STATUSES = ["active", "ended"] as const;
const EVENT_TYPES = ["search_filter", "posting_opened", "field_filled", "reason_stated"] as const;
const ENTRY_STATUSES = ["inferred", "confirmed", "corrected"] as const;
const AGENT_TASK_KINDS = ["profile_inference", "teaching", "rehearsal_planning", "correction_propagation"] as const;
const AGENT_TASK_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
const REVISION_ACTORS = ["agent", "user"] as const;
const TEACHING_DRAFT_SOURCES = ["typed", "voice"] as const;
const TEACHING_DRAFT_STATUSES = ["pending", "confirmed", "discarded"] as const;
const REHEARSAL_STATUSES = ["running", "paused", "completed", "failed"] as const;
const REHEARSAL_ACTION_KINDS = ["navigate", "focus", "fill", "click_non_submit", "scroll", "wait"] as const;
const REHEARSAL_ACTION_STATUSES = ["proposed", "approved", "executed", "rejected", "blocked"] as const;

const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).notNull();

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    browserKind: text("browser_kind", { enum: BROWSER_KINDS }).notNull(),
    source: text("source").notNull(),
    postingUrl: text("posting_url"),
    status: text("status", { enum: SESSION_STATUSES }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("sessions_started_at_idx").on(table.startedAt)],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    type: text("type", { enum: EVENT_TYPES }).notNull(),
    capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
    sourceUrl: text("source_url"),
    payload: text("payload", { mode: "json" }).notNull(),
    // Duplicate envelope IDs collapse onto the same key instead of creating rows.
    dedupeKey: text("dedupe_key").notNull().unique(),
  },
  (table) => [index("events_session_captured_idx").on(table.sessionId, table.capturedAt)],
);

export const profileEntries = sqliteTable(
  "profile_entries",
  {
    id: text("id").primaryKey(),
    section: text("section").notNull(),
    key: text("key").notNull(),
    value: text("value", { mode: "json" }).notNull(),
    confidence: real("confidence").notNull(),
    status: text("status", { enum: ENTRY_STATUSES }).notNull(),
    sourceEventIds: text("source_event_ids", { mode: "json" }).$type<string[]>().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("profile_entries_section_idx").on(table.section)],
);

export const rules = sqliteTable(
  "rules",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    condition: text("condition", { mode: "json" }).notNull(),
    action: text("action", { mode: "json" }).notNull(),
    confidence: real("confidence").notNull(),
    status: text("status", { enum: ENTRY_STATUSES }).notNull(),
    // Revision history must survive a session disappearing, so only set null.
    sourceSessionId: text("source_session_id").references(() => sessions.id, { onDelete: "set null" }),
    contributingRuleIds: text("contributing_rule_ids", { mode: "json" }).$type<string[]>().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("rules_scope_idx").on(table.scope)],
);

export const agentTasks = sqliteTable(
  "agent_tasks",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: AGENT_TASK_KINDS }).notNull(),
    status: text("status", { enum: AGENT_TASK_STATUSES }).notNull(),
    providerSessionId: text("provider_session_id"),
    model: text("model"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    error: text("error"),
  },
  (table) => [index("agent_tasks_session_idx").on(table.sessionId)],
);

export const traces = sqliteTable(
  "traces",
  {
    id: text("id").primaryKey(),
    // A user correction records a trace without any agent task behind it.
    taskId: text("task_id").references(() => agentTasks.id, { onDelete: "set null" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    eventId: text("event_id").references(() => events.id, { onDelete: "set null" }),
    step: text("step").notNull(),
    input: text("input", { mode: "json" }).notNull(),
    reasoning: text("reasoning").notNull(),
    output: text("output", { mode: "json" }).notNull(),
    confidence: real("confidence"),
    createdAt: createdAt(),
  },
  (table) => [
    index("traces_session_idx").on(table.sessionId),
    index("traces_task_idx").on(table.taskId),
  ],
);

export const revisions = sqliteTable(
  "revisions",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    sourceSessionId: text("source_session_id").references(() => sessions.id, { onDelete: "set null" }),
    traceId: text("trace_id").references(() => traces.id, { onDelete: "set null" }),
    actor: text("actor", { enum: REVISION_ACTORS }).notNull(),
    // A first-ever value has no prior value, stored as SQL NULL.
    before: text("before", { mode: "json" }),
    after: text("after", { mode: "json" }).notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("revisions_entity_idx").on(table.entityType, table.entityId),
    index("revisions_session_idx").on(table.sourceSessionId),
    index("revisions_created_at_idx").on(table.createdAt),
  ],
);

export const teachingDrafts = sqliteTable(
  "teaching_drafts",
  {
    id: text("id").primaryKey(),
    source: text("source", { enum: TEACHING_DRAFT_SOURCES }).notNull(),
    transcript: text("transcript").notNull(),
    status: text("status", { enum: TEACHING_DRAFT_STATUSES }).notNull(),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [index("teaching_drafts_session_idx").on(table.sessionId)],
);

export const rehearsals = sqliteTable(
  "rehearsals",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    postingUrl: text("posting_url").notNull(),
    browserKind: text("browser_kind", { enum: BROWSER_KINDS }).notNull(),
    status: text("status", { enum: REHEARSAL_STATUSES }).notNull(),
    confidenceThreshold: real("confidence_threshold").notNull(),
    // Plain pointer, no FK: a circular constraint with rehearsal_actions breaks
    // table type inference and adds no protection beyond rehearsal_id's FK.
    currentActionId: text("current_action_id"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("rehearsals_session_idx").on(table.sessionId)],
);

export const rehearsalActions = sqliteTable(
  "rehearsal_actions",
  {
    id: text("id").primaryKey(),
    rehearsalId: text("rehearsal_id")
      .notNull()
      .references(() => rehearsals.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    kind: text("kind", { enum: REHEARSAL_ACTION_KINDS }).notNull(),
    target: text("target", { mode: "json" }),
    value: text("value"),
    confidence: real("confidence").notNull(),
    status: text("status", { enum: REHEARSAL_ACTION_STATUSES }).notNull(),
    traceId: text("trace_id").references(() => traces.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [index("rehearsal_actions_rehearsal_idx").on(table.rehearsalId, table.sequence)],
);

export const evaluations = sqliteTable(
  "evaluations",
  {
    id: text("id").primaryKey(),
    fixtureSessionId: text("fixture_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    errorsUnchanged: integer("errors_unchanged").notNull(),
    errorsCorrected: integer("errors_corrected").notNull(),
    errorsNew: integer("errors_new").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("evaluations_session_idx").on(table.fixtureSessionId)],
);
