import { z } from "zod";
import { defineEnvelope, webUrlSchema } from "./envelope";

/**
 * Events captured by the development extensions for Chrome and Firefox.
 * Each event travels inside the shared envelope with its type as the
 * envelope type.
 */

export const searchFilterPayloadSchema = z
  .strictObject({
    pageUrl: webUrlSchema,
    query: z.string().optional(),
    filters: z.record(z.string(), z.string()),
  })
  .refine(
    (payload) => (payload.query ?? "").length > 0 || Object.keys(payload.filters).length > 0,
    { error: "A search_filter event needs a query or at least one filter" },
  );

export const postingOpenedPayloadSchema = z.strictObject({
  pageUrl: webUrlSchema,
  title: z.string().optional(),
});

export const fieldFilledPayloadSchema = z.strictObject({
  pageUrl: webUrlSchema,
  selector: z.string().min(1),
  label: z.string().optional(),
  fieldType: z.string().optional(),
  value: z.string(),
});

export const reasonStatedPayloadSchema = z.strictObject({
  pageUrl: webUrlSchema.optional(),
  input: z.enum(["text", "voice"]),
  text: z.string().min(1),
  relatedEventId: z.uuid().optional(),
});

export const searchFilterEventSchema = defineEnvelope("search_filter", searchFilterPayloadSchema);
export const postingOpenedEventSchema = defineEnvelope("posting_opened", postingOpenedPayloadSchema);
export const fieldFilledEventSchema = defineEnvelope("field_filled", fieldFilledPayloadSchema);
export const reasonStatedEventSchema = defineEnvelope("reason_stated", reasonStatedPayloadSchema);

export const observedEventEnvelopeSchema = z.discriminatedUnion("type", [
  searchFilterEventSchema,
  postingOpenedEventSchema,
  fieldFilledEventSchema,
  reasonStatedEventSchema,
]);

export type SearchFilterPayload = z.infer<typeof searchFilterPayloadSchema>;
export type PostingOpenedPayload = z.infer<typeof postingOpenedPayloadSchema>;
export type FieldFilledPayload = z.infer<typeof fieldFilledPayloadSchema>;
export type ReasonStatedPayload = z.infer<typeof reasonStatedPayloadSchema>;
export type ObservedEventEnvelope = z.infer<typeof observedEventEnvelopeSchema>;
