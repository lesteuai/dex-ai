import { useQuery } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import type { Revision, SessionSummary } from "@dex-ai/shared";
import { queryKeys, type ApiClient } from "../api/client";

const ACTOR_LABELS: Record<Revision["actor"], string> = {
  agent: "Agent",
  user: "You",
};

const listStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: "var(--dex-spacing)",
};

const cardStyle: CSSProperties = {
  border: "1px solid var(--dex-border)",
  borderRadius: "var(--dex-radius)",
  padding: "var(--dex-spacing)",
};

const mutedTextStyle: CSSProperties = {
  color: "var(--dex-text-muted)",
  fontSize: "0.9rem",
};

const errorStyle: CSSProperties = {
  color: "var(--dex-danger)",
  margin: 0,
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toLocaleString();
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function findSession(sessions: SessionSummary[], sessionId: string): SessionSummary | undefined {
  return sessions.find((session) => session.id === sessionId);
}

/** Expandable link that identifies the session a revision came from. */
function SessionLink({ sessionId, session }: { sessionId: string; session: SessionSummary | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const label =
    session === undefined
      ? `Session ${sessionId.slice(0, 8)}`
      : `${session.browserKind} session started ${formatTimestamp(session.startedAt)}`;

  return (
    <span>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? "Hide source session" : label}
      </button>
      {expanded && (
        <span style={{ ...mutedTextStyle, display: "block", marginTop: "4px" }}>
          <code>{sessionId}</code>
          {session === undefined
            ? " (no stored session summary)"
            : ` · ${session.status}${session.postingUrl === null ? "" : ` · ${session.postingUrl}`}`}
        </span>
      )}
    </span>
  );
}

function RevisionRow({ revision, session }: { revision: Revision; session: SessionSummary | undefined }) {
  const before = formatValue(revision.before);
  const after = formatValue(revision.after);

  return (
    <li style={cardStyle}>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "baseline" }}>
        <strong>{revision.entityType}</strong>
        <code>{revision.entityId.slice(0, 8)}</code>
        <span style={mutedTextStyle}>
          changed by {ACTOR_LABELS[revision.actor]} · {formatTimestamp(revision.createdAt)}
        </span>
      </div>
      <p style={{ margin: "8px 0 0" }}>{revision.reason}</p>
      {(before !== "" || after !== "") && (
        <dl style={{ ...mutedTextStyle, margin: "8px 0 0", display: "flex", flexDirection: "column", gap: "4px" }}>
          {before !== "" && (
            <div>
              <dt>Prior value</dt>
              <dd style={{ margin: 0 }}>
                <code>{before}</code>
              </dd>
            </div>
          )}
          {after !== "" && (
            <div>
              <dt>New value</dt>
              <dd style={{ margin: 0 }}>
                <code>{after}</code>
              </dd>
            </div>
          )}
        </dl>
      )}
      <p style={{ margin: "8px 0 0", fontSize: "0.9rem" }}>
        {revision.sourceSessionId === null ? (
          <span style={mutedTextStyle}>No source session, direct edit</span>
        ) : (
          <SessionLink sessionId={revision.sourceSessionId} session={session} />
        )}
        {revision.traceId !== null && (
          <span style={mutedTextStyle}> · trace <code>{revision.traceId.slice(0, 8)}</code></span>
        )}
      </p>
    </li>
  );
}

/**
 * Retrivable revision history: actor, reason, prior and new value, and the
 * source session behind every inference, correction and agent change.
 */
export function RevisionList({ client }: { client: ApiClient }) {
  const revisionsQuery = useQuery({ queryKey: queryKeys.revisions, queryFn: () => client.getRevisions() });
  const sessionsQuery = useQuery({ queryKey: queryKeys.sessions, queryFn: () => client.getSessions() });

  if (revisionsQuery.isLoading) {
    return <p className="panel-placeholder">Loading revision history...</p>;
  }
  if (revisionsQuery.error !== null) {
    return (
      <p role="alert" style={errorStyle}>
        Revision history unavailable: {toErrorMessage(revisionsQuery.error)}
      </p>
    );
  }

  const revisions = revisionsQuery.data?.revisions ?? [];
  if (revisions.length === 0) {
    return (
      <p className="panel-placeholder">
        No revisions yet. Every inference, agent change, correction and rehearsal decision records one here.
      </p>
    );
  }

  const sessions = sessionsQuery.data?.sessions ?? [];
  return (
    <ul style={listStyle}>
      {revisions.map((revision) => (
        <RevisionRow
          key={revision.id}
          revision={revision}
          session={
            revision.sourceSessionId === null ? undefined : findSession(sessions, revision.sourceSessionId)
          }
        />
      ))}
    </ul>
  );
}
