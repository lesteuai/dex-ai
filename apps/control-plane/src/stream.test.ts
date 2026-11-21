import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsEvent } from "@dex-ai/shared";
import WebSocket from "ws";
import type { RawData } from "ws";
import {
  TEST_TOKEN,
  closeTestControlPlane,
  startTestControlPlane,
  type TestControlPlane,
} from "./test-server";

let controlPlane: TestControlPlane;

beforeEach(async () => {
  controlPlane = await startTestControlPlane();
});

afterEach(async () => {
  await closeTestControlPlane(controlPlane);
});

function openStreamClient(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url, [`dex-ai.${TEST_TOKEN}`], { headers });
    client.once("open", () => resolve(client));
    client.once("error", (error: Error) => reject(error));
  });
}

function expectStreamRejection(
  url: string,
  protocols: string[] = [],
  headers: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve) => {
    const client = new WebSocket(url, protocols, { headers });
    client.once("error", (error: Error) => resolve(error.message));
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

describe("WebSocket /stream authentication", () => {
  it("authenticates a client presenting the dex-ai token subprotocol", async () => {
    const client = await openStreamClient(controlPlane.wsUrl);

    try {
      expect(client.protocol).toBe(`dex-ai.${TEST_TOKEN}`);
      await vi.waitFor(() => expect(controlPlane.handle.hub.subscriberCount).toBe(1));
    } finally {
      await closeStreamClient(client);
    }
  });

  it("rejects a client without the token subprotocol", async () => {
    const failure = await expectStreamRejection(controlPlane.wsUrl);

    expect(failure).toMatch(/401/);
    expect(controlPlane.handle.hub.subscriberCount).toBe(0);
  });

  it("rejects a client whose subprotocol carries an invalid token", async () => {
    const failure = await expectStreamRejection(controlPlane.wsUrl, [`dex-ai.${"x".repeat(64)}`]);

    expect(failure).toMatch(/401/);
    expect(controlPlane.handle.hub.subscriberCount).toBe(0);
  });

  it("rejects a token-bearing client from a disallowed origin", async () => {
    const failure = await expectStreamRejection(
      controlPlane.wsUrl,
      [`dex-ai.${TEST_TOKEN}`],
      { origin: "https://evil.example" },
    );

    expect(failure).toMatch(/403/);
    expect(controlPlane.handle.hub.subscriberCount).toBe(0);
  });
});

describe("stream event fanout", () => {
  it("delivers a published envelope to an authorized subscriber", async () => {
    const client = await openStreamClient(controlPlane.wsUrl);
    const event = {
      type: "task.failed",
      id: randomUUID(),
      ts: new Date().toISOString(),
      payload: { taskId: randomUUID(), message: "deterministic failure" },
    } satisfies WsEvent;

    try {
      await vi.waitFor(() => expect(controlPlane.handle.hub.subscriberCount).toBe(1));
      const received = waitForMessage(client);
      controlPlane.handle.hub.publish(event);
      expect(JSON.parse(await received)).toEqual(event);
    } finally {
      await closeStreamClient(client);
    }
  });

  it("closes subscribers on control-plane shutdown", async () => {
    const client = await openStreamClient(controlPlane.wsUrl);
    await vi.waitFor(() => expect(controlPlane.handle.hub.subscriberCount).toBe(1));
    const closeCode = new Promise<number>((resolve) =>
      client.once("close", (code) => resolve(code)),
    );

    await controlPlane.handle.close();
    expect(await closeCode).toBe(1001);
    expect(controlPlane.handle.hub.subscriberCount).toBe(0);
    await closeStreamClient(client);
  });
});
