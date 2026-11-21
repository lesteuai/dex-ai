import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { ProfileEntry, Revision, Rule, SessionSummary } from "@dex-ai/shared";
import { createApiClient, queryKeys } from "../api/client";
import { RevisionList } from "../components/RevisionList";

// The spec's four profile areas split into five stored section keys;
// "preferences and criteria" is two keys. Every known key always renders,
// so an unsupported area reads as empty instead of silently missing.
const PROFILE_SECTIONS = [
  { key: "user_facts", label: "Facts about you" },
  { key: "job_sources", label: "Job-source habits" },
  { key: "preferences", label: "Preferences" },
  { key: "criteria", label: "Criteria" },
  { key: "form_rules", label: "Form-filling rules" },
] as const;

const ACTOR_LABELS: Record<Revision["actor"], string> = {
  agent: "Agent",
  user: "You",
};

const stackStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "calc(var(--dex-spacing) * 2)" };
const rowStyle: CSSProperties = { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "baseline" };
const actionsStyle: CSSProperties = { ...rowStyle, marginTop: "8px" };
const listStyle: CSSProperties = { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "var(--dex-spacing)" };
const cardStyle: CSSProperties = { border: "1px solid var(--dex-border)", borderRadius: "var(--dex-radius)", padding: "var(--dex-spacing)" };
const mutedTextStyle: CSSProperties = { color: "var(--dex-text-muted)", fontSize: "0.9rem" };
const errorStyle: CSSProperties = { color: "var(--dex-danger)", margin: 0 };
const headingStyle: CSSProperties = { margin: 0, fontSize: "1.05rem" };
const fieldStyle: CSSProperties = {
  font: "inherit",
  fontFamily: "var(--dex-font-mono)",
  color: "var(--dex-text)",
  background: "var(--dex-background)",
  border: "1px solid var(--dex-border)",
  borderRadius: "var(--dex-radius)",
  padding: "8px 10px",
};
const editorFormStyle: CSSProperties = { marginTop: "var(--dex-spacing)", display: "flex", flexDirection: "column", gap: "8px", maxWidth: "520px" };

interface EntryCorrectionRequest {
  id: string;
  body: { value?: unknown; status?: ProfileEntry["status"] };
}

interface RuleEditRequest {
  id: string;
  body: { scope?: string; condition?: unknown; action?: unknown; confidence?: number };
}

type RuleDrafts = { scope: string; condition: string; action: string; confidence: string };

const RULE_FIELDS: ReadonlyArray<{ id: keyof RuleDrafts; label: string; multiline: boolean }> = [
  { id: "scope", label: "Scope", multiline: false },
  { id: "condition", label: "Condition (JSON)", multiline: true },
  { id: "action", label: "Action (JSON)", multiline: true },
  { id: "confidence", label: "Confidence (0 to 1)", multiline: false },
];

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function MutationAlert({ error, label }: { error: Error | null; label: string }) {
  if (error === null) return null;
  return (
    <p role="alert" style={errorStyle}>
      {label}: {toErrorMessage(error)}
    </p>
  );
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toLocaleString();
}

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

