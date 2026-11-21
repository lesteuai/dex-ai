/**
 * Local-first privacy disclosure, required by the control-plane spec:
 * the interface must state where prompts, data, keys and audio travel.
 */
export function PrivacyNotice() {
  return (
    <section className="privacy-notice">
      <h2>What stays local and what is sent</h2>
      <ul>
        <li>
          LLM prompts are sent to the provider selected in your OpenCode config (Claude, Codex or OpenCode Go). The
          provider receives the prompt text; it does not receive your stored data.
        </li>
        <li>
          Profile data, sessions, rules, reasoning traces and revision history persist in the local SQLite database on
          this device and stay there.
        </li>
        <li>Voice audio and transcripts never leave this device and are sent to no provider.</li>
        <li>Dex AI stores no API keys and runs no remote storage service.</li>
      </ul>
    </section>
  );
}
