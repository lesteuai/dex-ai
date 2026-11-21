import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineEnvelope, webUrlSchema } from "./index";

const noteEnvelopeSchema = defineEnvelope("note", z.strictObject({ text: z.string() }));

const validNote = {
  type: "note",
  id: "0197a0f0-0000-7000-8000-000000000001",
  ts: "2026-11-21T10:00:00.000Z",
  payload: { text: "apply only after approval" },
};

// Returns issue paths joined with dots. An empty string means a form-level error.
const failingPathsOf = (schema: z.ZodType, value: unknown): string[] => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected validation failure");
  return result.error.issues.map((issue) => issue.path.join("."));
};

describe("envelope round trip", () => {
  it("parses a valid envelope and returns its exact content", () => {
    const result = noteEnvelopeSchema.safeParse(validNote);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(validNote);
  });

  it("survives a JSON serialization round trip", () => {
    const result = noteEnvelopeSchema.safeParse(JSON.parse(JSON.stringify(validNote)));

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(validNote);
  });

  it("preserves the declared type as a literal", () => {
    const result = noteEnvelopeSchema.parse(validNote);

    expect(result.type).toBe("note");
  });
});

describe("envelope rejection", () => {
  it("rejects a mismatched envelope type", () => {
    const paths = failingPathsOf(noteEnvelopeSchema, { ...validNote, type: "other" });

    expect(paths).toContain("type");
  });

  it("rejects a malformed id", () => {
    const paths = failingPathsOf(noteEnvelopeSchema, { ...validNote, id: "not-a-uuid" });

    expect(paths).toContain("id");
  });

  it.each([
    "2026-11-21T10:00:00",
    "2026-11-21T10:00:00+02:00",
    "21-11-2026",
  ])("rejects the non-UTC timestamp %s", (ts) => {
    const paths = failingPathsOf(noteEnvelopeSchema, { ...validNote, ts });

    expect(paths).toContain("ts");
  });

  it("rejects unknown envelope keys", () => {
    const paths = failingPathsOf(noteEnvelopeSchema, { ...validNote, extra: true });

    expect(paths).toContain("");
  });
});

describe("web URL schema", () => {
  it.each([
    "http://127.0.0.1:8787/fixtures/job/search",
    "https://jobs.example.com/postings/42",
  ])("accepts the page URL %s", (pageUrl) => {
    expect(webUrlSchema.safeParse(pageUrl).success).toBe(true);
  });

  it.each([
    "ftp://jobs.example.com/postings/42",
    "moz-extension://01234567-89ab-cdef-0123-456789abcdef/page.html",
    "javascript:alert(1)",
    "not a url",
  ])("rejects the non-http URL %s", (pageUrl) => {
    expect(webUrlSchema.safeParse(pageUrl).success).toBe(false);
  });
});
