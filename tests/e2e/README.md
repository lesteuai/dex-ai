# E2E tests

Playwright suites against the local control plane. The web suites in `web/` drive the React interface; the extension suites in `extension/` load the development builds into real Chromium and Firefox and drive the local job-site fixture through the extension.

## Commands

```bash
bun run e2e:web        # web interface suites, Chromium and Firefox
bun run e2e:extension  # extension suites, Chrome and Firefox development builds
bun run e2e            # both
```

Prerequisites: `bun install`, Node 26.10, and `bunx playwright install chromium firefox`. The extension suites rebuild `apps/extension/dist/<browser>` before every run.

## Extension suites

`bun run e2e:extension` runs five serial tests per browser (`chrome.spec.ts`, `firefox.spec.ts`). Each spec self-skips under the other browser's project, so a full run executes ten tests.

1. **Setup and capture (AC-3).** The harness builds the development extension, loads it through a persistent Playwright context, writes a throwaway config under `/tmp/opencode`, starts the control plane on `127.0.0.1:8787` with the deterministic agent adapter, saves the config token through the extension, then drives the local fixture: a search with filters, a posting opened. The suite asserts `search_filter`, `field_filled` and `posting_opened` events with their payloads appear in the session timeline of the control plane, captured by the real content script and posted by the real background coordinator.
2. **Teaching (AC-8).** The suite sends one second of silence to `POST /api/stt/transcribe`. When the local Parakeet model is configured, the returned transcript is confirmed into a `voice` teaching draft through the popup's transcript form. When the model is unavailable the endpoint answers `503 stt_unavailable`, and the suite records the documented typed fallback: a `text` draft is created and the pending draft is asserted through `GET /api/teaching/drafts`. Microphone capture itself cannot be driven headlessly; the popup shows the same unavailability message on a failed recording.
3. **Evaluation baseline (AC-15).** `POST /api/evaluations/run` before any correction. The deterministic planner matches `expected-session.json`, so both runs report zero decision errors and all three counters (`errorsUnchanged`, `errorsCorrected`, `errorsNew`) are asserted present. The counter semantics against a divergent plan are covered by the control-plane unit tests with scripted adapters.
4. **Supervised rehearsal (AC-10, AC-12).** The rehearsal starts for the observed posting (through the popup in Chrome). The confident navigate action auto-approves and the extension executes it in the tab. The first fill falls below the configured threshold (0.92) and the rehearsal pauses before execution. A submit-shaped correction is recorded as blocked, and user approval afterwards is refused with `409 submit_blocked`. Correcting back to the declared expected fill resumes the rehearsal. The suite then clicks the real submit button on the armed form: the extension guard blocks it, the block is reported to the control plane, and the fill executes through the WebSocket stream. The remaining fill is approved, executed, and the rehearsal completes.
5. **Session history and post-correction evaluation (AC-14, AC-15).** The session timeline contains the blocked actions, the executed actions match the declared expected navigation and field values, the second evaluation run reports no new and no unchanged errors, and the fixture submission recorder (`submissions.json`) is still empty.

A file lock at `/tmp/opencode/dex-ai-extension-e2e.lock` serializes suites over the shared port 8787; a stale lock older than four minutes is removed automatically. A leaked control plane on 8787 from another session fails the run with `EADDRINUSE`; kill the stale process before rerunning.

### Firefox loading details

- The add-on is installed through Firefox's remote debugging protocol (`installTemporaryAddon`), the same path web-ext uses, over `-start-debugger-server`.
- `extension-preferences.json` in the profile pre-grants the MV3 content-script host permissions, which Firefox migrates into its permission store at startup, so no about:addons prompt blocks injection.
- Playwright cannot automate `moz-extension://` pages (its Firefox build refuses to attach to them). The suite therefore stores the token through the extension's real storage API and reloads the add-on, which reruns the background startup and connects the stream, and starts rehearsals and teaching drafts through the same control-plane routes the popup and the rehearsal observer panel call. Chrome keeps the full popup UI path.
- Firefox injects `upgrade-insecure-requests` into the default extension CSP, which would force the dev build's `ws://127.0.0.1:8787/stream` connection to `wss://` and break it. The manifest declares `content_security_policy.extension_pages` as `script-src 'self'; object-src 'self'` for the Firefox build, which excludes the upgrade directive while keeping scripts restricted to `'self'`. `apps/extension/src/manifest.test.ts` asserts the policy.

## Public posting smoke

Deterministic acceptance uses the local fixture; the public posting is selected by the user at verification time. The smoke is operator driven and stops before the final submission flow:

```bash
cd apps/control-plane
node --import tsx ../../tests/e2e/extension/public-posting.smoke.ts <posting-url> [chrome|firefox]
```

The command loads the development extension, opens the posting in a visible browser, waits while the operator interacts, then prints the captured events, the result line below, and cleans up:

```
Smoke result: capture verified and the run stopped before final submission; no application was submitted.
```

Verified run (21 November 2026, Chromium build, posting URL pointing at the local fixture as a stand-in): the extension captured `posting_opened`, no rehearsal was started, no submit control was activated, and no application was submitted. Repeating it against a real public posting follows the same procedure and prints the same result line, which is the record that AC-10 and AC-12 are satisfied without submitting an application.

Headless environments need `xvfb-run -a` for the visible browser window.
