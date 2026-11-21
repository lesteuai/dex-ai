import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEST_TOKEN,
  buildTestConfig,
  closeTestControlPlane,
  startTestControlPlane,
  type TestControlPlane,
} from "./test-server";

interface RecordedSelection {
  kind: string;
  dataDir?: string;
}

const factoryState = vi.hoisted(() => ({
  selections: [] as RecordedSelection[],
  closeCalls: 0,
}));

// The factory mock records the selection the lifecycle makes and keeps every
// test away from a real OpenCode host.
vi.mock("./agent/factory", () => ({
  createAgentAdapter: (selection: RecordedSelection) => {
    factoryState.selections.push(selection);
    return {
      start: async function* () {},
      cancel: async () => {},
      close: async () => {
        factoryState.closeCalls += 1;
      },
    };
  },
}));

let controlPlane: TestControlPlane | undefined;

afterEach(async () => {
  if (controlPlane) {
    await closeTestControlPlane(controlPlane);
    controlPlane = undefined;
  }
});

describe("control plane agent adapter lifecycle", () => {
  it("creates the deterministic adapter when agentKind is deterministic", async () => {
    controlPlane = await startTestControlPlane();

    expect(factoryState.selections.at(-1)).toEqual({ kind: "deterministic" });
  });

  it("creates the OpenCode adapter when agentKind is opencode", async () => {
    const config = { ...buildTestConfig(), agentKind: "opencode" as const };

    controlPlane = await startTestControlPlane(config);

    expect(factoryState.selections.at(-1)).toEqual({ kind: "opencode", dataDir: config.dataDir });
  });

  it("defaults to the OpenCode adapter when agentKind is missing", async () => {
    const config = { ...buildTestConfig(), agentKind: undefined };

    controlPlane = await startTestControlPlane(config);

    expect(factoryState.selections.at(-1)).toEqual({ kind: "opencode", dataDir: config.dataDir });
  });

  it("closes the agent host when the handle closes", async () => {
    controlPlane = await startTestControlPlane();
    const healthUrl = `${controlPlane.baseUrl}/api/health`;
    const health = await fetch(healthUrl, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    expect(health.status).toBe(200);

    const closeCallsBefore = factoryState.closeCalls;
    await controlPlane.handle.close();

    expect(factoryState.closeCalls).toBe(closeCallsBefore + 1);
    await expect(fetch(healthUrl, { headers: { authorization: `Bearer ${TEST_TOKEN}` } })).rejects.toThrow();
  });
});
