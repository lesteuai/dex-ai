import { useMemo, useState } from "react";
import { createApiClient, type ApiClient } from "./api/client";
import { PrivacyNotice } from "./components/PrivacyNotice";
import { TOKEN_STORAGE_KEY, TokenGate } from "./components/TokenGate";
import { ProfileEditor } from "./panels/ProfileEditor";
import { RehearsalObserver } from "./panels/RehearsalObserver";
import { SessionTimeline } from "./panels/SessionTimeline";
import { TeachingConsole } from "./panels/TeachingConsole";
import { useDexStream, type StreamStatus } from "./stream/useDexStream";

const PANELS = [
  { id: "profile-rules", label: "Profile & Rules" },
  { id: "session-timeline", label: "Session Timeline" },
  { id: "teaching-console", label: "Teaching Console" },
  { id: "rehearsal-observer", label: "Rehearsal Observer" },
] as const;

type PanelId = (typeof PANELS)[number]["id"];

const STREAM_STATUS_LABELS: Record<StreamStatus, string> = {
  idle: "Offline",
  connecting: "Connecting",
  open: "Live",
  reconnecting: "Reconnecting",
};

function handleSignOut(setToken: (token: string | null) => void) {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  setToken(null);
}

function renderActivePanel(panelId: PanelId, token: string, client: ApiClient) {
  switch (panelId) {
    case "profile-rules":
      return <ProfileEditor token={token} />;
    case "session-timeline":
      return <SessionTimeline client={client} />;
    case "teaching-console":
      return <TeachingConsole client={client} token={token} />;
    case "rehearsal-observer":
      return <RehearsalObserver client={client} />;
  }
}

/** Control-plane shell: token gate, live stream status and the four panel tabs. */
export function App() {
  const [token, setToken] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<PanelId>("profile-rules");
  const streamStatus = useDexStream(token);
  // One client per authenticated token, shared by the client-backed panels.
  const client = useMemo(() => (token === null ? null : createApiClient(token)), [token]);

  if (token === null || client === null) return <TokenGate onAuthenticated={setToken} />;

  return (
    <div className="shell">
      <header className="shell-header">
        <h1>Dex AI Control Plane</h1>
        <div className="shell-header-actions">
          <span className={`stream-status stream-status-${streamStatus}`} data-status={streamStatus}>
            {STREAM_STATUS_LABELS[streamStatus]}
          </span>
          <button type="button" onClick={() => handleSignOut(setToken)}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="panel-tabs" role="tablist" aria-label="Control plane panels">
        {PANELS.map((panel) => (
          <button
            key={panel.id}
            type="button"
            role="tab"
            id={`tab-${panel.id}`}
            aria-selected={panel.id === activePanel}
            aria-controls={`panel-${panel.id}`}
            className={panel.id === activePanel ? "panel-tab panel-tab-active" : "panel-tab"}
            onClick={() => setActivePanel(panel.id)}
          >
            {panel.label}
          </button>
        ))}
      </nav>

      <main className="panel-area">
        <section role="tabpanel" id={`panel-${activePanel}`} aria-labelledby={`tab-${activePanel}`}>
          {renderActivePanel(activePanel, token, client)}
        </section>

        <PrivacyNotice />
      </main>
    </div>
  );
}
