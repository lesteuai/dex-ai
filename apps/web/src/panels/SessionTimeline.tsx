import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type {
  ObservedEventEnvelope,
  RehearsalAction,
  RehearsalActionRecord,
  Revision,
  SessionSummary,
  SessionTimelineItem,
  Trace,
} from "@dex-ai/shared";
import { type ApiClient, queryKeys } from "../api/client";

export type SessionTimelineProps = {
  client: ApiClient;
};

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

function formatConfidence(confidence: number | null): string {
  return confidence === null ? "" : ` ${Math.round(confidence * 100)}%`;
}

function formatJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function timelineTimestamp(item: SessionTimelineItem): string {
  switch (item.kind) {
    case "event":
      return item.event.ts;
    case "trace":
      return item.trace.createdAt;
    case "revision":
      return item.revision.createdAt;
    case "rehearsal_action":
      return item.action.createdAt;
  }
}

function timelineItemKey(item: SessionTimelineItem): string {
  switch (item.kind) {
    case "event":
      return `event-${item.event.id}`;
    case "trace":
      return `trace-${item.trace.id}`;
    case "revision":
      return `revision-${item.revision.id}`;
    case "rehearsal_action":
      return `action-${item.action.id}`;
  }
}

function describeEvent(event: ObservedEventEnvelope): string {
  switch (event.type) {
    case "search_filter": {
      const query = event.payload.query ? `"${event.payload.query}"` : "";
      const filters = Object.entries(event.payload.filters)
        .map(([name, value]) => `${name}=${value}`)
        .join(", ");
      return `Search ${query}${filters}`.trim();
    }
    case "posting_opened":
      return event.payload.title ? `Opened posting "${event.payload.title}"` : "Opened posting";
    case "field_filled":
      return `Filled ${event.payload.label ?? event.payload.selector} with "${event.payload.value}"`;
    case "reason_stated":
      return `Reason by ${event.payload.input}: ${event.payload.text}`;
  }
}

function describeRehearsalAction(action: RehearsalAction): string {
  switch (action.kind) {
    case "navigate":
      return `Navigate to ${action.url}`;
    case "focus":
      return `Focus ${action.selector}`;
    case "fill":
      return `Fill ${action.selector} with "${action.value}"`;
    case "click_non_submit":
      return `Click ${action.selector}`;
    case "scroll":
      return `Scroll ${action.deltaY}`;
    case "wait":
      return `Wait ${action.durationMs}ms`;
  }
}

function EventEntry({ event }: { event: ObservedEventEnvelope }) {
  return (
    <article className="timeline-entry">
      <p className="timeline-entry-summary">
        <strong>Event</strong> · {formatTimestamp(event.ts)}
      </p>
      <p>{describeEvent(event)}</p>
    </article>
  );
}

function TraceEntry({
  trace,
  expanded,
  onToggle,
}: {
  trace: Trace;
  expanded: boolean;
  onToggle: () => void;
}) {
  const input = formatJson(trace.input);
  const output = formatJson(trace.output);

  return (
    <article className="timeline-entry timeline-entry-trace">
      <button
        type="button"
        className="trace-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <strong>Trace</strong> step {trace.step} ·{formatConfidence(trace.confidence)} ·{" "}
        {formatTimestamp(trace.createdAt)} · {expanded ? "Hide" : "Show"} detail
      </button>
      {expanded ? (
        <div className="trace-detail">
          {trace.reasoning === null ? (
            <p className="timeline-entry-muted">No reasoning recorded.</p>
          ) : (
            <p>{trace.reasoning}</p>
          )}
          {input === "" ? null : (
            <details>
              <summary>Input</summary>
              <pre>
                <code>{input}</code>
              </pre>
            </details>
          )}
          {output === "" ? null : (
            <details>
              <summary>Output</summary>
              <pre>
                <code>{output}</code>
              </pre>
            </details>
          )}
        </div>
      ) : null}
    </article>
  );
}

function RevisionEntry({ revision }: { revision: Revision }) {
  const actorLabel = revision.actor === "user" ? "Correction" : "Agent change";
  return (
    <article className="timeline-entry">
      <p className="timeline-entry-summary">
        <strong>{actorLabel}</strong> on {revision.entityType} · {formatTimestamp(revision.createdAt)}
      </p>
      <p>{revision.reason}</p>
    </article>
  );
}

