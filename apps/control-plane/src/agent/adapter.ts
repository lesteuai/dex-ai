import { z } from "zod";

/**
 * Narrow contract between the control plane and any agent backend.
 * The production OpenCode adapter and the deterministic test adapter both
 * implement it, so no caller imports a provider SDK or network client.
 */

export const agentTaskKindSchema = z.enum([
  "profile_inference",
  "teaching",
  "rehearsal_planning",
  "correction_propagation",
]);

export const agentResultSchemaNameSchema = z.enum(["profile", "rules", "rehearsalPlan", "correction"]);

// Mirrors AGENT_TASK_STATUSES in src/db/schema.ts.
export const agentStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);

export type AgentTaskKind = z.infer<typeof agentTaskKindSchema>;
export type AgentResultSchemaName = z.infer<typeof agentResultSchemaNameSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/** Normalized event shape. Every adapter emits only these events. */
export const agentEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("status"), status: agentStatusSchema }),
  z.strictObject({ type: z.literal("reasoning"), text: z.string().min(1) }),
  z.strictObject({ type: z.literal("result"), value: z.unknown() }),
  z.strictObject({ type: z.literal("error"), message: z.string().min(1) }),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;

/** Defensive parse for provider-shaped events before they reach the stream. */
export function normalizeAgentEvent(raw: unknown): AgentEvent {
  return agentEventSchema.parse(raw);
}

export interface AgentStartInput {
  taskId: string;
  kind: AgentTaskKind;
  sessionId: string;
  /** Prompt text built by the builders in ./prompts. */
  prompt: string;
  resultSchema: AgentResultSchemaName;
  /** Adapters must stop emitting events once this signal aborts. */
  signal: AbortSignal;
}

export interface AgentAdapter {
  /**
   * Event stream contract: a task that runs opens with a running status and
   * ends on a terminal status. A result event precedes completed, an error
   * event precedes failed, and cancellation via the AbortSignal or cancel()
   * ends the stream with a cancelled status while any already emitted result
   * stays valid for the caller.
   */
  start(input: AgentStartInput): AsyncIterable<AgentEvent>;
  cancel(taskId: string): Promise<void>;
}
