import { z } from "zod";
import { defineEnvelope, envelopeIdSchema } from "./envelope";
import {
  profileEntrySchema,
  rehearsalActionRecordSchema,
  revisionSchema,
  sessionSummarySchema,
  traceSchema,
} from "./api";
import { rehearsalBlockReasonSchema, rehearsalPauseReasonSchema } from "./rehearsal";

/**
 * Events streamed to connected clients over the WebSocket /stream endpoint.
 * All of them use the shared envelope.
 */

export const sessionUpdatedSchema = defineEnvelope(
  "session.updated",
  z.strictObject({ session: sessionSummarySchema }),
);

export const traceStartedSchema = defineEnvelope(
  "trace.started",
  z.strictObject({ trace: traceSchema }),
);

export const traceDeltaSchema = defineEnvelope(
  "trace.delta",
  z.strictObject({ traceId: envelopeIdSchema, text: z.string() }),
);

export const traceCompletedSchema = defineEnvelope(
  "trace.completed",
  z.strictObject({ trace: traceSchema }),
);

export const taskFailedSchema = defineEnvelope(
  "task.failed",
  z.strictObject({ taskId: envelopeIdSchema, message: z.string() }),
);

export const profileUpdatedSchema = defineEnvelope(
  "profile.updated",
  z.strictObject({ entry: profileEntrySchema }),
);

export const revisionCreatedSchema = defineEnvelope(
  "revision.created",
  z.strictObject({ revision: revisionSchema }),
);

export const rehearsalProposedSchema = defineEnvelope(
  "rehearsal.proposed",
  z.strictObject({ action: rehearsalActionRecordSchema, reasoning: z.string().optional() }),
);

export const rehearsalPausedSchema = defineEnvelope(
  "rehearsal.paused",
  z.strictObject({
    rehearsalId: envelopeIdSchema,
    actionId: envelopeIdSchema.nullable(),
    reason: rehearsalPauseReasonSchema,
  }),
);

export const rehearsalExecutedSchema = defineEnvelope(
  "rehearsal.executed",
  z.strictObject({ action: rehearsalActionRecordSchema }),
);

export const rehearsalBlockedSchema = defineEnvelope(
  "rehearsal.blocked",
  z.strictObject({ action: rehearsalActionRecordSchema, reason: rehearsalBlockReasonSchema }),
);

export const wsEventSchema = z.discriminatedUnion("type", [
  sessionUpdatedSchema,
  traceStartedSchema,
  traceDeltaSchema,
  traceCompletedSchema,
  taskFailedSchema,
  profileUpdatedSchema,
  revisionCreatedSchema,
  rehearsalProposedSchema,
  rehearsalPausedSchema,
  rehearsalExecutedSchema,
  rehearsalBlockedSchema,
]);

export type WsEvent = z.infer<typeof wsEventSchema>;
