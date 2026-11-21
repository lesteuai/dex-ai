import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "./client";

const TOKEN = "t".repeat(64);

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function captureApiError(promise: Promise<unknown>): Promise<ApiError> {
  const caught = await promise.catch((error: unknown) => error);
  if (!(caught instanceof ApiError)) throw new Error("expected an ApiError");
  return caught;
}

function stubFetch(implementation: () => Promise<Response>) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(implementation);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createApiClient", () => {
  it("sends the bearer token on every request", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { ok: true }));

    await createApiClient(TOKEN).getHealth();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/health");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(init?.body).toBeUndefined();
  });

  it("sends a JSON body with a content type on POST", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { ok: true }));

    await createApiClient(TOKEN).post<{ ok: boolean }>("/teaching/apply", { text: "prefer small teams" });

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    });
    expect(init?.body).toBe(JSON.stringify({ text: "prefer small teams" }));
  });

  it("returns the parsed response body", async () => {
    const sessions = { sessions: [] };
    stubFetch(async () => jsonResponse(200, sessions));

    const response = await createApiClient(TOKEN).getSessions();

    expect(response).toEqual(sessions);
  });

  it("throws ApiError with the message and field errors from the error body", async () => {
    stubFetch(async () =>
      jsonResponse(422, {
        error: "validation_failed",
        message: "The batch was rejected",
        fieldErrors: { "events.0.type": ["unrecognized event type"] },
      }),
    );

    const apiError = await captureApiError(createApiClient(TOKEN).post("/events/batch", {}));

    expect(apiError.status).toBe(422);
    expect(apiError.message).toBe("The batch was rejected");
    expect(apiError.fieldErrors).toEqual({ "events.0.type": ["unrecognized event type"] });
  });

  it("falls back to the status message when the error body does not match the schema", async () => {
    stubFetch(async () => jsonResponse(503, { unexpected: "shape" }));

    const apiError = await captureApiError(createApiClient(TOKEN).getHealth());

    expect(apiError.status).toBe(503);
    expect(apiError.message).toBe("Control plane responded with 503");
    expect(apiError.fieldErrors).toEqual({});
  });

  it("falls back to the status message when the error body is not JSON", async () => {
    stubFetch(async () => new Response("server error", { status: 500, headers: { "Content-Type": "text/plain" } }));

    const apiError = await captureApiError(createApiClient(TOKEN).getHealth());

    expect(apiError.status).toBe(500);
    expect(apiError.message).toBe("Control plane responded with 500");
    expect(apiError.fieldErrors).toEqual({});
  });
});
