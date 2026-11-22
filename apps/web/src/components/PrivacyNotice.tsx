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
          LLM prompts are sent to the provider selected in your OpenCode config (Claude, Codex or OpenCode Go). A
          prompt carries the data its task needs: observed events with the values you typed, profile entries, rules,
          confirmed teaching text and page snapshots.
        </li>
        <li>
          Profile data, sessions, rules, reasoning traces and revision history persist in the local SQLite database on
          this device and stay there.
        </li>
        <li>
          Voice audio never leaves this device and is transcribed here. A transcript reaches the provider only after
          you confirm it as teaching.
        </li>
        <li>Dex AI stores no API keys and runs no remote storage service.</li>
      </ul>
    </section>
  );
}
