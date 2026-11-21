import browser from "webextension-polyfill";
import {
  observedEventEnvelopeSchema,
  rehearsalActionSchema,
  type ObservedEventEnvelope,
  type SessionDescriptor,
} from "@dex-ai/shared";
import {
  getBrowserKind,
  type BlockedAttempt,
  type BlockedAttemptReportMessage,
  type TabMessage,
} from "../shared/messages";
import { startObservation, type ObservedPayload } from "./observer";
import { executeRehearsalAction, type RehearsalActionResult, type RehearsalExecutionDeps } from "./rehearsal-executor";
import { SubmitGuard } from "./submit-guard";

/**
 * Content script entry. It observes the tab, executes only the rehearsal
 * actions the coordinator routed into it, blocks every submission attempt
 * on forms under rehearsal and reports blocked attempts back to the
 * coordinator, which owns the control plane transport.
 */

const SESSION_STORAGE_KEY = "dex-ai:session-id";
let fallbackSessionId: string | null = null;
let currentPostingUrl: string | null = null;
let activeRehearsalId: string | null = null;

function isTabMessage(raw: unknown): raw is TabMessage {
  if (typeof raw !== "object" || raw === null) return false;
  const record = raw as Record<string, unknown>;
  if (record.type === "dex-ai:rehearsal-paused") {
    return typeof record.rehearsalId === "string" && typeof record.reason === "string";
  }
  if (record.type === "dex-ai:execute-action") {
    return typeof record.actionId === "string" && typeof record.action === "object" && record.action !== null;
  }
  return false;
}

function randomEventId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** One session id per tab, stable across page navigations. */
function getSessionId(): string {
  try {
    const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (stored !== null) return stored;
    const created = randomEventId();
    sessionStorage.setItem(SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    // Sandboxed pages can block storage access; the tab keeps one id in memory.
    fallbackSessionId ??= randomEventId();
    return fallbackSessionId;
  }
}

async function sendObservedEvents(events: readonly ObservedEventEnvelope[]): Promise<void> {
  const session: SessionDescriptor = {
    id: getSessionId(),
    browserKind: getBrowserKind(),
    sourceUrl: window.location.href,
    ...(currentPostingUrl === null ? {} : { postingUrl: currentPostingUrl }),
  };
  try {
    await browser.runtime.sendMessage({ type: "dex-ai:observed-events", session, events });
  } catch (error) {
    // Without the coordinator the batch is dropped; it re-captures on the
    // next interaction once the extension is reloaded.
    console.warn("dex-ai: observed events not delivered to the coordinator", error);
  }
}

function emitObservation(observation: ObservedPayload): void {
  if (observation.type === "posting_opened") currentPostingUrl = observation.payload.pageUrl;
  const envelope = {
    type: observation.type,
    id: randomEventId(),
    ts: new Date().toISOString(),
    payload: observation.payload,
  };
  // Only envelopes the control plane accepts leave the content script.
  const parsed = observedEventEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    console.warn("dex-ai: observed event dropped, it fails the envelope schema");
    return;
  }
  void sendObservedEvents([parsed.data]);
}

const guard = new SubmitGuard((attempt) => {
  reportBlockedAttempt(attempt, null);
});

function reportBlockedAttempt(attempt: BlockedAttempt, actionId: string | null): void {
  void browser.runtime
    .sendMessage({
      type: "dex-ai:blocked-attempt",
      rehearsalId: activeRehearsalId,
      actionId,
      attempt,
    } satisfies BlockedAttemptReportMessage)
    .catch(() => {
      // The coordinator records the attempt server-side; without it the
      // local guard history keeps it for inspection.
    });
}

// Rehearsal forms appear and disappear with the page, so the guard arms
// every current and future form once a rehearsal reaches this tab.
let formObserver: MutationObserver | null = null;

function armRehearsalGuard(): void {
  if (formObserver !== null) return;
  for (const form of Array.from(document.forms)) guard.arm(form);
  formObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof HTMLFormElement) guard.arm(node);
        else if (node instanceof Element) {
          for (const form of Array.from(node.querySelectorAll("form"))) guard.arm(form);
        }
      }
    }
  });
  if (document.documentElement !== null) {
    formObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
}

function executionDeps(): RehearsalExecutionDeps {
  return {
    doc: document,
    navigate: (url: string): void => {
      window.location.assign(url);
    },
  };
}

async function handleTabMessage(message: TabMessage): Promise<RehearsalActionResult> {
  if (message.type === "dex-ai:rehearsal-paused") {
    activeRehearsalId = message.rehearsalId;
    armRehearsalGuard();
    return { ok: true };
  }

  armRehearsalGuard();
  const parsed = rehearsalActionSchema.safeParse(message.action);
  if (!parsed.success) {
    // The action vocabulary has no submit kind, so anything the schema
    // refuses never runs on the page.
    return { ok: false, error: "Rehearsal action failed the shared schema" };
  }
  const result = await executeRehearsalAction(parsed.data, executionDeps());
  if (!result.ok && "blocked" in result) {
    guard.recordBlocked(result.attempt);
    reportBlockedAttempt(result.attempt, message.actionId);
  }
  return result;
}

browser.runtime.onMessage.addListener((rawMessage: unknown) => {
  if (!isTabMessage(rawMessage)) return undefined;
  return handleTabMessage(rawMessage).catch(
    (error: unknown): RehearsalActionResult => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
});

function startContentScript(): void {
  // Job-site tabs are http(s); anything else stays untouched.
  if (window.location.protocol !== "http:" && window.location.protocol !== "https:") return;
  startObservation({
    doc: document,
    pageUrl: window.location.href,
    emit: emitObservation,
    isFormUnderRehearsal: (form) => guard.isArmed(form),
  });
}

startContentScript();
