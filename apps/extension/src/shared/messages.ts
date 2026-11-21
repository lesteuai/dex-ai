import type {
  ObservedEventEnvelope,
  RehearsalAction,
  RehearsalRecord,
  SessionDescriptor,
} from "@dex-ai/shared";

/**
 * Message vocabulary between the extension contexts: popup and content
 * scripts talk to the background coordinator, and the coordinator routes
 * rehearsal messages into the active tab.
 */

export type BrowserKind = "chrome" | "firefox";

export function getBrowserKind(): BrowserKind {
  return navigator.userAgent.includes("Firefox") ? "firefox" : "chrome";
}

export interface SetControlPlaneSettingsMessage {
  type: "dex-ai:set-settings";
  baseUrl?: string;
  token?: string | null;
}

export interface GetControlPlaneSettingsMessage {
  type: "dex-ai:get-settings";
}

export interface ObservedEventsMessage {
  type: "dex-ai:observed-events";
  session: SessionDescriptor;
  events: ObservedEventEnvelope[];
}

export interface StartRehearsalMessage {
  type: "dex-ai:start-rehearsal";
  postingUrl?: string;
}

export type ExtensionMessage =
  | SetControlPlaneSettingsMessage
  | GetControlPlaneSettingsMessage
  | ObservedEventsMessage
  | StartRehearsalMessage;

export function isExtensionMessage(raw: unknown): raw is ExtensionMessage {
  return (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as { type?: unknown }).type === "string" &&
    (raw as { type: string }).type.startsWith("dex-ai:")
  );
}

// Coordinator responses, one per request message kind.

export type ControlPlaneSettingsResponse = { baseUrl: string; token: string | null };

export type SaveSettingsResponse = { ok: true } | { ok: false; error: string };

export type QueuedEventsResponse = { ok: true; queued: number } | { ok: false; error: string };

export type StartRehearsalResponse =
  | { ok: true; rehearsal: RehearsalRecord }
  | { ok: false; error: string };

export type CoordinatorResponse =
  | ControlPlaneSettingsResponse
  | SaveSettingsResponse
  | QueuedEventsResponse
  | StartRehearsalResponse;

// Messages the coordinator sends into the active tab's content script.
// Mirrors rehearsalPauseReasonSchema from @dex-ai/shared.

export type RehearsalPauseReason = "low_confidence" | "user_paused" | "interrupted" | "disconnected";

export interface ExecuteRehearsalActionMessage {
  type: "dex-ai:execute-action";
  actionId: string;
  action: RehearsalAction;
}

export interface RehearsalPausedMessage {
  type: "dex-ai:rehearsal-paused";
  rehearsalId: string;
  reason: RehearsalPauseReason;
}

export type TabMessage = ExecuteRehearsalActionMessage | RehearsalPausedMessage;
