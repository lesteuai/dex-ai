/**
 * Runtime selection between the deterministic test adapter and the production
 * OpenCode adapter. Automated runs pass kind "deterministic" so no test or
 * fixture run touches OpenCode or the network.
 */
import type { AgentAdapter, AgentStartInput } from "./adapter";
import { DeterministicAgentAdapter } from "./deterministic-adapter";
import { OpenCodeAgentAdapter, type OpenCodeAgentAdapterOptions } from "./opencode-adapter";

/** An AgentAdapter plus the explicit host shutdown the runtime joins to its own. */
export interface AgentAdapterHost extends AgentAdapter {
  close(): Promise<void>;
}

export type AgentAdapterSelection =
  | { kind: "deterministic" }
  | ({ kind: "opencode" } & OpenCodeAgentAdapterOptions);

export function createAgentAdapter(selection: AgentAdapterSelection): AgentAdapterHost {
  if (selection.kind === "deterministic") {
    return withIdleClose(new DeterministicAgentAdapter());
  }
  return new OpenCodeAgentAdapter(selection);
}

/** The deterministic adapter holds no host, so shutdown has nothing to close. */
function withIdleClose(adapter: AgentAdapter): AgentAdapterHost {
  return {
    start: (input: AgentStartInput) => adapter.start(input),
    cancel: (taskId: string) => adapter.cancel(taskId),
    close: async () => {},
  };
}
