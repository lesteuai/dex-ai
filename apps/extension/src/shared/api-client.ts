import {
  postEventsBatchResponseSchema,
  rehearsalDecisionResponseSchema,
  startRehearsalResponseSchema,
  type PostEventsBatchRequest,
  type PostEventsBatchResponse,
  type RehearsalDecisionRequest,
  type RehearsalRecord,
  type StartRehearsalRequest,
} from "@dex-ai/shared";
import type { ControlPlaneSettings } from "./auth";

/** Authenticated REST calls from the extension to the local control plane. */

export class ControlPlaneRequestError extends Error {
  readonly status: number;
  readonly fieldErrors: Record<string, string[]>;

  constructor(status: number, message: string, fieldErrors: Record<string, string[]> = {}) {
    super(message);
    this.name = "ControlPlaneRequestError";
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

// AC-2: nothing leaves the extension without the stored local token.
async function authenticatedPost(
  settings: ControlPlaneSettings,
  path: string,
  body: unknown,
): Promise<unknown> {
  if (!settings.token) {
    throw new ControlPlaneRequestError(401, "No control plane token is stored");
  }
  const response = await fetch(new URL(path, settings.baseUrl).toString(), {
    method: "POST",
    headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = {};
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const message = typeof record.message === "string"
      ? record.message
      : `Control plane request failed with status ${response.status}`;
    const fieldErrors = typeof record.fieldErrors === "object" && record.fieldErrors !== null
      ? (record.fieldErrors as Record<string, string[]>)
      : {};
    throw new ControlPlaneRequestError(response.status, message, fieldErrors);
  }
  return parsed;
}

/** POST /api/events/batches with an authenticated event batch. */
export async function postEventBatch(
  settings: ControlPlaneSettings,
  batch: PostEventsBatchRequest,
): Promise<PostEventsBatchResponse> {
  const body = await authenticatedPost(settings, "/api/events/batches", batch);
  return postEventsBatchResponseSchema.parse(body);
}

/** POST /api/rehearsals to start a rehearsal for an observed session. */
export async function startRehearsal(
  settings: ControlPlaneSettings,
  request: StartRehearsalRequest,
): Promise<RehearsalRecord> {
  const body = await authenticatedPost(settings, "/api/rehearsals", request);
  return startRehearsalResponseSchema.parse(body).rehearsal;
}

/** POST /api/rehearsals/:id/decisions with an approve, correct, reject, pause or resume decision. */
export async function postRehearsalDecision(
  settings: ControlPlaneSettings,
  rehearsalId: string,
  decision: RehearsalDecisionRequest,
): Promise<RehearsalRecord> {
  const body = await authenticatedPost(settings, `/api/rehearsals/${rehearsalId}/decisions`, decision);
  return rehearsalDecisionResponseSchema.parse(body).rehearsal;
}
