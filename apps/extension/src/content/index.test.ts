// @vitest-environment happy-dom
import { observedEventEnvelopeSchema } from "@dex-ai/shared";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_REHEARSAL_ID } from "../testing/fixtures";

/**
 * Content script entry tests. The background coordinator is a mocked
 * browser.runtime, so no control plane and no real browser are involved.
 * Routed stream commands reach the tab as runtime messages: only the
 * shared rehearsal vocabulary executes, submit commands are refused, and
 * every blocked attempt is reported back for the session history.
 */

const polyfill = vi.hoisted(() => {
  const sentMessages: Array<Record<string, unknown>> = [];
  const messageListeners: Array<(message: unknown) => unknown> = [];

  const browser = {
    runtime: {
      sendMessage: async (message: unknown): Promise<unknown> => {
        sentMessages.push(message as Record<string, unknown>);
        return undefined;
      },
      onMessage: {
        addListener: (listener: (message: unknown) => unknown): void => {
          messageListeners.push(listener);
        },
      },
    },
  };

  return {
    browser,
    sentMessages,
    messageListeners,
    reset(): void {
      sentMessages.length = 0;
    },
  };
});

vi.mock("webextension-polyfill", () => ({ default: polyfill.browser }));

type ObservedEventsMessage = {
  type: "dex-ai:observed-events";
  session: { id: string; browserKind: string; sourceUrl: string; postingUrl?: string };
  events: Array<{ type: string; id: string; ts: string; payload: Record<string, unknown> }>;
};

type BlockedAttemptMessage = {
  type: "dex-ai:blocked-attempt";
  rehearsalId: string | null;
  actionId: string | null;
  attempt: { reason: string; selector?: string; url?: string };
};

function observedEventsMessages(): ObservedEventsMessage[] {
  return polyfill.sentMessages.filter((message) => message.type === "dex-ai:observed-events") as unknown as ObservedEventsMessage[];
}

function blockedAttemptMessages(): BlockedAttemptMessage[] {
  return polyfill.sentMessages.filter((message) => message.type === "dex-ai:blocked-attempt") as unknown as BlockedAttemptMessage[];
}

function sendTabMessage(message: unknown): Promise<unknown> {
  const listener = polyfill.messageListeners[0];
  if (!listener) throw new Error("content script runtime listener is missing");
  return listener(message) as Promise<unknown>;
}

// The posting_opened envelope left the content script while the entry
// module loaded, before any test could observe the transport.
let loadTimeMessages: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  // The page the tab opens first: a posting with an application form.
  document.title = "Backend Engineer";
  document.body.innerHTML = `
    <h1>Backend Engineer</h1>
    <a id="apply" href="/apply">Apply now</a>
    <form id="application" method="get">
      <label for="full-name">Full name</label>
      <input id="full-name" name="full_name" type="text">
      <button id="submit-application" type="submit">Submit application</button>
    </form>
  `;
  // Importing the entry arms observation and registers the tab listener.
  await import("./index");
  loadTimeMessages = [...polyfill.sentMessages];
  // The rehearsal reaches the tab as a pause message, which arms the guard.
  await sendTabMessage({ type: "dex-ai:rehearsal-paused", rehearsalId: TEST_REHEARSAL_ID, reason: "user_paused" });
});

beforeEach(() => {
  polyfill.reset();
});

describe("observation reaches the coordinator", () => {
  it("wraps the posting open in a valid envelope for the session timeline", () => {
    const messages = loadTimeMessages.filter((message) => message.type === "dex-ai:observed-events") as unknown as ObservedEventsMessage[];
    expect(messages).toHaveLength(1);
    const session = messages[0].session;
    expect(session.browserKind).toBe("chrome");
    expect(session.sourceUrl).toBe(window.location.href);
    expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const [event] = messages[0].events;
    expect(event.type).toBe("posting_opened");
    // Only envelopes the control plane accepts leave the content script.
    expect(observedEventEnvelopeSchema.safeParse(event).success).toBe(true);
    expect(event.payload).toEqual({ pageUrl: window.location.href, title: "Backend Engineer" });
  });

  it("sends a user's field fill to the coordinator with its selector and value", () => {
    const input = document.querySelector<HTMLInputElement>("#full-name")!;
    input.value = "Ada Lovelace";
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const events = observedEventsMessages().flatMap((message) => message.events);
    expect(events).toHaveLength(1);
    expect(observedEventEnvelopeSchema.safeParse(events[0]).success).toBe(true);
    expect(events[0].type).toBe("field_filled");
    expect(events[0].payload).toEqual({
      pageUrl: window.location.href,
      selector: "#full-name",
      label: "Full name",
      fieldType: "text",
      value: "Ada Lovelace",
    });
  });

  it("does not capture a submit on the guarded application form as a search", () => {
    const form = document.querySelector<HTMLFormElement>("#application")!;
    (form.querySelector<HTMLInputElement>("#full-name")!).value = "Ada Lovelace";

    const notCanceled = form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(notCanceled).toBe(false);
    expect(observedEventsMessages()).toEqual([]);
  });
});

