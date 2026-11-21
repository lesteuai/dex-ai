import { z } from "zod";
import { envelopeIdSchema, envelopeTsSchema, webUrlSchema } from "./envelope";
import { observedEventEnvelopeSchema } from "./events";
import {
  rehearsalActionSchema,
  rehearsalActionStatusSchema,
  rehearsalStatusSchema,
} from "./rehearsal";

/** REST request and response contracts for the control plane. */

export const browserKindSchema = z.enum(["chrome", "firefox"]);
export const confidenceSchema = z.number().min(0).max(1);

export const okResponseSchema = z.strictObject({ ok: z.literal(true) });

export const apiErrorResponseSchema = z.strictObject({
  error: z.string(),
  message: z.string(),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
});

// Event ingest. Duplicate event IDs are counted, not stored twice.

export const sessionDescriptorSchema = z.strictObject({
  id: envelopeIdSchema,
  browserKind: browserKindSchema,
  sourceUrl: webUrlSchema.optional(),
  postingUrl: webUrlSchema.optional(),
});

export const batchRejectionSchema = z.strictObject({
  index: z.int().min(0),
  id: z.string().nullable(),
  formErrors: z.array(z.string()),
  fieldErrors: z.record(z.string(), z.array(z.string())),
});

export const postEventsBatchRequestSchema = z.strictObject({
  session: sessionDescriptorSchema,
  events: z.array(observedEventEnvelopeSchema).min(1).max(200),
});

export const postEventsBatchResponseSchema = z.strictObject({
  sessionId: envelopeIdSchema,
  accepted: z.int().min(0),
  duplicates: z.int().min(0),
  rejected: z.array(batchRejectionSchema),
});

// Sessions and chronological timeline.

export const sessionStatusSchema = z.enum(["active", "ended"]);

export const sessionSummarySchema = z.strictObject({
  id: envelopeIdSchema,
  browserKind: browserKindSchema,
  sourceUrl: webUrlSchema.nullable(),
  postingUrl: webUrlSchema.nullable(),
  status: sessionStatusSchema,
  startedAt: envelopeTsSchema,
  endedAt: envelopeTsSchema.nullable(),
});

export const traceSchema = z.strictObject({
  id: envelopeIdSchema,
  taskId: envelopeIdSchema.nullable(),
  sessionId: envelopeIdSchema.nullable(),
  eventId: envelopeIdSchema.nullable(),
  step: z.int().min(0),
  input: z.unknown().optional(),
  reasoning: z.string().nullable(),
  output: z.unknown().optional(),
  confidence: confidenceSchema.nullable(),
  createdAt: envelopeTsSchema,
});

export const revisionActorSchema = z.enum(["agent", "user"]);

export const revisionSchema = z.strictObject({
  id: envelopeIdSchema,
  entityType: z.string(),
  entityId: z.string(),
  sourceSessionId: envelopeIdSchema.nullable(),
  traceId: envelopeIdSchema.nullable(),
  actor: revisionActorSchema,
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  reason: z.string(),
  createdAt: envelopeTsSchema,
});

export const rehearsalActionRecordSchema = z.strictObject({
  id: envelopeIdSchema,
  rehearsalId: envelopeIdSchema,
  sequence: z.int().min(1),
  action: rehearsalActionSchema,
  confidence: confidenceSchema,
  status: rehearsalActionStatusSchema,
  traceId: envelopeIdSchema.nullable(),
  createdAt: envelopeTsSchema,
});

export const sessionTimelineItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("event"), event: observedEventEnvelopeSchema }),
  z.strictObject({ kind: z.literal("trace"), trace: traceSchema }),
  z.strictObject({ kind: z.literal("revision"), revision: revisionSchema }),
  z.strictObject({ kind: z.literal("rehearsal_action"), action: rehearsalActionRecordSchema }),
]);

export const sessionsResponseSchema = z.strictObject({ sessions: z.array(sessionSummarySchema) });

export const sessionDetailResponseSchema = z.strictObject({
  session: sessionSummarySchema,
  timeline: z.array(sessionTimelineItemSchema),
});

// Profile and rules.

export const entryStatusSchema = z.enum(["inferred", "confirmed", "corrected"]);

export const profileEntrySchema = z.strictObject({
  id: envelopeIdSchema,
  section: z.string(),
  key: z.string(),
  value: z.unknown(),
  confidence: confidenceSchema,
  status: entryStatusSchema,
  sourceEventIds: z.array(envelopeIdSchema),
  updatedAt: envelopeTsSchema,
});

export const ruleSchema = z.strictObject({
  id: envelopeIdSchema,
  scope: z.string(),
  condition: z.unknown(),
  action: z.unknown(),
  confidence: confidenceSchema,
  status: entryStatusSchema,
  sourceSessionId: envelopeIdSchema.nullable(),
  contributingRuleIds: z.array(envelopeIdSchema),
  updatedAt: envelopeTsSchema,
});

export const profileResponseSchema = z.strictObject({ entries: z.array(profileEntrySchema) });
export const rulesResponseSchema = z.strictObject({ rules: z.array(ruleSchema) });
export const profileEntryResponseSchema = z.strictObject({ entry: profileEntrySchema });
export const ruleResponseSchema = z.strictObject({ rule: ruleSchema });

