import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  AutonomyAssessment,
  RehearsalAction,
  RehearsalActionRecord,
  RehearsalDecisionRequest,
  RehearsalRecord,
  SessionSummary,
  SessionTimelineItem,
} from "@dex-ai/shared";
import { ApiError, queryKeys, type ApiClient } from "../api/client";

type RehearsalView = { rehearsal: RehearsalRecord; actions: RehearsalActionRecord[] };

const REHEARSAL_STATUS_LABELS: Record<RehearsalRecord["status"], string> = {
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
};

const ACTION_STATUS_LABELS: Record<RehearsalActionRecord["status"], string> = {
  proposed: "proposed",
  approved: "approved",
  executed: "executed",
  rejected: "rejected",
  blocked: "blocked",
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function describeAction(action: RehearsalAction): string {
  switch (action.kind) {
    case "navigate":
      return `navigate to ${action.url}`;
    case "focus":
      return `focus ${action.selector}`;
    case "fill":
      return `fill ${action.selector} with "${action.value}"`;
    case "click_non_submit":
      return `click ${action.selector}`;
    case "scroll":
      return action.selector === undefined
        ? `scroll by ${action.deltaY}px`
        : `scroll ${action.selector} by ${action.deltaY}px`;
    case "wait":
      return `wait ${action.durationMs}ms`;
  }
}

/** The most recent session whose extension reported a posting url. */
function firstPostingSession(sessions: SessionSummary[]): SessionSummary | null {
  return sessions.find((session) => session.postingUrl !== null) ?? null;
}

function sessionOptionLabel(session: SessionSummary): string {
  return `${session.browserKind} session ${session.id.slice(0, 8)} (${session.postingUrl ?? "no posting"})`;
}

/** The planning trace holds the reasoning behind every proposed action. */
function reasoningByTraceId(timeline: SessionTimelineItem[]): Map<string, string> {
  const reasoning = new Map<string, string>();
  for (const item of timeline) {
    if (item.kind === "trace" && item.trace.reasoning !== null) {
      reasoning.set(item.trace.id, item.trace.reasoning);
    }
  }
  return reasoning;
}

function isBelowThreshold(action: RehearsalActionRecord, threshold: number): boolean {
  return action.confidence < threshold;
}

type CorrectionField = { name: string; label: string; numeric: boolean };

function correctionFields(action: RehearsalAction): CorrectionField[] {
  switch (action.kind) {
    case "navigate":
      return [{ name: "url", label: "url", numeric: false }];
    case "focus":
    case "click_non_submit":
      return [{ name: "selector", label: "selector", numeric: false }];
    case "fill":
      return [
        { name: "selector", label: "selector", numeric: false },
        { name: "value", label: "value", numeric: false },
      ];
    case "scroll":
      return [
        { name: "selector", label: "selector (optional)", numeric: false },
        { name: "deltaY", label: "deltaY", numeric: true },
      ];
    case "wait":
      return [{ name: "durationMs", label: "durationMs", numeric: true }];
  }
}

function initialCorrectionDraft(action: RehearsalAction): Record<string, string> {
  switch (action.kind) {
    case "navigate":
      return { url: action.url };
    case "focus":
    case "click_non_submit":
      return { selector: action.selector };
    case "fill":
      return { selector: action.selector, value: action.value };
    case "scroll":
      return { selector: action.selector ?? "", deltaY: String(action.deltaY) };
    case "wait":
      return { durationMs: String(action.durationMs) };
  }
}

/** A correction keeps the proposed kind and replaces its target fields. */
function buildCorrectedAction(action: RehearsalAction, draft: Record<string, string>): RehearsalAction | string {
  const url = (draft.url ?? "").trim();
  const selector = (draft.selector ?? "").trim();
  switch (action.kind) {
    case "navigate":
      if (url === "") return "The corrected url is required";
      return { kind: "navigate", url };
    case "focus":
    case "click_non_submit":
      if (selector === "") return "The corrected selector is required";
      return { kind: action.kind, selector };
    case "fill":
      if (selector === "") return "The corrected selector is required";
      return { kind: "fill", selector, value: draft.value ?? "" };
    case "scroll": {
      const deltaYText = (draft.deltaY ?? "").trim();
      const deltaY = Number(deltaYText);
      if (deltaYText === "" || !Number.isInteger(deltaY)) return "The corrected deltaY must be an integer";
      return { kind: "scroll", ...(selector === "" ? {} : { selector }), deltaY };
    }
    case "wait": {
      const durationMsText = (draft.durationMs ?? "").trim();
      const durationMs = Number(durationMsText);
      if (durationMsText === "" || !Number.isInteger(durationMs) || durationMs <= 0) {
        return "The corrected durationMs must be a positive integer";
      }
      return { kind: "wait", durationMs };
    }
  }
}

function CorrectionForm({
  action,
  disabled,
  onCorrect,
}: {
  action: RehearsalActionRecord;
  disabled: boolean;
  onCorrect: (corrected: RehearsalAction) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() => initialCorrectionDraft(action.action));
  const [error, setError] = useState<string | null>(null);

  function handleApplyCorrection(): void {
    const corrected = buildCorrectedAction(action.action, draft);
    if (typeof corrected === "string") {
      setError(corrected);
      return;
    }
    setError(null);
    onCorrect(corrected);
  }

  return (
    <div className="rehearsal-correction">
      {correctionFields(action.action).map((field) => (
        <label key={field.name}>
          {field.label}
          <input
            type={field.numeric ? "number" : "text"}
            value={draft[field.name] ?? ""}
            onChange={(event) =>
              setDraft((current) => ({ ...current, [field.name]: event.target.value }))
            }
          />
        </label>
      ))}
      {error !== null && <p className="rehearsal-error">{error}</p>}
      <button type="button" disabled={disabled} onClick={handleApplyCorrection}>
        Apply correction
      </button>
    </div>
  );
}

function BlockedAttempts({ actions }: { actions: RehearsalActionRecord[] }) {
  return (
    <div role="alert" className="rehearsal-blocked">
      <h4>Blocked submission attempts</h4>
      <ul>
        {actions.map((action) => (
          <li key={action.id}>Blocked submission attempt: {describeAction(action.action)}</li>
        ))}
      </ul>
      <p>
        Every attempt was blocked before execution and recorded in the session history. A blocked
        attempt stays blocked even after approval.
      </p>
    </div>
  );
}

function ActionList({
  rehearsal,
  actions,
  reasoning,
  deciding,
  onDecide,
}: {
  rehearsal: RehearsalRecord;
  actions: RehearsalActionRecord[];
  reasoning: Map<string, string>;
  deciding: boolean;
  onDecide: (decision: RehearsalDecisionRequest) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <ol className="rehearsal-actions">
      {actions.map((action) => {
        const isCurrent = action.id === rehearsal.currentActionId;
        const decidable = isCurrent && (action.status === "proposed" || action.status === "blocked");
        const actionReasoning = action.traceId === null ? null : reasoning.get(action.traceId) ?? null;
        return (
          <li key={action.id} className="rehearsal-action">
            <div className="rehearsal-action-head">
              <span>
                #{action.sequence} {describeAction(action.action)}
              </span>
              <span className={`rehearsal-action-status rehearsal-action-status-${action.status}`}>
                {ACTION_STATUS_LABELS[action.status]}
                {isCurrent ? " (current)" : ""}
              </span>
            </div>
            <div className="rehearsal-action-meta">
              <span>confidence {action.confidence.toFixed(2)}</span>
              {isBelowThreshold(action, rehearsal.confidenceThreshold) && (
                <span className="rehearsal-below-threshold">below the threshold</span>
              )}
            </div>
            {actionReasoning !== null && <p className="rehearsal-reasoning">Reasoning: {actionReasoning}</p>}
            {decidable && (
              <div className="rehearsal-decisions">
                <button
                  type="button"
                  disabled={deciding}
                  onClick={() => onDecide({ type: "approve", actionId: action.id })}
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={deciding}
                  onClick={() => onDecide({ type: "reject", actionId: action.id })}
                >
                  Reject
                </button>
                <CorrectionForm
                  action={action}
                  disabled={deciding}
                  onCorrect={(corrected) =>
                    onDecide({ type: "correct", actionId: action.id, action: corrected })
                  }
                />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function RehearsalDetail({
  client,
  rehearsal,
  actions,
}: {
  client: ApiClient;
  rehearsal: RehearsalRecord;
  actions: RehearsalActionRecord[];
}) {
  const queryClient = useQueryClient();
  const timelineQuery = useQuery({
    queryKey: queryKeys.session(rehearsal.sessionId),
    queryFn: () => client.getSession(rehearsal.sessionId),
  });
  // Mirror the stream: rehearsal decisions also refresh the session history.
  const decideMutation = useMutation({
    mutationFn: (decision: RehearsalDecisionRequest) =>
      client.post<{ rehearsal: RehearsalRecord }>(`/rehearsals/${rehearsal.id}/decisions`, decision),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.rehearsals }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
      ]);
    },
  });

  const current = actions.find((action) => action.id === rehearsal.currentActionId) ?? null;
  const lowConfidencePause =
    rehearsal.status === "paused" &&
    current !== null &&
    current.status === "proposed" &&
    isBelowThreshold(current, rehearsal.confidenceThreshold);
  const blocked = actions.filter((action) => action.status === "blocked");
  const reasoning =
    timelineQuery.data === undefined ? new Map<string, string>() : reasoningByTraceId(timelineQuery.data.timeline);

  function handlePause(): void {
    decideMutation.mutate({ type: "pause" });
  }

  function handleResume(): void {
    decideMutation.mutate({ type: "resume" });
  }

  return (
    <section className="rehearsal-active" aria-label="Active rehearsal">
      <h3>{REHEARSAL_STATUS_LABELS[rehearsal.status]} rehearsal</h3>
      <p className="rehearsal-summary">
        {rehearsal.browserKind} rehearsal of {rehearsal.postingUrl ?? "the session posting"},
        confidence threshold {rehearsal.confidenceThreshold.toFixed(2)}.
      </p>
      {rehearsal.status === "paused" && (
        <p role="status" className="rehearsal-paused-note">
          The rehearsal is paused, including after a disconnect. Nothing executes until you
          explicitly resume it.
        </p>
      )}
      {lowConfidencePause && (
        <p role="status" className="rehearsal-low-confidence">
          Low confidence paused this action before execution. Approve, correct or reject it.
        </p>
      )}
      <div className="rehearsal-controls">
        {rehearsal.status === "running" && (
          <button type="button" disabled={decideMutation.isPending} onClick={handlePause}>
            Pause
          </button>
        )}
        {rehearsal.status === "paused" && (
          <button type="button" disabled={decideMutation.isPending} onClick={handleResume}>
            Resume
          </button>
        )}
      </div>
      {decideMutation.error !== null && (
        <p className="rehearsal-error">
          {errorMessage(decideMutation.error, "The rehearsal decision failed")}
        </p>
      )}
      {blocked.length > 0 && <BlockedAttempts actions={blocked} />}
      <ActionList
        rehearsal={rehearsal}
        actions={actions}
        reasoning={reasoning}
        deciding={decideMutation.isPending}
        onDecide={(decision) => decideMutation.mutate(decision)}
      />
      {rehearsal.status === "completed" && (
        <p className="rehearsal-completed-note">
          The rehearsal completed. No application was submitted.
        </p>
      )}
    </section>
  );
}

function ActiveRehearsal({ client, rehearsalId }: { client: ApiClient; rehearsalId: string }) {
  const rehearsalQuery = useQuery({
    queryKey: queryKeys.rehearsal(rehearsalId),
    queryFn: () => client.get<RehearsalView>(`/rehearsals/${rehearsalId}`),
  });

  if (rehearsalQuery.isPending) {
    return <p className="panel-placeholder">Loading the rehearsal...</p>;
  }
  if (rehearsalQuery.isError) {
    return (
      <p className="rehearsal-error">
        {errorMessage(rehearsalQuery.error, "Loading the rehearsal failed")}
      </p>
    );
  }
  return (
    <RehearsalDetail
      client={client}
      rehearsal={rehearsalQuery.data.rehearsal}
      actions={rehearsalQuery.data.actions}
    />
  );
}

function autonomyText(autonomy: AutonomyAssessment): string {
  const prefix = autonomy.autonomous ? "Auto mode active." : "Auto mode asks first.";
  return `${prefix} ${autonomy.reason}`;
}

type StartInput = { sessionId: string; postingUrl: string; confidenceThreshold?: number; autoMode: boolean };

function StartRehearsalForm({
  sessions,
  sessionId,
  postingUrl,
  threshold,
  autoMode,
  startError,
  starting,
  onSessionChange,
  onPostingUrlChange,
  onThresholdChange,
  onAutoModeChange,
  onStart,
}: {
  sessions: SessionSummary[];
  sessionId: string;
  postingUrl: string;
  threshold: string;
  autoMode: boolean;
  startError: string | null;
  starting: boolean;
  onSessionChange: (sessionId: string) => void;
  onPostingUrlChange: (postingUrl: string) => void;
  onThresholdChange: (threshold: string) => void;
  onAutoModeChange: (autoMode: boolean) => void;
  onStart: () => void;
}) {
  if (sessions.length === 0) {
    return (
      <p className="panel-placeholder">
        No sessions yet. Open a posting in the development extension first.
      </p>
    );
  }
  return (
    <section className="rehearsal-start" aria-label="Start a rehearsal">
      <h3>Start a rehearsal</h3>
      <label>
        Session
        <select value={sessionId} onChange={(event) => onSessionChange(event.target.value)}>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {sessionOptionLabel(session)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Posting url
        <input type="text" value={postingUrl} onChange={(event) => onPostingUrlChange(event.target.value)} />
      </label>
      <label>
        Confidence threshold (optional)
        <input
          type="number"
          min="0"
          max="1"
          step="0.05"
          value={threshold}
          onChange={(event) => onThresholdChange(event.target.value)}
        />
      </label>
      <label className="rehearsal-auto-mode">
        <input
          type="checkbox"
          checked={autoMode}
          onChange={(event) => onAutoModeChange(event.target.checked)}
        />
        Auto mode: skip confidence pauses once this platform and role type are familiar. Submission
        stays blocked.
      </label>
      <button type="button" disabled={starting || sessionId === ""} onClick={onStart}>
        Start rehearsal
      </button>
      {startError !== null && <p className="rehearsal-error">{startError}</p>}
      <p className="panel-placeholder">
        The threshold defaults to the configured value when left empty. The posting url can point at
        the local fixture or a public posting you selected.
      </p>
    </section>
  );
}

/**
 * Supervised rehearsal observer. Starts a rehearsal for the posting of an
 * observed session, shows every proposed action with confidence and
 * reasoning, and maps each control to a supported rehearsal decision. There
 * is deliberately no control that submits the application.
 */
export function RehearsalObserver({ client }: { client: ApiClient }) {
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions,
    queryFn: () => client.getSessions(),
  });
  const [sessionId, setSessionId] = useState("");
  const [postingUrl, setPostingUrl] = useState("");
  const [threshold, setThreshold] = useState("");
  const [autoMode, setAutoMode] = useState(false);
  const [autonomyNote, setAutonomyNote] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [activeRehearsalId, setActiveRehearsalId] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId !== "" || sessionsQuery.data === undefined) return;
    const sessions = sessionsQuery.data.sessions;
    const session = firstPostingSession(sessions) ?? sessions[0];
    if (session === undefined) return;
    setSessionId(session.id);
    setPostingUrl(session.postingUrl ?? "");
  }, [sessionId, sessionsQuery.data]);

  function handleSessionChange(nextSessionId: string): void {
    setSessionId(nextSessionId);
    const session =
      sessionsQuery.data?.sessions.find((candidate) => candidate.id === nextSessionId) ?? null;
    setPostingUrl(session?.postingUrl ?? "");
  }

  const startMutation = useMutation({
    mutationFn: (input: StartInput) =>
      client.post<{ rehearsal: RehearsalRecord; autonomy?: AutonomyAssessment }>("/rehearsals", {
        sessionId: input.sessionId,
        ...(input.autoMode ? { mode: "auto" } : {}),
        ...(input.postingUrl.trim() === "" ? {} : { postingUrl: input.postingUrl.trim() }),
        ...(input.confidenceThreshold === undefined ? {} : { confidenceThreshold: input.confidenceThreshold }),
      }),
    onSuccess: async (data) => {
      setStartError(null);
      setAutonomyNote(data.autonomy === undefined ? null : autonomyText(data.autonomy));
      setActiveRehearsalId(data.rehearsal.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.rehearsals });
    },
    onError: (error) => setStartError(errorMessage(error, "Starting the rehearsal failed")),
  });

  function handleStart(): void {
    const thresholdText = threshold.trim();
    if (thresholdText !== "") {
      const value = Number(thresholdText);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        setStartError("The confidence threshold must be a number between 0 and 1");
        return;
      }
      startMutation.mutate({ sessionId, postingUrl, confidenceThreshold: value, autoMode });
      return;
    }
    startMutation.mutate({ sessionId, postingUrl, autoMode });
  }

  const sessions = sessionsQuery.data?.sessions ?? [];

  return (
    <div className="rehearsal-observer">
      {sessionsQuery.isError && (
        <p className="rehearsal-error">
          {errorMessage(sessionsQuery.error, "Loading sessions failed")}
        </p>
      )}
      <StartRehearsalForm
        sessions={sessions}
        sessionId={sessionId}
        postingUrl={postingUrl}
        threshold={threshold}
        autoMode={autoMode}
        startError={startError}
        starting={startMutation.isPending}
        onSessionChange={handleSessionChange}
        onPostingUrlChange={setPostingUrl}
        onThresholdChange={setThreshold}
        onAutoModeChange={setAutoMode}
        onStart={handleStart}
      />
      {autonomyNote !== null && (
        <p className="rehearsal-autonomy" role="status">
          {autonomyNote}
        </p>
      )}
      {activeRehearsalId !== null && (
        <ActiveRehearsal client={client} rehearsalId={activeRehearsalId} />
      )}
    </div>
  );
}
