import { randomUUID } from "node:crypto";
import type { ObservedEventEnvelope, ProfileEntry, RehearsalAction, Rule } from "@dex-ai/shared";
import { describe, expect, it } from "vitest";
import {
  buildCorrectionPropagationPrompt,
  buildProfileInferencePrompt,
  buildRehearsalPlanPrompt,
  buildTeachingPrompt,
} from "./prompts";
import { PROFILE_SECTIONS } from "./results";

const observedEvent: ObservedEventEnvelope = {
  type: "field_filled",
  id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
  ts: "2026-11-21T10:00:00.000Z",
  payload: {
    pageUrl: "http://127.0.0.1:8787/fixtures/job/apply.html",
    selector: "#full-name",
    label: "Full name",
    value: "Jordan Lee",
  },
};

const existingEntry: ProfileEntry = {
  id: randomUUID(),
  section: "user_facts",
  key: "full_name",
  value: "Jordan Lee",
  confidence: 0.9,
  status: "corrected",
  sourceEventIds: [observedEvent.id],
  updatedAt: "2026-11-21T10:05:00.000Z",
};

const existingRule: Rule = {
  id: randomUUID(),
  scope: "rehearsal.fill",
  condition: { fieldLabelContains: "salary" },
  action: { fillValueFrom: "profile.salary_range" },
  confidence: 0.9,
  status: "confirmed",
  sourceSessionId: null,
  contributingRuleIds: [],
  updatedAt: "2026-11-21T10:05:00.000Z",
};

const priorAction: RehearsalAction = { kind: "fill", selector: "#email", value: "jordan@example.com" };
const correctedAction: RehearsalAction = { kind: "fill", selector: "#email", value: "jordan.lee@example.com" };

const JSON_ONLY_INSTRUCTION = "Respond with exactly one JSON object and nothing else.";

describe("buildProfileInferencePrompt", () => {
  const prompt = buildProfileInferencePrompt({
    sessionId: "session-1",
    events: [observedEvent],
    existingEntries: [existingEntry],
  });

  it("inlines the session id, observed events and existing entries", () => {
    expect(prompt).toContain("Session id: session-1");
    expect(prompt).toContain('"selector": "#full-name"');
    expect(prompt).toContain('"key": "full_name"');
    expect(prompt).toContain('"status": "corrected"');
  });

  it("lists every profile section in order and demands JSON only", () => {
    expect(prompt).toContain(PROFILE_SECTIONS.join(", "));
    expect(prompt).toContain("Never invent facts to fill it.");
    expect(prompt).toContain(JSON_ONLY_INSTRUCTION);
  });
});

describe("buildTeachingPrompt", () => {
  const prompt = buildTeachingPrompt({
    transcript: "Always answer the salary question with my stored range.",
    existingRules: [existingRule],
  });

  it("inlines the transcript and existing rules", () => {
    expect(prompt).toContain("Always answer the salary question with my stored range.");
    expect(prompt).toContain('"scope": "rehearsal.fill"');
    expect(prompt).toContain(JSON_ONLY_INSTRUCTION);
  });
});

describe("buildRehearsalPlanPrompt", () => {
  const base = {
    postingUrl: "http://127.0.0.1:8787/fixtures/job/posting.html",
    entries: [existingEntry],
    rules: [existingRule],
  };

  it("inlines the posting, profile and rules, and states the allowed action kinds", () => {
    const prompt = buildRehearsalPlanPrompt({ ...base, postingTitle: "Fixture Platform Engineer" });
    expect(prompt).toContain("Posting url: http://127.0.0.1:8787/fixtures/job/posting.html");
    expect(prompt).toContain("Posting title: Fixture Platform Engineer");
    expect(prompt).toContain("navigate, focus, fill, click_non_submit, scroll, wait");
    expect(prompt).toContain("There is deliberately no submit action.");
    expect(prompt).toContain(JSON_ONLY_INSTRUCTION);
  });

  it("omits the title line when no posting title is given", () => {
    const prompt = buildRehearsalPlanPrompt(base);
    expect(prompt).not.toContain("Posting title");
  });
});

describe("buildCorrectionPropagationPrompt", () => {
  const prompt = buildCorrectionPropagationPrompt({
    priorAction,
    correctedAction,
    correctionReason: "That email address is out of date, use the new one.",
    contributingRules: [existingRule],
  });

  it("inlines both actions, the stated reason and the contributing rules", () => {
    expect(prompt).toContain('"value": "jordan@example.com"');
    expect(prompt).toContain('"value": "jordan.lee@example.com"');
    expect(prompt).toContain("That email address is out of date, use the new one.");
    expect(prompt).toContain('"scope": "rehearsal.fill"');
    expect(prompt).toContain(JSON_ONLY_INSTRUCTION);
  });
});