// Plain text stays a string; structured values edit as JSON.
function parseDraftValue(draft: string): unknown {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function sectionLabel(key: string): string {
  return PROFILE_SECTIONS.find((section) => section.key === key)?.label ?? key;
}

function orderedSectionKeys(entries: ProfileEntry[]): string[] {
  const knownKeys: readonly string[] = PROFILE_SECTIONS.map((section) => section.key);
  const present = new Set(entries.map((entry) => entry.section));
  const unknownKeys = [...present].filter((key) => !knownKeys.includes(key)).sort();
  return [...knownKeys, ...unknownKeys];
}

// The history endpoint returns newest first, so the first row per entity is current.
function buildLatestRevisionMap(revisions: Revision[]): Map<string, Revision> {
  const latest = new Map<string, Revision>();
  for (const revision of revisions) {
    if (!latest.has(revision.entityId)) latest.set(revision.entityId, revision);
  }
  return latest;
}

function sessionOptionLabel(session: SessionSummary): string {
  return `${session.browserKind} session started ${formatTimestamp(session.startedAt)}`;
}

// Close the open editor once the stored record reflects the saved change.
function useCloseOnRecordChange(updatedAt: string, setEditing: (editing: boolean) => void): void {
  const previousRef = useRef<string | null>(null);
  useEffect(() => {
    if (previousRef.current !== null && previousRef.current !== updatedAt) setEditing(false);
    previousRef.current = updatedAt;
  }, [updatedAt, setEditing]);
}

function TraceDetails({ revision }: { revision: Revision | undefined }) {
  const [expanded, setExpanded] = useState(false);

  if (revision === undefined) {
    return <p style={{ ...mutedTextStyle, margin: "8px 0 0" }}>No revision or reasoning trace recorded.</p>;
  }

  return (
    <div style={{ marginTop: "8px" }}>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? "Hide reasoning" : "Show reasoning"}
      </button>
      {expanded && (
        <dl style={{ ...mutedTextStyle, margin: "8px 0 0", display: "flex", flexDirection: "column", gap: "4px" }}>
          <div>
            <dt>Reasoning</dt>
            <dd style={{ margin: 0, color: "var(--dex-text)" }}>{revision.reason}</dd>
          </div>
          <div>
            <dt>Changed by</dt>
            <dd style={{ margin: 0 }}>{ACTOR_LABELS[revision.actor]}</dd>
          </div>
          {revision.traceId !== null && (
            <div>
              <dt>Trace</dt>
              <dd style={{ margin: 0 }}>
                <code>{revision.traceId}</code>
              </dd>
            </div>
          )}
          <div>
            <dt>Source session</dt>
            <dd style={{ margin: 0 }}>
              {revision.sourceSessionId === null ? "None, direct user edit" : <code>{revision.sourceSessionId}</code>}
            </dd>
          </div>
          <div>
            <dt>Recorded</dt>
            <dd style={{ margin: 0 }}>{formatTimestamp(revision.createdAt)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function ProfileEntryRow({
  entry,
  revision,
  saving,
  onSave,
}: {
  entry: ProfileEntry;
  revision: Revision | undefined;
  saving: boolean;
  onSave: (correction: EntryCorrectionRequest) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  useCloseOnRecordChange(entry.updatedAt, setEditing);

  const handleStartEdit = () => {
    setDraft(formatJson(entry.value));
    setEditing(true);
  };

  const handleSaveCorrection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave({ id: entry.id, body: { value: parseDraftValue(draft) } });
  };

  return (
    <li style={cardStyle}>
      <div style={rowStyle}>
        <strong>{entry.key}</strong>
        <code>{formatJson(entry.value)}</code>
        <code>{entry.status}</code>
        <span style={mutedTextStyle}>{formatConfidence(entry.confidence)} confidence</span>
      </div>
      <p style={{ ...mutedTextStyle, margin: "8px 0 0" }}>
        Source events:{" "}
        {entry.sourceEventIds.length === 0
          ? "none recorded"
          : entry.sourceEventIds.map((eventId) => (
              <code key={eventId} style={{ marginRight: "4px" }}>
                {eventId}
              </code>
            ))}
      </p>
      <TraceDetails revision={revision} />
      <div style={actionsStyle}>
        <button type="button" onClick={editing ? () => setEditing(false) : handleStartEdit}>
          {editing ? "Cancel correction" : "Correct value"}
        </button>
        {entry.status !== "confirmed" && (
          <button
            type="button"
            disabled={saving}
            onClick={() => onSave({ id: entry.id, body: { status: "confirmed" } })}
          >
            Mark confirmed
          </button>
        )}
      </div>
      {editing && (
        <form style={editorFormStyle} onSubmit={handleSaveCorrection}>
          <label htmlFor={`entry-value-${entry.id}`}>New value (plain text, or JSON for structured values)</label>
          <textarea
            id={`entry-value-${entry.id}`}
            style={fieldStyle}
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save correction"}
          </button>
        </form>
      )}
    </li>
  );
}

function ProfileSectionView({
  title,
  entries,
  latestRevisions,
  saving,
  onSave,
}: {
  title: string;
  entries: ProfileEntry[];
  latestRevisions: Map<string, Revision>;
  saving: boolean;
  onSave: (correction: EntryCorrectionRequest) => void;
}) {
  return (
    <section>
      <h3 style={{ margin: "0 0 var(--dex-spacing)" }}>{title}</h3>
      {entries.length === 0 ? (
        <p className="panel-placeholder">
          Empty by design. This section stays empty until an observed session or teaching supports
          an entry; values are never invented here.
        </p>
      ) : (
        <ul style={listStyle}>
          {entries.map((entry) => (
            <ProfileEntryRow
              key={entry.id}
              entry={entry}
              revision={latestRevisions.get(entry.id)}
              saving={saving}
              onSave={onSave}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function draftsFromRule(rule: Rule): RuleDrafts {
  return {
    scope: rule.scope,
    condition: formatJson(rule.condition),
    action: formatJson(rule.action),
    confidence: String(rule.confidence),
  };
}

function RuleRow({
  rule,
  revision,
  saving,
  onSave,
}: {
  rule: Rule;
  revision: Revision | undefined;
  saving: boolean;
  onSave: (edit: RuleEditRequest) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<RuleDrafts>(() => draftsFromRule(rule));
  useCloseOnRecordChange(rule.updatedAt, setEditing);

  const handleStartEdit = () => {
    setDrafts(draftsFromRule(rule));
    setEditing(true);
  };

  const handleSave = () => {
    const confidence = Number(drafts.confidence);
    onSave({
      id: rule.id,
      body: {
        scope: drafts.scope.trim().length > 0 ? drafts.scope.trim() : rule.scope,
        condition: parseDraftValue(drafts.condition),
        action: parseDraftValue(drafts.action),
        ...(drafts.confidence.trim().length > 0 && Number.isFinite(confidence)
          ? { confidence: Math.min(1, Math.max(0, confidence)) }
          : {}),
      },
    });
  };

  return (
    <li style={cardStyle}>
      <div style={rowStyle}>
        <strong>{rule.scope}</strong>
        <code>{rule.status}</code>
        <span style={mutedTextStyle}>{formatConfidence(rule.confidence)} confidence</span>
      </div>
      <p style={{ ...mutedTextStyle, margin: "8px 0 0" }}>
        Condition: <code>{formatJson(rule.condition)}</code>
      </p>
      <p style={{ ...mutedTextStyle, margin: "4px 0 0" }}>
        Action: <code>{formatJson(rule.action)}</code>
      </p>
      {rule.sourceSessionId !== null && (
        <p style={{ ...mutedTextStyle, margin: "4px 0 0" }}>
          Source session: <code>{rule.sourceSessionId}</code>
        </p>
      )}
      {revision !== undefined && (
        <p style={{ ...mutedTextStyle, margin: "4px 0 0" }}>
          Last change by {ACTOR_LABELS[revision.actor]}: {revision.reason}
        </p>
      )}
      <div style={actionsStyle}>
        <button type="button" onClick={editing ? () => setEditing(false) : handleStartEdit}>
          {editing ? "Cancel edit" : "Edit rule"}
        </button>
      </div>
      {editing && (
        <div style={editorFormStyle}>
          {RULE_FIELDS.map((field) => {
            const inputId = `rule-${field.id}-${rule.id}`;
            const shared = {
              id: inputId,
              style: fieldStyle,
              value: drafts[field.id],
              onChange: (event: { target: { value: string } }) =>
                setDrafts({ ...drafts, [field.id]: event.target.value }),
            };
            return (
              <Fragment key={field.id}>
                <label htmlFor={inputId}>{field.label}</label>
                {field.multiline ? (
                  <textarea {...shared} rows={3} />
                ) : (
                  <input
                    {...shared}
                    type="text"
                    inputMode={field.id === "confidence" ? "decimal" : undefined}
                  />
                )}
              </Fragment>
            );
          })}
          <button type="button" disabled={saving} onClick={handleSave}>
            {saving ? "Saving..." : "Save rule"}
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Profile and rules editor panel. Renders every profile section with source
 * links and empty states, inline corrections for entries and rules, reasoning
 * traces for inferred values, and the shared revision history.
 */
export function ProfileEditor({ token }: { token: string }) {
  const client = useMemo(() => createApiClient(token), [token]);
  const queryClient = useQueryClient();
  const [inferenceSessionId, setInferenceSessionId] = useState("");

  const profileQuery = useQuery({ queryKey: queryKeys.profile, queryFn: () => client.getProfile() });
  const rulesQuery = useQuery({ queryKey: queryKeys.rules, queryFn: () => client.getRules() });
  const revisionsQuery = useQuery({ queryKey: queryKeys.revisions, queryFn: () => client.getRevisions() });
  const sessionsQuery = useQuery({ queryKey: queryKeys.sessions, queryFn: () => client.getSessions() });

  // Local invalidation gives immediate feedback when the stream is down;
  // stream events refresh the same keys afterwards.
  const correctEntry = useMutation({
    mutationFn: (correction: EntryCorrectionRequest) =>
      client.patch<{ entry: ProfileEntry }>(`/profile/${correction.id}`, correction.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.profile });
      void queryClient.invalidateQueries({ queryKey: queryKeys.revisions });
    },
  });

  const editRule = useMutation({
    mutationFn: (edit: RuleEditRequest) => client.patch<{ rule: Rule }>(`/rules/${edit.id}`, edit.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.rules });
      void queryClient.invalidateQueries({ queryKey: queryKeys.revisions });
    },
  });

  const runInference = useMutation({
    mutationFn: (sessionId: string) =>
      client.post<{ entries: ProfileEntry[] }>("/profile/inference", { sessionId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.profile });
      void queryClient.invalidateQueries({ queryKey: queryKeys.revisions });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });

  const entries = profileQuery.data?.entries ?? [];
  const rules = rulesQuery.data?.rules ?? [];
  const latestRevisions = useMemo(
    () => buildLatestRevisionMap(revisionsQuery.data?.revisions ?? []),
    [revisionsQuery.data],
  );
  const sessionsNewestFirst = useMemo(
    () =>
      [...(sessionsQuery.data?.sessions ?? [])].sort((first, second) =>
        second.startedAt.localeCompare(first.startedAt),
      ),
    [sessionsQuery.data],
  );

  return (
    <div style={stackStyle}>
      <MutationAlert error={correctEntry.error} label="Profile correction failed" />
      <MutationAlert error={editRule.error} label="Rule edit failed" />
      <MutationAlert error={runInference.error} label="Profile inference failed" />

      <section aria-label="Inferred profile">
        <h2 style={headingStyle}>Profile</h2>
        <div style={{ ...rowStyle, alignItems: "center", margin: "var(--dex-spacing) 0" }}>
          <label htmlFor="inference-session">Infer from session</label>
          <select
            id="inference-session"
            style={fieldStyle}
            value={inferenceSessionId}
            onChange={(event) => setInferenceSessionId(event.target.value)}
          >
            <option value="">Select an observed session</option>
            {sessionsNewestFirst.map((session) => (
              <option key={session.id} value={session.id}>
                {sessionOptionLabel(session)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={runInference.isPending || inferenceSessionId === ""}
            onClick={() => runInference.mutate(inferenceSessionId)}
          >
            {runInference.isPending ? "Inferring..." : "Run profile inference"}
          </button>
          {runInference.data !== undefined && (
            <span style={mutedTextStyle}>Inference stored {runInference.data.entries.length} entries.</span>
          )}
        </div>
        {profileQuery.isLoading && <p className="panel-placeholder">Loading profile...</p>}
        <MutationAlert error={profileQuery.error} label="Profile unavailable" />
        {profileQuery.isSuccess && (
          <div style={stackStyle}>
            {entries.length === 0 && (
              <p className="panel-placeholder">
                No profile entries yet. Pick an observed session above and run profile inference.
              </p>
            )}
            {orderedSectionKeys(entries).map((sectionKey) => (
              <ProfileSectionView
                key={sectionKey}
                title={sectionLabel(sectionKey)}
                entries={entries.filter((entry) => entry.section === sectionKey)}
                latestRevisions={latestRevisions}
                saving={correctEntry.isPending}
                onSave={(correction) => correctEntry.mutate(correction)}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-label="Form-filling rules">
        <h2 style={headingStyle}>Rules</h2>
        {rulesQuery.isLoading && <p className="panel-placeholder">Loading rules...</p>}
        <MutationAlert error={rulesQuery.error} label="Rules unavailable" />
        {rulesQuery.isSuccess && rules.length === 0 && (
          <p className="panel-placeholder">
            No rules yet. Teaching and rehearsal corrections create and update rules.
          </p>
        )}
        {rulesQuery.isSuccess && rules.length > 0 && (
          <ul style={listStyle}>
            {rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                revision={latestRevisions.get(rule.id)}
                saving={editRule.isPending}
                onSave={(edit) => editRule.mutate(edit)}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Revision history">
        <h2 style={headingStyle}>Revision history</h2>
        <RevisionList client={client} />
      </section>
    </div>
  );
}
