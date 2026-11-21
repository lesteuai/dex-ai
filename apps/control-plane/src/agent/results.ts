import { z } from "zod";
import { confidenceSchema, envelopeIdSchema, rehearsalActionSchema, webUrlSchema } from "@dex-ai/shared";
import type { AgentResultSchemaName } from "./adapter";

/**
 * Zod schemas for the JSON each agent task must return.
 * A result that fails validation is a task failure, never a stored value.
 */

export const profileSectionSchema = z.enum([
  "user_facts",
  "job_sources",
  "preferences",
  "criteria",
  "form_rules",
]);

export const PROFILE_SECTIONS = profileSectionSchema.options;

export type ProfileSection = z.infer<typeof profileSectionSchema>;

// An entry without a source event is fabrication, so at least one is required.
const supportedEntrySchema = z.strictObject({
  key: z.string().min(1),
  value: z.unknown(),
  confidence: confidenceSchema,
  sourceEventIds: z.array(envelopeIdSchema).min(1),
  reasoningTrace: z.string().min(1),
});

export const profileResultSchema = z.strictObject({
  sections: z.array(
    z.strictObject({
      section: profileSectionSchema,
      // Insufficient evidence means an empty array, not invented entries.
      entries: z.array(supportedEntrySchema),
    }),
  ),
});

export const rulesResultSchema = z.strictObject({
  rules: z.array(
    z.strictObject({
      scope: z.string().min(1),
      condition: z.unknown(),
      action: z.unknown(),
      confidence: confidenceSchema,
      // Teaching text has no observed events behind it, so sources may be empty.
      sourceEventIds: z.array(envelopeIdSchema),
      reasoningTrace: z.string().min(1),
    }),
  ),
});

export const rehearsalPlanResultSchema = z.strictObject({
  postingUrl: webUrlSchema,
  reasoningTrace: z.string().min(1),
  actions: z.array(
    z.strictObject({
      // The shared action vocabulary has no submit kind by design.
      action: rehearsalActionSchema,
      confidence: confidenceSchema,
      reasoning: z.string().min(1),
    }),
  ),
});

export const correctionResultSchema = z.strictObject({
  reasoningTrace: z.string().min(1),
  // One update per stored rule that contributed to the corrected decision.
  ruleUpdates: z.array(
    z.strictObject({
      ruleId: envelopeIdSchema,
      condition: z.unknown(),
      action: z.unknown(),
      confidence: confidenceSchema,
      changeReason: z.string().min(1),
    }),
  ),
});

export const agentResultSchemas = {
  profile: profileResultSchema,
  rules: rulesResultSchema,
  rehearsalPlan: rehearsalPlanResultSchema,
  correction: correctionResultSchema,
} as const;

export type ProfileResult = z.infer<typeof profileResultSchema>;
export type RulesResult = z.infer<typeof rulesResultSchema>;
export type RehearsalPlanResult = z.infer<typeof rehearsalPlanResultSchema>;
export type CorrectionResult = z.infer<typeof correctionResultSchema>;
export type AgentResult = ProfileResult | RulesResult | RehearsalPlanResult | CorrectionResult;

/** Validate a task result against the schema named in AgentStartInput. */
export function parseAgentResult(name: AgentResultSchemaName, value: unknown): AgentResult {
  const parsed = agentResultSchemas[name].safeParse(value);
  if (!parsed.success) {
    // The per-schema error types union, so widen to one error type for flattening.
    const details = JSON.stringify(z.flattenError(parsed.error as z.ZodError));
    throw new Error(`Agent ${name} result failed validation: ${details}`);
  }
  return parsed.data;
}
