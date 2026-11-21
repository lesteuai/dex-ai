import { describe, expect, it } from "vitest";
import {
  rehearsalActionKindSchema,
  rehearsalActionSchema,
  rehearsalActionStatusSchema,
  rehearsalBlockReasonSchema,
  rehearsalDecisionRequestSchema,
  rehearsalPauseReasonSchema,
} from "./index";

const actionId = "0197a0f0-0000-7000-8000-000000000021";

describe("rehearsal action vocabulary", () => {
  it.each([
    { kind: "navigate", url: "https://jobs.example.com/postings/42/apply" },
    { kind: "focus", selector: "#email" },
    { kind: "fill", selector: "#email", value: "ada@example.com" },
    { kind: "click_non_submit", selector: "#next-step" },
    { kind: "scroll", selector: "#application-form", deltaY: 240 },
    { kind: "scroll", deltaY: -120 },
    { kind: "wait", durationMs: 500 },
  ])("accepts the $kind action", (action) => {
    expect(rehearsalActionSchema.safeParse(action).success).toBe(true);
  });

  it.each([
    { kind: "submit", selector: "#apply-button" },
    { kind: "requestSubmit", selector: "#application-form" },
    { kind: "submit_form", url: "https://jobs.example.com/postings/42/apply" },
    { kind: "click", selector: "#anything" },
  ])("rejects the submit-shaped action %j", (action) => {
    expect(rehearsalActionKindSchema.safeParse(action.kind).success).toBe(false);
    expect(rehearsalActionSchema.safeParse(action).success).toBe(false);
  });
});

describe("rehearsal action field rules", () => {
  it("rejects a navigate action to a non-http URL", () => {
    const result = rehearsalActionSchema.safeParse({
      kind: "navigate",
      url: "ftp://jobs.example.com/apply",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("url");
    }
  });

  it("rejects a fill action without a value", () => {
    const result = rehearsalActionSchema.safeParse({ kind: "fill", selector: "#email" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("value");
    }
  });

  it("rejects a wait action with a non-positive duration", () => {
    const result = rehearsalActionSchema.safeParse({ kind: "wait", durationMs: 0 });

    expect(result.success).toBe(false);
  });
});

describe("rehearsal pause and block reasons", () => {
  it.each(["low_confidence", "user_paused", "interrupted", "disconnected"])(
    "accepts the pause reason %s",
    (reason) => {
      expect(rehearsalPauseReasonSchema.safeParse(reason).success).toBe(true);
    },
  );

  it("rejects an undocumented pause reason", () => {
    expect(rehearsalPauseReasonSchema.safeParse("user_cancelled").success).toBe(false);
  });

  it.each(["submit_control", "submit_activation", "submit_navigation"])(
    "accepts the submit block reason %s",
    (reason) => {
      expect(rehearsalBlockReasonSchema.safeParse(reason).success).toBe(true);
    },
  );

  it("accepts the blocked action status for the session history", () => {
    expect(rehearsalActionStatusSchema.safeParse("blocked").success).toBe(true);
  });
});

describe("rehearsal decision requests", () => {
  it.each([
    { type: "approve", actionId },
    { type: "reject", actionId },
    { type: "pause" },
    { type: "resume" },
  ])("accepts the $type decision", (decision) => {
    expect(rehearsalDecisionRequestSchema.safeParse(decision).success).toBe(true);
  });

  it("accepts a correction that replaces a proposed fill action", () => {
    const result = rehearsalDecisionRequestSchema.safeParse({
      type: "correct",
      actionId,
      action: { kind: "fill", selector: "#email", value: "ada.lovelace@example.com" },
    });

    expect(result.success).toBe(true);
  });

  it("rejects a correction that smuggles in a submit action", () => {
    const result = rehearsalDecisionRequestSchema.safeParse({
      type: "correct",
      actionId,
      action: { kind: "submit", selector: "#apply-button" },
    });

    expect(result.success).toBe(false);
  });
});
