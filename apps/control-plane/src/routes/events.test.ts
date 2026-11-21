import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { RawData } from "ws";
import {
  TEST_TOKEN,
  closeTestControlPlane,
  fetchApi,
  getSessionList,
  getSessionTimeline,
  makeFieldFilledEvent,
  makePostingOpenedEvent,
  makeReasonStatedEvent,
  makeSearchEvent,
  makeSessionDescriptor,
  postEventBatch,
  postEventBatchBody,
  readBatchResponse,
  startTestControlPlane,
  storedEventIds,
  type TestControlPlane,
} from "../test-server";

let controlPlane: TestControlPlane;

beforeEach(async () => {
  controlPlane = await startTestControlPlane();
});

afterEach(async () => {
  await closeTestControlPlane(controlPlane);
});

describe("event batch ingest", () => {
  it("stores a valid batch for one session", async () => {
    const session = makeSessionDescriptor();
    const events = [
      makeSearchEvent("2026-11-21T10:00:00.000Z"),
      makePostingOpenedEvent("2026-11-21T10:05:00.000Z"),
      makeFieldFilledEvent("2026-11-21T10:10:00.000Z"),
      makeReasonStatedEvent("2026-11-21T10:15:00.000Z", "the posting allows fully remote work"),
    ];

    const body = await readBatchResponse(await postEventBatch(controlPlane, session, events));

    expect(body.sessionId).toBe(session.id);
    expect(body.accepted).toBe(4);
    expect(body.duplicates).toBe(0);
    expect(body.rejected).toEqual([]);

    const timeline = await getSessionTimeline(controlPlane, session.id);
    expect(timeline.session.id).toBe(session.id);
    expect(storedEventIds(timeline.timeline)).toEqual(events.map((event) => event.id));
  });

  it("stores batches from chrome and firefox sessions through the same path", async () => {
    const chromeSession = makeSessionDescriptor({ browserKind: "chrome" });
    const firefoxSession = makeSessionDescriptor({ browserKind: "firefox" });
    const chromeEvent = makeSearchEvent("2026-11-21T10:00:00.000Z");
    const firefoxEvent = makeSearchEvent("2026-11-21T11:00:00.000Z", "rust");

    const chromeBody = await readBatchResponse(
      await postEventBatch(controlPlane, chromeSession, [chromeEvent]),
    );
    const firefoxBody = await readBatchResponse(
      await postEventBatch(controlPlane, firefoxSession, [firefoxEvent]),
    );

    expect(chromeBody.accepted).toBe(1);
    expect(firefoxBody.accepted).toBe(1);

    const listed = await getSessionList(controlPlane);
    const listedKinds = listed.map((summary) => [summary.id, summary.browserKind]);
    expect(listedKinds).toContainEqual([chromeSession.id, "chrome"]);
    expect(listedKinds).toContainEqual([firefoxSession.id, "firefox"]);

    const chromeTimeline = await getSessionTimeline(controlPlane, chromeSession.id);
    const firefoxTimeline = await getSessionTimeline(controlPlane, firefoxSession.id);
    expect(chromeTimeline.session.browserKind).toBe("chrome");
    expect(firefoxTimeline.session.browserKind).toBe("firefox");
    expect(storedEventIds(chromeTimeline.timeline)).toEqual([chromeEvent.id]);
    expect(storedEventIds(firefoxTimeline.timeline)).toEqual([firefoxEvent.id]);
  });

  it("ignores duplicate event ids within a batch and across batches", async () => {
    const session = makeSessionDescriptor();
    const first = makeSearchEvent("2026-11-21T10:00:00.000Z");
    const second = makePostingOpenedEvent("2026-11-21T10:05:00.000Z");

    const stored = await readBatchResponse(await postEventBatch(controlPlane, session, [first, second]));
    expect(stored.accepted).toBe(2);

    const replay = await readBatchResponse(await postEventBatch(controlPlane, session, [first, second]));
    expect(replay.accepted).toBe(0);
    expect(replay.duplicates).toBe(2);

    const repeated = makeFieldFilledEvent("2026-11-21T10:10:00.000Z");
    const sameIdTwice = await readBatchResponse(
      await postEventBatch(controlPlane, session, [
        repeated,
        { ...repeated, ts: "2026-11-21T10:11:00.000Z" },
      ]),
    );
    expect(sameIdTwice.accepted).toBe(1);
    expect(sameIdTwice.duplicates).toBe(1);

    const timeline = await getSessionTimeline(controlPlane, session.id);
    expect(storedEventIds(timeline.timeline)).toEqual([first.id, second.id, repeated.id]);
  });

  it("rejects a malformed envelope with actionable errors and keeps it out of the store", async () => {
    const session = makeSessionDescriptor();
    const malformed = {
      type: "search_filter",
      id: randomUUID(),
      ts: "not-a-timestamp",
      payload: { pageUrl: "https://jobs.example/listings", query: "", filters: {} },
    };
    const valid = makeFieldFilledEvent("2026-11-21T10:10:00.000Z");

    const body = await readBatchResponse(
      await postEventBatch(controlPlane, session, [malformed, valid]),
    );

    expect(body.accepted).toBe(1);
    expect(body.rejected).toHaveLength(1);
    const [rejection] = body.rejected;
    expect(rejection.index).toBe(0);
    expect(rejection.id).toBe(malformed.id);
    expect(
      rejection.formErrors.length + Object.values(rejection.fieldErrors).flat().length,
    ).toBeGreaterThan(0);

    const timeline = await getSessionTimeline(controlPlane, session.id);
    expect(storedEventIds(timeline.timeline)).toEqual([valid.id]);
  });

  it("writes no session and no events when every envelope in a batch is malformed", async () => {
    const session = makeSessionDescriptor();
    const malformed = { type: "field_filled", id: "not-a-uuid", ts: "yesterday", payload: {} };

    const body = await readBatchResponse(await postEventBatch(controlPlane, session, [malformed]));

    expect(body.sessionId).toBe(session.id);
    expect(body.accepted).toBe(0);
    expect(body.duplicates).toBe(0);
    expect(body.rejected).toHaveLength(1);

    const detail = await fetchApi(controlPlane, `/api/sessions/${session.id}`);
    expect(detail.status).toBe(404);
    expect(await getSessionList(controlPlane)).toEqual([]);
  });

  it("rejects an invalid batch shape without writing anything", async () => {
    const response = await postEventBatchBody(controlPlane, {
      events: [makeSearchEvent("2026-11-21T10:00:00.000Z")],
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; fieldErrors: Record<string, string[]> };
    expect(body.error).toBe("invalid_request");
    expect(body.fieldErrors.session?.length).toBeGreaterThan(0);
    expect(await getSessionList(controlPlane)).toEqual([]);
  });
});

describe("live session updates", () => {
  function openStreamClient(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const client = new WebSocket(controlPlane.wsUrl, [`dex-ai.${TEST_TOKEN}`]);
      client.once("open", () => resolve(client));
      client.once("error", (error: Error) => reject(error));
    });
  }

  function waitForMessage(client: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      client.once("message", (data: RawData) => resolve(String(data)));
      client.once("error", (error: Error) => reject(error));
    });
  }

  function closeStreamClient(client: WebSocket): Promise<void> {
    return new Promise((resolve) => {
      if (client.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      client.once("close", () => resolve());
      client.close(1000, "test finished");
    });
  }

  it("publishes session.updated through the stream hub when a batch lands", async () => {
    const client = await openStreamClient();
    try {
      await vi.waitFor(() => expect(controlPlane.handle.hub.subscriberCount).toBe(1));
      const session = makeSessionDescriptor();
      const received = waitForMessage(client);

      const body = await readBatchResponse(
        await postEventBatch(controlPlane, session, [makeSearchEvent("2026-11-21T10:00:00.000Z")]),
      );
      expect(body.accepted).toBe(1);

      const message = JSON.parse(await received) as {
        type: string;
        payload: { session: { id: string; status: string } };
      };
      expect(message.type).toBe("session.updated");
      expect(message.payload.session.id).toBe(session.id);
      expect(message.payload.session.status).toBe("active");
    } finally {
      await closeStreamClient(client);
    }
  });
});
