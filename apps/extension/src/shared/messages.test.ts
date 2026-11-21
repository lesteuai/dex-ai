import { afterEach, describe, expect, it, vi } from "vitest";
import { getBrowserKind, isExtensionMessage } from "./messages";
import { eventUuid, postingOpenedEvent, TEST_SESSION } from "../testing/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser kind detection", () => {
  it("detects Firefox from the user agent", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
    });
    expect(getBrowserKind()).toBe("firefox");
  });

  it("treats every other user agent as Chrome", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    expect(getBrowserKind()).toBe("chrome");
  });
});

describe("extension message guard", () => {
  it("accepts every coordinator message kind", () => {
    expect(isExtensionMessage({ type: "dex-ai:get-settings" })).toBe(true);
    expect(isExtensionMessage({ type: "dex-ai:set-settings", token: "token-123" })).toBe(true);
    expect(
      isExtensionMessage({
        type: "dex-ai:observed-events",
        session: TEST_SESSION,
        events: [postingOpenedEvent(eventUuid(1))],
      }),
    ).toBe(true);
    expect(
      isExtensionMessage({ type: "dex-ai:start-rehearsal", postingUrl: TEST_SESSION.postingUrl }),
    ).toBe(true);
  });

  it("rejects values without a dex-ai message type", () => {
    for (const raw of [null, "dex-ai:get-settings", 42, { type: "unrelated:message" }, { type: 7 }]) {
      expect(isExtensionMessage(raw)).toBe(false);
    }
  });
});
