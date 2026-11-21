import { z } from "zod";

/**
 * Shared message envelope and wire primitives.
 * Every message crossing the extension, control plane and web boundary uses
 * the envelope `{ type, id, ts, payload }`.
 */

export const envelopeIdSchema = z.uuid();
export const envelopeTsSchema = z.iso.datetime();

/** Page or fixture URL. http(s) only. Hostnames, IPs and loopback are allowed. */
export const webUrlSchema = z.url({ protocol: /^https?$/ });

export function defineEnvelope<const Type extends string, Payload extends z.ZodType>(
  type: Type,
  payload: Payload,
) {
  return z.strictObject({
    type: z.literal(type),
    id: envelopeIdSchema,
    ts: envelopeTsSchema,
    payload,
  });
}

export type Envelope<Type extends string = string, Payload = unknown> = {
  type: Type;
  id: string;
  ts: string;
  payload: Payload;
};
