# Deferred verification: control plane first milestone

Two checks are deferred by user decision on 21 November 2026:

1. AC-9 live OpenCode-provider smoke.
2. AC-10 and AC-12 public posting smoke.

Everything else passed lint, typecheck, unit tests, build, web E2E, and extension E2E on 21 November 2026. AC-9 failed only because the configured free OpenCode model hit its usage limit; the control plane preserved state and recorded the provider error as designed.

## AC-9 live OpenCode-provider smoke

**PASSED on 21 November 2026.** Result recorded below.

Goal: prove the real `@opencode/sdk` path completes one profile-inference task with a configured provider that has available quota.

Steps:

1. Confirm OpenCode has a usable provider and model:
   ```bash
   opencode auth list
   opencode models
   ```
2. Pick a model with available quota, or top up the current provider.
3. Start the control plane with `agentKind: "opencode"` in the config file:
   ```bash
   DEX_AI_HOME=/tmp/opencode/ac9-smoke bun run --filter '@dex-ai/control-plane' dev
   ```
4. Open `http://127.0.0.1:8787`, enter the token from `/tmp/opencode/ac9-smoke/config.json`, and use the Profile & Rules panel to run inference on an observed session.
5. Confirm the request completes with:
   - a 200 response,
   - profile entries in the supported sections,
   - a reasoning trace linked to the source session,
   - a revision entry with actor `agent`.

Equivalent direct API check:

```bash
curl -sS -X POST http://127.0.0.1:8787/api/profile/inference \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<observed-session-id>"}'
```

Record the result here once it passes.

Result (21 November 2026, provider `opencode-go/deepseek-v4.1-flash`, live config `agentKind: "opencode"`):

- The first live attempts exposed a prompt gap: `buildProfileInferencePrompt` never showed the top-level `{ "sections": [...] }` wrapper, so the model answered with bare section objects and five separate JSON objects; the Zod gate rejected each answer and recorded failed tasks with the provider error, exactly as designed. Fix: `apps/control-plane/src/agent/prompts.ts` now spells out the full five-section skeleton.
- After the fix, `POST /api/profile/inference` on session `faa9ae9f-17bc-4f71-ad80-a16bbbfba49e` (one `posting_opened` event on `ycombinator.com/launches`) answered `200` and stored 5 cited entries: `user_facts.browses_yc_launch_pages` (0.4), `job_sources.y_combinator_launches` (0.55), `preferences.interest_in_ai_agent_startups` (0.35), `preferences.interest_in_yc_backed_companies` (0.3), `criteria.company_type` (0.3).
- Every entry cites the source event, a reasoning trace is linked to the session, and 5 revisions with actor `agent` record the change.
- A second run on session `88e9e0bd-a929-411a-a28d-06b3ab6675f1` (only local UI selector toggles) correctly stored 0 entries rather than inventing any.

## AC-10 and AC-12 public posting smoke

Goal: prove the extension observes a real public posting and the run stops before any submission.

Steps:

1. Choose a public posting URL.
2. Run the operator-driven smoke:
   ```bash
   cd apps/control-plane
   node --import tsx ../../tests/e2e/extension/public-posting.smoke.ts <posting-url> [chrome|firefox]
   ```
3. Interact with the posting in the visible browser window.
4. Press Enter in the terminal when done.
5. Confirm the terminal prints:
   ```text
   Smoke result: capture verified and the run stopped before final submission; no application was submitted.
   ```

On a headless machine, wrap the command with `xvfb-run -a`.

Record the posting URL, browser, date, and result line here once it passes.