function RehearsalActionEntry({ action }: { action: RehearsalActionRecord }) {
  return (
    <article className="timeline-entry">
      <p className="timeline-entry-summary">
        <strong>Rehearsal</strong> · {formatTimestamp(action.createdAt)}
      </p>
      <p>
        {describeRehearsalAction(action.action)} ({action.status},{formatConfidence(action.confidence)})
      </p>
    </article>
  );
}

function TimelineEntry({
  item,
  expandedTraceIds,
  onToggleTrace,
}: {
  item: SessionTimelineItem;
  expandedTraceIds: ReadonlySet<string>;
  onToggleTrace: (traceId: string) => void;
}) {
  switch (item.kind) {
    case "event":
      return <EventEntry event={item.event} />;
    case "trace":
      return (
        <TraceEntry
          trace={item.trace}
          expanded={expandedTraceIds.has(item.trace.id)}
          onToggle={() => onToggleTrace(item.trace.id)}
        />
      );
    case "revision":
      return <RevisionEntry revision={item.revision} />;
    case "rehearsal_action":
      return <RehearsalActionEntry action={item.action} />;
  }
}

/**
 * Timeline of one selected session. Rendered only while its session still
 * exists in the list, so the key-based remount resets expansion state.
 */
function SessionTimelineDetail({ client, session }: { client: ApiClient; session: SessionSummary }) {
  const [expandedTraceIds, setExpandedTraceIds] = useState<ReadonlySet<string>>(new Set());
  const timelineQuery = useQuery({
    queryKey: queryKeys.session(session.id),
    queryFn: () => client.getSession(session.id),
  });

  function handleToggleTrace(traceId: string) {
    setExpandedTraceIds((previous) => {
      const next = new Set(previous);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });
  }

  const timeline = [...(timelineQuery.data?.timeline ?? [])].sort((a, b) =>
    timelineTimestamp(a).localeCompare(timelineTimestamp(b)),
  );

  return (
    <section className="session-timeline-detail" aria-label={`Timeline for session started ${formatTimestamp(session.startedAt)}`}>
      <header>
        <h3>
          {session.browserKind} session ·{" "}
          {session.status === "active" ? "live now" : `ended ${session.endedAt === null ? "" : formatTimestamp(session.endedAt)}`}
        </h3>
        <p className="timeline-entry-muted">Started {formatTimestamp(session.startedAt)}</p>
      </header>

      {timelineQuery.isPending ? (
        <p className="timeline-entry-muted">Loading timeline.</p>
      ) : timelineQuery.isError ? (
        <p className="timeline-error">Could not load the timeline: {timelineQuery.error.message}</p>
      ) : timeline.length === 0 ? (
        <p className="timeline-entry-muted">No events, traces, corrections or rehearsal actions yet.</p>
      ) : (
        <ol className="timeline-list">
          {timeline.map((item) => (
            <li key={timelineItemKey(item)}>
              <TimelineEntry
                item={item}
                expandedTraceIds={expandedTraceIds}
                onToggleTrace={handleToggleTrace}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Session timeline panel: lists stored sessions and shows the selected one chronologically. */
export function SessionTimeline({ client }: SessionTimelineProps) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions,
    queryFn: () => client.getSessions(),
  });

  function handleSelectSession(sessionId: string) {
    setSelectedSessionId(sessionId);
  }

  const sessions = sessionsQuery.data?.sessions ?? [];
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;

  return (
    <section className="session-timeline" aria-label="Session timeline">
      <h2>Sessions</h2>

      {sessionsQuery.isPending ? (
        <p className="timeline-entry-muted">Loading sessions.</p>
      ) : sessionsQuery.isError ? (
        <p className="timeline-error">Could not load sessions: {sessionsQuery.error.message}</p>
      ) : sessions.length === 0 ? (
        <p className="timeline-entry-muted">No sessions captured yet. Browse a job site with the extension to record one.</p>
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className="session-list-item"
                aria-current={session.id === selectedSessionId}
                onClick={() => handleSelectSession(session.id)}
              >
                {session.browserKind} · {session.status} · {formatTimestamp(session.startedAt)}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selectedSession === null ? (
        <p className="panel-placeholder">
          Select a session to see its events, reasoning traces, corrections and rehearsal actions in
          chronological order. Live sessions update as new activity streams in.
        </p>
      ) : (
        <SessionTimelineDetail key={selectedSession.id} client={client} session={selectedSession} />
      )}
    </section>
  );
}
