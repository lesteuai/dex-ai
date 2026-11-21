import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultScriptedFixtures } from "./deterministic-adapter";
import type { AgentResultSchemaName } from "./adapter";
import { agentResultSchemas, parseAgentResult } from "./results";

const SCHEMA_NAMES = Object.keys(agentResultSchemas) as AgentResultSchemaName[];

const supportedEntry = {
  key: "full_name",
  value: "Jordan Lee",
  confidence: 0.9,
  sourceEventIds: [randomUUID()],
  reasoningTrace: "The same full name was typed on two fixture applications.",
};

const supportedProfile = {
  sections: [{ section: "user_facts" as const, entries: [supportedEntry] }],
};

describe("agent result schemas", () => {
  it("accepts every default scripted fixture result", () => {
    for (const name of SCHEMA_NAMES) {
      const fixture = defaultScriptedFixtures[name];
      expect(fixture, `missing default fixture for ${name}`).toBeDefined();
      expect(() => parseAgentResult(name, fixture?.result)).not.toThrow();
    }
  });

  it("accepts empty rules and correction results with no updates", () => {
    expect(() => parseAgentResult("rules", { rules: [] })).not.toThrow();
    expect(() => parseAgentResult("correction", { reasoningTrace: "Nothing to update.", ruleUpdates: [] })).not.toThrow();
  });

  it("rejects a profile entry with no source event", () => {
    const fabricated = {
      sections: [{ section: "user_facts" as const, entries: [{ ...supportedEntry, sourceEventIds: [] }] }],
    };
    expect(() => parseAgentResult("profile", fabricated)).toThrow();
  });

  it("rejects an unknown profile section name", () => {
    expect(() => parseAgentResult("profile", { sections: [{ section: "hobbies", entries: [] }] })).toThrow();
  });

  it("rejects unexpected keys, out-of-range confidence and empty traces in a profile result", () => {
    expect(() => parseAgentResult("profile", { ...supportedProfile, summary: "extra key" })).toThrow();
    expect(() =>
      parseAgentResult("profile", {
        sections: [{ section: "user_facts" as const, entries: [{ ...supportedEntry, confidence: 1.5 }] }],
      }),
    ).toThrow();
    expect(() =>
      parseAgentResult("profile", {
        sections: [{ section: "user_facts" as const, entries: [{ ...supportedEntry, reasoningTrace: "" }] }],
      }),
    ).toThrow();
  });

  it("rejects a rehearsal plan action outside the allowed vocabulary", () => {
    const plan = {
      postingUrl: "http://127.0.0.1:8787/fixtures/job/posting.html",
      reasoningTrace: "Plan uses the fixture apply page.",
      actions: [
        {
          action: { kind: "fill", selector: "#email", value: "jordan.lee@example.com" },
          confidence: 0.9,
          reasoning: "The email form rule backs this value.",
        },
      ],
    };
    expect(() => parseAgentResult("rehearsalPlan", plan)).not.toThrow();

    const submitPlan = {
      ...plan,
      actions: [{ action: { kind: "submit" }, confidence: 0.9, reasoning: "Attempt to submit." }],
    };
    expect(() => parseAgentResult("rehearsalPlan", submitPlan)).toThrow();
  });

  it("rejects a correction update whose rule id is not a uuid", () => {
    const correction = {
      reasoningTrace: "The correction replaces the email value.",
      ruleUpdates: [
        {
          ruleId: randomUUID(),
          condition: { fieldLabelContains: "email" },
          action: { fillValueFrom: "profile.email" },
          confidence: 0.9,
          changeReason: "The user corrected the email value.",
        },
      ],
    };
    expect(() => parseAgentResult("correction", correction)).not.toThrow();

    const badRuleId = {
      ...correction,
      ruleUpdates: [{ ...correction.ruleUpdates[0]!, ruleId: "email-rule" }],
    };
    expect(() => parseAgentResult("correction", badRuleId)).toThrow();
  });

  it("throws an error naming the schema that failed", () => {
    expect(() => parseAgentResult("rules", { rules: 3 })).toThrow(/Agent rules result failed validation/);
    expect(() => parseAgentResult("profile", null)).toThrow(/Agent profile result failed validation/);
  });
});
