import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ProfileEntry } from "@dex-ai/shared";
import { scorePosting } from "./job-match";

function entry(section: string, key: string, value: unknown): ProfileEntry {
  return {
    id: randomUUID(),
    section,
    key,
    value,
    confidence: 0.7,
    status: "inferred",
    sourceEventIds: [randomUUID()],
    updatedAt: "2026-11-22T10:00:00.000Z",
  } as ProfileEntry;
}

const profile = [
  entry("preferences", "stated_reasons", ["Only remote roles"]),
  entry("job_sources", "search_queries", ["typescript"]),
  entry("criteria", "salary", "salary range shown"),
  entry("user_facts", "email", "sam@example.com"),
];

describe("scorePosting", () => {
  it("scores matched signals and explains matched and missed terms", () => {
    const result = scorePosting(
      { title: "Senior TypeScript Engineer", text: "Fully remote team. Competitive pay." },
      profile,
    );

    expect(result.score).toBe(67);
    expect(result.matched.map((signal) => signal.key)).toEqual(["stated_reasons", "search_queries"]);
    expect(result.matched[0]?.terms).toEqual(["remote"]);
    expect(result.missed.map((signal) => signal.key)).toEqual(["salary"]);
  });

  it("ignores user facts and returns a null score without match signals", () => {
    const result = scorePosting({ text: "sam@example.com" }, [profile[3] as ProfileEntry]);

    expect(result).toEqual({ score: null, matched: [], missed: [] });
  });
});
