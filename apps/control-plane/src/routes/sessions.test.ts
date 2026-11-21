import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTestConfig,
  closeTestControlPlane,
  fetchApi,
  getSessionList,
  getSessionTimeline,
  makeFieldFilledEvent,
  makeSearchEvent,
  makeSessionDescriptor,
  postEventBatch,
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

describe("session list", () => {
  it("lists stored sessions newest first", async () => {
    const older = makeSessionDescriptor();
    const newer = makeSessionDescriptor();
    await postEventBatch(controlPlane, older, [makeSearchEvent("2026-11-21T10:00:00.000Z")]);
    await postEventBatch(controlPlane, newer, [makeSearchEvent("2026-11-21T11:00:00.000Z")]);

    const listed = await getSessionList(controlPlane);

    expect(listed.map((summary) => summary.id)).toEqual([newer.id, older.id]);
    expect(listed[0]).toMatchObject({
      browserKind: "chrome",
      status: "active",
      sourceUrl: "https://jobs.example/listings",
      startedAt: "2026-11-21T11:00:00.000Z",
    });
  });

  it("returns 404 for an unknown session id", async () => {
    const response = await fetchApi(controlPlane, `/api/sessions/${randomUUID()}`);

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("not_found");
  });
});

describe("session timeline ordering", () => {
  it("orders out-of-order events chronologically within and across batches", async () => {
    const session = makeSessionDescriptor();
    const first = makeSearchEvent("2026-11-21T10:00:00.000Z");
    const third = makeFieldFilledEvent("2026-11-21T10:20:00.000Z");

    // The extension sends events as captured, so the batch arrives out of order.
    await readBatchResponse(await postEventBatch(controlPlane, session, [third, first]));

    // A later batch backfills an event between the two already stored.
    const middle = makeSearchEvent("2026-11-21T10:10:00.000Z", "rust");
    const late = makeFieldFilledEvent("2026-11-21T10:40:00.000Z", "#last-name", "Lovelace");
    await readBatchResponse(await postEventBatch(controlPlane, session, [late, middle]));

    const timeline = await getSessionTimeline(controlPlane, session.id);
    expect(storedEventIds(timeline.timeline)).toEqual([first.id, middle.id, third.id, late.id]);
  });
});

describe("persistence across restarts", () => {
  it("keeps sessions and timelines after a control-plane restart on the same data directory", async () => {
    const config = buildTestConfig();
    const session = makeSessionDescriptor({ browserKind: "firefox" });
    const events = [
      makeSearchEvent("2026-11-21T10:00:00.000Z"),
      makeFieldFilledEvent("2026-11-21T10:10:00.000Z"),
    ];

    const first = await startTestControlPlane(config);
    const stored = await readBatchResponse(await postEventBatch(first, session, events));
    await first.handle.close();
    expect(stored.accepted).toBe(2);

    const restarted = await startTestControlPlane(config);
    try {
      expect((await getSessionList(restarted)).map((summary) => summary.id)).toEqual([session.id]);

      const timeline = await getSessionTimeline(restarted, session.id);
      expect(timeline.session.browserKind).toBe("firefox");
      expect(storedEventIds(timeline.timeline)).toEqual(events.map((event) => event.id));
    } finally {
      await closeTestControlPlane(restarted);
    }
  });
});
