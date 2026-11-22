/**
 * Production AgentAdapter backed by the pinned @opencode/sdk host.
 * One embedded OpenCode host serves every task for the process lifetime.
 * Sessions run under the data directory workspace, subscription events are
 * filtered by session ID and normalized into the shared adapter contract,
 * and the final answer is validated against the result schemas. Every SDK
 * call stays inside this class.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { OpenCode, type OpenCodeEvent } from "@opencode/sdk";
import type { AgentAdapter, AgentEvent, AgentStartInput } from "./adapter";
import { parseAgentResult } from "./results";

type OpenCodeHost = Awaited<ReturnType<typeof OpenCode.create>>;

// Server-side subscription filter; server.connected always passes it too.
const SESSION_EVENT_TYPES = [
  "session.reasoning.ended",
  "session.text.ended",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;

type SessionEvent = Extract<
  OpenCodeEvent,
  { type: (typeof SESSION_EVENT_TYPES)[number] | "server.connected" }
>;

const WORKSPACE_DIR_NAME = "workspace";
const OPENCODE_DB_FILE_NAME = "opencode.db";
const DEFAULT_LOG_LEVEL: OpenCode.LogLevel = "warn";

export interface OpenCodeAgentAdapterOptions {
  dataDir: string;
  /** "provider/model", for example "opencode/big-pickle". */
  model?: string;
  log?: OpenCode.LogOptions;
}

interface OpenCodeModelRef {
  providerID: string;
  id: string;
}

