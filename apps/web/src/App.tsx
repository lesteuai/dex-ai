import { useState } from "react";
import { PrivacyNotice } from "./components/PrivacyNotice";
import { TOKEN_STORAGE_KEY, TokenGate } from "./components/TokenGate";
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

/** Control-plane shell: token gate, live stream status and the four panel tabs. */
export function App() {
  const [token, setToken] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<PanelId>("profile-rules");
  const streamStatus = useDexStream(token);

  if (token === null) return <TokenGate onAuthenticated={setToken} />;

  const activePanelLabel = PANELS.find((panel) => panel.id === activePanel)?.label ?? "";

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
          <p className="panel-placeholder">
            The {activePanelLabel} panel is not implemented yet; it arrives in the next milestone wave.
          </p>
        </section>

        <PrivacyNotice />
      </main>
    </div>
  );
}