describe("rehearsal command routing", () => {
  it("executes an approved fill but keeps it out of the user's captured events", async () => {
    const response = await sendTabMessage({
      type: "dex-ai:execute-action",
      actionId: "action-1",
      action: { kind: "fill", selector: "#full-name", value: "Grace Hopper" },
    });

    expect(response).toEqual({ ok: true });
    expect(document.querySelector<HTMLInputElement>("#full-name")!.value).toBe("Grace Hopper");
    expect(observedEventsMessages().flatMap((message) => message.events)).toEqual([]);
  });

  it("refuses a submit command that the stream vocabulary does not have", async () => {
    const clickSpy = vi.fn();
    document.querySelector("#submit-application")!.addEventListener("click", clickSpy);

    const response = await sendTabMessage({
      type: "dex-ai:execute-action",
      actionId: "action-2",
      action: { kind: "submit", selector: "#submit-application" },
    });

    expect(response).toEqual({ ok: false, error: "Rehearsal action failed the shared schema" });
    expect(clickSpy).not.toHaveBeenCalled();
    expect(blockedAttemptMessages()).toEqual([]);
  });

  it("refuses other stream commands outside the rehearsal vocabulary", async () => {
    for (const action of [{ kind: "press_key", selector: "#full-name" }, { kind: "submit_form" }]) {
      const response = await sendTabMessage({ type: "dex-ai:execute-action", actionId: "action-3", action });
      expect(response).toEqual({ ok: false, error: "Rehearsal action failed the shared schema" });
    }
  });

  it("blocks a submit-shaped click routed from the stream and reports the attempt", async () => {
    const clickSpy = vi.fn();
    document.querySelector("#submit-application")!.addEventListener("click", clickSpy);

    const response = await sendTabMessage({
      type: "dex-ai:execute-action",
      actionId: "action-4",
      action: { kind: "click_non_submit", selector: "#submit-application" },
    });

    expect(response).toEqual({
      ok: false,
      blocked: true,
      attempt: { reason: "submit_activation", selector: "#submit-application" },
    });
    expect(clickSpy).not.toHaveBeenCalled();
    // The guard reports its own history with a null action id; the router
    // reports the same attempt with the stream action id.
    expect(blockedAttemptMessages()).toEqual([
      {
        type: "dex-ai:blocked-attempt",
        rehearsalId: TEST_REHEARSAL_ID,
        actionId: null,
        attempt: { reason: "submit_activation", selector: "#submit-application" },
      },
      {
        type: "dex-ai:blocked-attempt",
        rehearsalId: TEST_REHEARSAL_ID,
        actionId: "action-4",
        attempt: { reason: "submit_activation", selector: "#submit-application" },
      },
    ]);
  });

  it("blocks submit-shaped navigation and reports the attempt with the action id", async () => {
    const submitUrl = `${window.location.href}/submit`;
    const response = await sendTabMessage({
      type: "dex-ai:execute-action",
      actionId: "action-5",
      action: { kind: "navigate", url: submitUrl },
    });

    expect(response).toEqual({ ok: false, blocked: true, attempt: { reason: "submit_navigation", url: submitUrl } });
    expect(blockedAttemptMessages()).toEqual([
      {
        type: "dex-ai:blocked-attempt",
        rehearsalId: TEST_REHEARSAL_ID,
        actionId: null,
        attempt: { reason: "submit_navigation", url: submitUrl },
      },
      {
        type: "dex-ai:blocked-attempt",
        rehearsalId: TEST_REHEARSAL_ID,
        actionId: "action-5",
        attempt: { reason: "submit_navigation", url: submitUrl },
      },
    ]);
  });

  it("reports a guard-blocked submit event with a null action id", () => {
    const form = document.querySelector<HTMLFormElement>("#application")!;

    const notCanceled = form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(notCanceled).toBe(false);
    expect(blockedAttemptMessages()).toEqual([
      {
        type: "dex-ai:blocked-attempt",
        rehearsalId: TEST_REHEARSAL_ID,
        actionId: null,
        attempt: { reason: "submit_control", selector: "#application" },
      },
    ]);
  });

  it("ignores runtime messages outside the tab vocabulary", async () => {
    const response = await sendTabMessage({ type: "dex-ai:observed-events", session: null, events: [] });

    expect(response).toBeUndefined();
    expect(polyfill.sentMessages).toEqual([]);
  });
});
