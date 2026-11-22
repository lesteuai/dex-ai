import type {
  AutonomyAssessment,
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

/**
 * One submission attempt a guard refused. The reasons mirror
 * rehearsalBlockReasonSchema in @dex-ai/shared and the discriminated
 * blocked-attempt request the control plane records on
 * POST /api/rehearsals/:id/blocked-attempts.
 */
export type BlockedAttempt =
  | { reason: "submit_navigation"; url: string }
  | { reason: "submit_control" | "submit_activation"; selector: string };

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
  autoMode?: boolean;
}

/** A submit the content guard refused; the coordinator forwards it to the control plane. */
export interface BlockedAttemptReportMessage {
  type: "dex-ai:blocked-attempt";
  /** Null when the tab never learned its rehearsal id; the coordinator fills its own. */
  rehearsalId: string | null;
  actionId: string | null;
  attempt: BlockedAttempt;
}

export type ExtensionMessage =
  | SetControlPlaneSettingsMessage
  | GetControlPlaneSettingsMessage
  | ObservedEventsMessage
  | StartRehearsalMessage
  | BlockedAttemptReportMessage;

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
  | { ok: true; rehearsal: RehearsalRecord; autonomy?: AutonomyAssessment }
  | { ok: false; error: string };

export type BlockedAttemptResponse = { ok: true } | { ok: false; error: string };

export type CoordinatorResponse =
  | ControlPlaneSettingsResponse
  | SaveSettingsResponse
  | QueuedEventsResponse
  | StartRehearsalResponse
  | BlockedAttemptResponse;

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