function parseModelRef(model: string): OpenCodeModelRef {
  const slash = model.indexOf("/");
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

/** One task tracked from start() to its terminal event. */
interface ActiveOpenCodeTask {
  sessionID?: string;
  cancelRequested: boolean;
  subscription: AbortController;
}

function defaultLogEmit(entry: OpenCode.LogEntry): void {
  // One JSON line per entry keeps provider logs structured and inspectable.
  console.error(
    JSON.stringify({
      level: entry.level,
      message: entry.message,
      attributes: entry.attributes,
      cause: entry.cause instanceof Error ? entry.cause.message : entry.cause,
    }),
  );
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The prompt builders demand bare JSON, but providers often add a fence. */
function parseJsonAnswer(text: string): unknown {
  const withoutFences = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(withoutFences) as unknown;
  } catch (error) {
    throw new Error(`OpenCode final answer is not one JSON object: ${errorToMessage(error)}`, { cause: error });
  }
}

export class OpenCodeAgentAdapter implements AgentAdapter {
  private readonly workspaceDir: string;
  private readonly databasePath: string;
  private readonly log: OpenCode.LogOptions;
  private readonly model?: OpenCodeModelRef;
  private hostPromise?: Promise<OpenCodeHost>;
  private closed = false;
  private readonly activeTasks = new Map<string, ActiveOpenCodeTask>();
  private readonly cancelledTaskIds = new Set<string>();

  constructor(options: OpenCodeAgentAdapterOptions) {
    this.workspaceDir = join(options.dataDir, WORKSPACE_DIR_NAME);
    this.databasePath = join(options.dataDir, OPENCODE_DB_FILE_NAME);
    // OpenCode refuses sessions in a directory that does not exist yet.
    mkdirSync(this.workspaceDir, { recursive: true });
    this.log = options.log ?? { level: DEFAULT_LOG_LEVEL, emit: defaultLogEmit };
    this.model = options.model ? parseModelRef(options.model) : undefined;
  }

  start(input: AgentStartInput): AsyncIterable<AgentEvent> {
    return this.runTask(input);
  }

  async cancel(taskId: string): Promise<void> {
    await this.requestCancellation(taskId);
  }

  /** Closes the embedded host explicitly and ends every active task stream. */
  async close(): Promise<void> {
    this.closed = true;
    for (const active of this.activeTasks.values()) {
      active.cancelRequested = true;
      active.subscription.abort();
    }
    this.activeTasks.clear();
    const host = await this.hostPromise?.catch(() => undefined);
    this.hostPromise = undefined;
    await host?.close();
  }

  private ensureHost(): Promise<OpenCodeHost> {
    if (this.closed) throw new Error("OpenCode agent host is closed");
    if (!this.hostPromise) {
      this.hostPromise = OpenCode.create({
        database: { path: this.databasePath },
        log: this.log,
      });
      // A failed create must not poison later tasks; the next start retries.
      this.hostPromise.catch(() => {
        this.hostPromise = undefined;
      });
    }
    return this.hostPromise;
  }

  private async requestCancellation(taskId: string): Promise<void> {
    const active = this.activeTasks.get(taskId);
    if (!active) {
      this.cancelledTaskIds.add(taskId);
      return;
    }
    active.cancelRequested = true;
    // Aborting ends the event stream promptly; the interrupt below is best effort.
    active.subscription.abort();
    const sessionID = active.sessionID;
    if (!sessionID || !this.hostPromise) return;
    try {
      const host = await this.hostPromise;
      await host.sessions.interrupt({ sessionID });
    } catch {
      // The aborted stream already ends the task, so a failed interrupt is not fatal.
    }
  }

  private isCancellationRequested(active: ActiveOpenCodeTask, input: AgentStartInput): boolean {
    return active.cancelRequested || input.signal.aborted;
  }

  private async *emitStreamEnded(
    active: ActiveOpenCodeTask,
    input: AgentStartInput,
  ): AsyncGenerator<AgentEvent> {
    if (this.isCancellationRequested(active, input)) {
      yield { type: "status", status: "cancelled" };
      return;
    }
    yield { type: "error", message: "OpenCode event stream closed before the session finished" };
    yield { type: "status", status: "failed" };
  }

  private async *emitValidatedResult(
    input: AgentStartInput,
    answerText: string | undefined,
  ): AsyncGenerator<AgentEvent> {
    try {
      if (answerText === undefined) {
        throw new Error("OpenCode session finished without a final answer message");
      }
      const value = parseAgentResult(input.resultSchema, parseJsonAnswer(answerText));
      yield { type: "result", value };
      yield { type: "status", status: "completed" };
    } catch (error) {
      yield { type: "error", message: errorToMessage(error) };
      yield { type: "status", status: "failed" };
    }
  }

  /** The establishment pull may already carry an event, so replay it first. */
  private async *replayThenStream(
    stream: AsyncIterator<SessionEvent>,
    firstEvent: SessionEvent | undefined,
  ): AsyncGenerator<SessionEvent> {
    if (firstEvent !== undefined) yield firstEvent;
    for (;;) {
      const next = await stream.next();
      if (next.done) return;
      yield next.value;
    }
  }

  private async *consumeSessionEvents(
    stream: AsyncIterator<SessionEvent>,
    input: AgentStartInput,
    active: ActiveOpenCodeTask,
    firstEvent: SessionEvent | undefined,
  ): AsyncGenerator<AgentEvent> {
    let lastAnswerText: string | undefined;
    for await (const event of this.replayThenStream(stream, firstEvent)) {
      if (event.type === "server.connected") continue;
      if (event.data.sessionID !== active.sessionID) continue;
      if (this.isCancellationRequested(active, input)) {
        yield { type: "status", status: "cancelled" };
        return;
      }
      switch (event.type) {
        case "session.reasoning.ended":
          if (event.data.text) yield { type: "reasoning", text: event.data.text };
          break;
        case "session.text.ended":
          lastAnswerText = event.data.text;
          break;
        case "session.execution.succeeded":
          yield* this.emitValidatedResult(input, lastAnswerText);
          return;
        case "session.execution.failed":
          yield { type: "error", message: event.data.error.message };
          yield { type: "status", status: "failed" };
          return;
        case "session.execution.interrupted":
          yield { type: "status", status: "cancelled" };
          return;
      }
    }
    yield* this.emitStreamEnded(active, input);
  }

  private async *runTask(input: AgentStartInput): AsyncGenerator<AgentEvent> {
    if (input.signal.aborted || this.cancelledTaskIds.has(input.taskId)) {
      this.cancelledTaskIds.delete(input.taskId);
      yield { type: "status", status: "cancelled" };
      return;
    }
    yield { type: "status", status: "running" };

    const active: ActiveOpenCodeTask = { cancelRequested: false, subscription: new AbortController() };
    this.activeTasks.set(input.taskId, active);
    const handleSignalAbort = () => {
      void this.requestCancellation(input.taskId);
    };
    input.signal.addEventListener("abort", handleSignalAbort, { once: true });

    try {
      const host = await this.ensureHost();
      const session = await host.sessions.create({
        location: { directory: this.workspaceDir },
        title: `Dex AI ${input.kind}`,
        model: this.model,
      });
      active.sessionID = session.id;

      const events = host.events.subscribe({
        types: SESSION_EVENT_TYPES,
        signal: active.subscription.signal,
      });
      const stream = events[Symbol.asyncIterator]();
      // One pull opens the live stream before the prompt can publish events.
      const established = await stream.next();
      await host.sessions.prompt({ sessionID: session.id, text: input.prompt }, { signal: input.signal });

      yield* this.consumeSessionEvents(stream, input, active, established.done ? undefined : established.value);
    } catch (error) {
      if (this.isCancellationRequested(active, input)) {
        yield { type: "status", status: "cancelled" };
      } else {
        yield { type: "error", message: errorToMessage(error) };
        yield { type: "status", status: "failed" };
      }
    } finally {
      input.signal.removeEventListener("abort", handleSignalAbort);
      this.activeTasks.delete(input.taskId);
      active.subscription.abort();
    }
  }
}
