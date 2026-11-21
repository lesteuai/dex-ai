import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  observedEventEnvelopeSchema,
  postEventsBatchRequestSchema,
  postEventsBatchResponseSchema,
} from "./index";

const ts = "2026-11-21T10:00:00.000Z";
const sessionId = "0197a0f0-0000-7000-8000-000000000010";

const envelopeOf = (type: string, id: string, payload: unknown) => ({ type, id, ts, payload });

const searchFilterEvent = envelopeOf("search_filter", "0197a0f0-0000-7000-8000-000000000001", {
  pageUrl: "https://jobs.example.com/search",
  query: "frontend engineer",
  filters: { remote: "true" },
});
const postingOpenedEvent = envelopeOf("posting_opened", "0197a0f0-0000-7000-8000-000000000002", {
  pageUrl: "https://jobs.example.com/postings/42",
  title: "Frontend Engineer",
});
const fieldFilledEvent = envelopeOf("field_filled", "0197a0f0-0000-7000-8000-000000000003", {
  pageUrl: "https://jobs.example.com/postings/42/apply",
  selector: "#first-name",
  label: "First name",
  fieldType: "text",
  value: "Ada",
});
const reasonStatedEvent = envelopeOf("reason_stated", "0197a0f0-0000-7000-8000-000000000004", {
  pageUrl: "https://jobs.example.com/postings/42",
  input: "voice",
  text: "I prefer small teams",
  relatedEventId: "0197a0f0-0000-7000-8000-000000000002",
});

const validEvents = [searchFilterEvent, postingOpenedEvent, fieldFilledEvent, reasonStatedEvent];

const failingPathsOf = (schema: z.ZodType, value: unknown): string[] => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected validation failure");
  return result.error.issues.map((issue) => issue.path.join("."));
};

const batchOf = (events: unknown[]) => ({
  session: {
    id: sessionId,
    browserKind: "chrome",
    sourceUrl: "https://jobs.example.com/search",
  },
  events,
});

describe("valid observed events", () => {
  it.each([
    ["search_filter", searchFilterEvent],
    ["posting_opened", postingOpenedEvent],
    ["field_filled", fieldFilledEvent],
    ["reason_stated", reasonStatedEvent],
  ])("accepts a %s envelope from either browser", (_name, event) => {
    expect(observedEventEnvelopeSchema.safeParse(event).success).toBe(true);
  });
});

describe("search_filter content rule", () => {
  it("rejects an empty query with no filters", () => {
    const result = observedEventEnvelopeSchema.safeParse(
      envelopeOf("search_filter", "0197a0f0-0000-7000-8000-000000000005", {
        pageUrl: "https://jobs.example.com/search",
        query: "",
        filters: {},
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "A search_filter event needs a query or at least one filter",
      );
    }
  });
});

describe("malformed event rejection with field-specific errors", () => {
  it("reports each invalid field_filled payload field by path", () => {
    const paths = failingPathsOf(
      observedEventEnvelopeSchema,
      envelopeOf("field_filled", "0197a0f0-0000-7000-8000-000000000006", {
        pageUrl: "ftp://jobs.example.com/apply",
        selector: "",
        value: 5,
      }),
    );

    expect(paths).toContain("payload.pageUrl");
    expect(paths).toContain("payload.selector");
    expect(paths).toContain("payload.value");
  });

  it("reports an unknown reason input by path", () => {
    const paths = failingPathsOf(
      observedEventEnvelopeSchema,
      envelopeOf("reason_stated", "0197a0f0-0000-7000-8000-000000000007", {
        input: "gesture",
        text: "I prefer small teams",
      }),
    );

    expect(paths).toContain("payload.input");
  });

  it("rejects an unknown event type at the discriminator", () => {
    const paths = failingPathsOf(
      observedEventEnvelopeSchema,
      envelopeOf("field_blurred", "0197a0f0-0000-7000-8000-000000000008", {
        pageUrl: "https://jobs.example.com/postings/42",
      }),
    );

    expect(paths).toContain("type");
  });
});

describe("event batch request contract", () => {
  it("accepts a batch with all four event kinds", () => {
    const result = postEventsBatchRequestSchema.safeParse(batchOf(validEvents));

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.events).toHaveLength(4);
  });

  it("rejects a batch with no events", () => {
    const paths = failingPathsOf(postEventsBatchRequestSchema, batchOf([]));

    expect(paths).toContain("events");
  });

  it("rejects a batch above the 200-event cap", () => {
    const events = Array.from({ length: 201 }, (_, index) => ({
      ...postingOpenedEvent,
      id: `0197a0f0-0000-7000-8000-${String(index).padStart(12, "0")}`,
    }));

    expect(failingPathsOf(postEventsBatchRequestSchema, batchOf(events))).toContain("events");
  });

  it("rejects a batch containing a malformed event with a field-specific error", () => {
    const malformedEvent = envelopeOf("field_filled", "0197a0f0-0000-7000-8000-000000000009", {
      pageUrl: "https://jobs.example.com/postings/42/apply",
      selector: "",
      value: "Ada",
    });
    const result = postEventsBatchRequestSchema.safeParse(batchOf([
      postingOpenedEvent,
      malformedEvent,
    ]));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(z.flattenError(result.error).fieldErrors.events).toBeDefined();
      expect(failingPathsOf(observedEventEnvelopeSchema, malformedEvent)).toContain(
        "payload.selector",
      );
    }
  });
});

describe("event batch response contract", () => {
  it("accepts a response that counts duplicate event IDs instead of storing them", () => {
    const result = postEventsBatchResponseSchema.safeParse({
      sessionId,
      accepted: 3,
      duplicates: 1,
      rejected: [],
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.duplicates).toBe(1);
  });

  it("accepts a rejection record with field-specific error details", () => {
    const result = postEventsBatchResponseSchema.safeParse({
      sessionId,
      accepted: 0,
      duplicates: 0,
      rejected: [
        {
          index: 1,
          id: "0197a0f0-0000-7000-8000-000000000009",
          formErrors: [],
          fieldErrors: { "payload.selector": ["Too small: expected string to have >=1 characters"] },
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});