export const patchProfileEntryRequestSchema = z.strictObject({
  value: z.unknown().optional(),
  status: entryStatusSchema.optional(),
  reason: z.string().min(1).optional(),
});

export const createRuleRequestSchema = z.strictObject({
  scope: z.string().min(1),
  condition: z.unknown(),
  action: z.unknown(),
  confidence: confidenceSchema.optional(),
  reason: z.string().min(1).optional(),
});

export const patchRuleRequestSchema = z.strictObject({
  scope: z.string().min(1).optional(),
  condition: z.unknown().optional(),
  action: z.unknown().optional(),
  confidence: confidenceSchema.optional(),
  status: entryStatusSchema.optional(),
  reason: z.string().min(1).optional(),
});

// Revision history.

export const revisionsQuerySchema = z.strictObject({
  entityType: z.string().optional(),
  sessionId: z.string().optional(),
});

export const revisionsResponseSchema = z.strictObject({ revisions: z.array(revisionSchema) });

// Teaching and local transcription.

export const teachingSourceSchema = z.enum(["text", "voice"]);
export const teachingDraftStatusSchema = z.enum(["pending", "confirmed", "discarded"]);

export const teachingDraftSchema = z.strictObject({
  id: envelopeIdSchema,
  source: teachingSourceSchema,
  transcript: z.string(),
  status: teachingDraftStatusSchema,
  sessionId: envelopeIdSchema.nullable(),
  createdAt: envelopeTsSchema,
});

export const createTeachingDraftRequestSchema = z.strictObject({
  source: teachingSourceSchema,
  transcript: z.string().min(1),
  sessionId: envelopeIdSchema.optional(),
});

export const applyTeachingRequestSchema = z
  .strictObject({
    draftId: envelopeIdSchema.optional(),
    text: z.string().min(1).optional(),
    sessionId: envelopeIdSchema.optional(),
  })
  .refine((request) => request.draftId !== undefined || request.text !== undefined, {
    error: "Provide a confirmed draft id or typed text",
  });

export const teachingDraftsResponseSchema = z.strictObject({
  drafts: z.array(teachingDraftSchema),
});
export const teachingDraftResponseSchema = z.strictObject({ draft: teachingDraftSchema });
export const sttTranscribeResponseSchema = z.strictObject({ text: z.string() });

// Rehearsals.

export const startRehearsalRequestSchema = z.strictObject({
  sessionId: envelopeIdSchema,
  postingUrl: webUrlSchema.optional(),
  confidenceThreshold: confidenceSchema.optional(),
});

export const rehearsalRecordSchema = z.strictObject({
  id: envelopeIdSchema,
  sessionId: envelopeIdSchema,
  postingUrl: webUrlSchema.nullable(),
  browserKind: browserKindSchema,
  status: rehearsalStatusSchema,
  confidenceThreshold: confidenceSchema,
  currentActionId: envelopeIdSchema.nullable(),
  startedAt: envelopeTsSchema,
});

export const rehearsalDecisionRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("approve"), actionId: envelopeIdSchema }),
  z.strictObject({
    type: z.literal("correct"),
    actionId: envelopeIdSchema,
    action: rehearsalActionSchema,
  }),
  z.strictObject({ type: z.literal("reject"), actionId: envelopeIdSchema }),
  z.strictObject({ type: z.literal("pause") }),
  z.strictObject({ type: z.literal("resume") }),
]);

export const startRehearsalResponseSchema = z.strictObject({ rehearsal: rehearsalRecordSchema });
export const getRehearsalResponseSchema = z.strictObject({
  rehearsal: rehearsalRecordSchema,
  actions: z.array(rehearsalActionRecordSchema),
});
export const rehearsalDecisionResponseSchema = z.strictObject({
  rehearsal: rehearsalRecordSchema,
});

// Fixture evaluations.

export const evaluationRecordSchema = z.strictObject({
  id: envelopeIdSchema,
  fixtureSessionId: envelopeIdSchema,
  errorsUnchanged: z.int().min(0),
  errorsCorrected: z.int().min(0),
  errorsNew: z.int().min(0),
  createdAt: envelopeTsSchema,
});

export const evaluationRunResponseSchema = z.strictObject({ evaluation: evaluationRecordSchema });

export type SessionDescriptor = z.infer<typeof sessionDescriptorSchema>;
export type BatchRejection = z.infer<typeof batchRejectionSchema>;
export type PostEventsBatchRequest = z.infer<typeof postEventsBatchRequestSchema>;
export type PostEventsBatchResponse = z.infer<typeof postEventsBatchResponseSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type Trace = z.infer<typeof traceSchema>;
export type Revision = z.infer<typeof revisionSchema>;
export type SessionTimelineItem = z.infer<typeof sessionTimelineItemSchema>;
export type RehearsalActionRecord = z.infer<typeof rehearsalActionRecordSchema>;
export type ProfileEntry = z.infer<typeof profileEntrySchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type TeachingDraft = z.infer<typeof teachingDraftSchema>;
export type ApplyTeachingRequest = z.infer<typeof applyTeachingRequestSchema>;
export type StartRehearsalRequest = z.infer<typeof startRehearsalRequestSchema>;
export type RehearsalRecord = z.infer<typeof rehearsalRecordSchema>;
export type RehearsalDecisionRequest = z.infer<typeof rehearsalDecisionRequestSchema>;
export type EvaluationRecord = z.infer<typeof evaluationRecordSchema>;
