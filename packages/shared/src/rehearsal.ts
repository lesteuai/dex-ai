import { z } from "zod";
import { webUrlSchema } from "./envelope";

/**
 * Rehearsal vocabulary and proposed actions.
 * There is deliberately no submit kind. Anything that would submit an
 * application is blocked by the extension guard and recorded instead.
 */

export const rehearsalActionKindSchema = z.enum([
  "navigate",
  "focus",
  "fill",
  "click_non_submit",
  "scroll",
  "wait",
]);

export const rehearsalActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("navigate"), url: webUrlSchema }),
  z.strictObject({ kind: z.literal("focus"), selector: z.string().min(1) }),
  z.strictObject({ kind: z.literal("fill"), selector: z.string().min(1), value: z.string() }),
  z.strictObject({ kind: z.literal("click_non_submit"), selector: z.string().min(1) }),
  z.strictObject({ kind: z.literal("scroll"), selector: z.string().min(1).optional(), deltaY: z.int() }),
  z.strictObject({ kind: z.literal("wait"), durationMs: z.int().positive() }),
]);

export const rehearsalStatusSchema = z.enum(["running", "paused", "completed", "failed"]);

export const rehearsalActionStatusSchema = z.enum([
  "proposed",
  "approved",
  "executed",
  "rejected",
  "blocked",
]);

export const rehearsalPauseReasonSchema = z.enum([
  "low_confidence",
  "user_paused",
  "interrupted",
  "disconnected",
]);

export const rehearsalBlockReasonSchema = z.enum([
  "submit_control",
  "submit_activation",
  "submit_navigation",
]);

export type RehearsalActionKind = z.infer<typeof rehearsalActionKindSchema>;
export type RehearsalAction = z.infer<typeof rehearsalActionSchema>;
