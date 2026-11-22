import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestControlPlane,
  makeReasonStatedEvent,
  makeSessionDescriptor,
  postEventBatch,
  startTestControlPlane,
  TEST_TOKEN,
  type TestControlPlane,
} from "../test-server";

let controlPlane: TestControlPlane;

beforeEach(async () => {
  controlPlane = await startTestControlPlane();
});

afterEach(async () => {
  await closeTestControlPlane(controlPlane);
});

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${controlPlane.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/match", () => {
  it("scores a posting against the inferred profile", async () => {
    const session = makeSessionDescriptor();
    await postEventBatch(controlPlane, session, [
      makeReasonStatedEvent("2026-11-22T10:00:00.000Z", "Only remote roles"),
    ]);
    await post("/api/profile/inference", { sessionId: session.id });

    const response = await post("/api/match", { title: "Engineer", text: "This team is fully remote." });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { score: number; matched: Array<{ key: string }> };
    expect(body.score).toBe(100);
    expect(body.matched.map((signal) => signal.key)).toEqual(["stated_reasons"]);
  });

  it("rejects a request without posting text", async () => {
    const response = await post("/api/match", { title: "Engineer" });

    expect(response.status).toBe(400);
  });
});
