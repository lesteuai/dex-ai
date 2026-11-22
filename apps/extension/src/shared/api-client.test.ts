import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostEventsBatchRequest } from "@dex-ai/shared";
import {
  batchOk,
  eventUuid,
  jsonResponse,
  fieldFilledEvent,
  postingOpenedEvent,
  TEST_REHEARSAL,
  TEST_REHEARSAL_ID,
  TEST_SESSION,
} from "../testing/fixtures";
import type { ControlPlaneSettings } from "./auth";
import {
  ControlPlaneRequestError,
  postEventBatch,
  postRehearsalDecision,
  startRehearsal,
} from "./api-client";

const settings = (token: string | null): ControlPlaneSettings => ({
  baseUrl: "http://127.0.0.1:8787",
  token,
});

const batch: PostEventsBatchRequest = {
  session: TEST_SESSION,
  events: [postingOpenedEvent(eventUuid(1)), fieldFilledEvent(eventUuid(2))],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token gate", () => {
  it("refuses to post without a stored token and never calls fetch", async () => {
    await expect(postEventBatch(settings(null), batch)).rejects.toMatchObject({
      name: "ControlPlaneRequestError",
      status: 401,
      message: "No control plane token is stored",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses rehearsal and decision requests without a token too", async () => {
    await expect(
      startRehearsal(settings(null), {
        sessionId: TEST_SESSION.id,
        postingUrl: TEST_SESSION.postingUrl,
      }),
    ).rejects.toBeInstanceOf(ControlPlaneRequestError);
    await expect(
      postRehearsalDecision(settings(null), TEST_REHEARSAL_ID, { type: "pause" }),
    ).rejects.toBeInstanceOf(ControlPlaneRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("authenticated requests", () => {
  it("posts the event batch with the bearer token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, batchOk(2)));

    const response = await postEventBatch(settings("token-123"), batch);

    expect(response).toEqual(batchOk(2));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/events/batches");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer token-123",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual(batch);
  });

  it("starts a rehearsal and parses the record", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { rehearsal: TEST_REHEARSAL }));

    const { rehearsal } = await startRehearsal(settings("token-123"), {
      sessionId: TEST_SESSION.id,
      postingUrl: TEST_SESSION.postingUrl,
    });

    expect(rehearsal).toEqual(TEST_REHEARSAL);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/rehearsals");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-123");
  });
});

describe("control plane errors", () => {
  it("maps a validation failure to status, message and field errors", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: "InvalidEventBatch",
        message: "Invalid event batch",
        fieldErrors: { "events.0": ["pageUrl must be an http(s) URL"] },
      }),
    );

    await expect(postEventBatch(settings("token-123"), batch)).rejects.toMatchObject({
      status: 422,
      message: "Invalid event batch",
      fieldErrors: { "events.0": ["pageUrl must be an http(s) URL"] },
    });
  });

  it("falls back to a status message when the error body is unusable", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, null));

    await expect(postEventBatch(settings("token-123"), batch)).rejects.toMatchObject({
      status: 500,
      message: "Control plane request failed with status 500",
    });
  });
});
