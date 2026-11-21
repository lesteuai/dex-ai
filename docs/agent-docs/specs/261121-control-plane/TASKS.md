# Tasks: Control plane first milestone

Status: in progress

## Wave 1

- [x] T1: Bootstrap workspace and verification gates (commit f657445)
  - Satisfies: AC-1, AC-14, AC-17
  - Files: `package.json`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.gitignore`
  - Do: Create Bun workspaces for `apps/*` and `packages/*`. Add root scripts for `dev`, `build`, `typecheck`, `lint`, `test` and `e2e`. Configure TypeScript project references, Node 26 engine, ESLint flat config and Vitest discovery across apps and packages. Keep product code out of this task.
  - Tests: none, this task creates configuration only.
  - Done when: `bun install`, `bun run typecheck`, `bun run lint` and `bun run test` all exit zero with an empty test suite.

- [x] T2: Define shared envelope and Zod contracts (commit 7ee2b25)
  - Satisfies: AC-2, AC-3, AC-7, AC-10, AC-11, AC-12
  - Files: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/envelope.ts`, `packages/shared/src/events.ts`, `packages/shared/src/api.ts`, `packages/shared/src/ws.ts`, `packages/shared/src/rehearsal.ts`
  - Do: Define `{ type, id, ts, payload }` envelope, four observed event payloads, REST request and response schemas, WebSocket event union, and rehearsal action schema. The rehearsal action union contains `navigate`, `focus`, `fill`, `click_non_submit`, `scroll` and `wait`, with no submit action. Export inferred TypeScript types.
  - Tests: Envelope round trip, malformed event batch rejection with field errors, WebSocket union narrowing, rehearsal schema rejecting `submit` and `requestSubmit`.
  - Done when: Shared package typechecks and its unit tests pass without importing any app code.

- [x] T3: Create first-run config and local auth guards (commit 7e3ee0b)
  - Satisfies: AC-1, AC-2, AC-8, AC-11
  - Files: `apps/control-plane/package.json`, `apps/control-plane/src/config.ts`, `apps/control-plane/src/auth.ts`
  - Do: Generate `~/.config/dex-ai/config.json` on first run with random token, `127.0.0.1` host, port, data directory, allowed Chrome and Firefox extension origins, local UI origin, low-confidence threshold and Parakeet model path. Write with mode `0600` and support `DEX_AI_HOME` overrides. Implement middleware helpers for loopback remote address, Host allowlist, bearer token, extension Origin allowlist, and WebSocket token subprotocol validation.
  - Tests: Config creation and reload from a temporary home, file mode, token validation, disallowed origin rejection, missing token rejection, duplicate config generation preserving token, threshold parsing.
  - Done when: Config and auth unit tests pass with a temporary data directory and no network listener.

- [x] T4: Build deterministic local job-site fixture (commit ca5100b)
  - Satisfies: AC-10, AC-12, AC-14, AC-15
  - Files: `apps/control-plane/fixtures/job-site/index.html`, `apps/control-plane/fixtures/job-site/search.html`, `apps/control-plane/fixtures/job-site/posting.html`, `apps/control-plane/fixtures/job-site/apply.html`, `apps/control-plane/fixtures/job-site/styles.css`, `apps/control-plane/fixtures/job-site/submissions.json`, `apps/control-plane/fixtures/job-site/fixture.test.ts`
  - Do: Create search filters, posting list, posting detail and application form with stable `data-testid` attributes for expected fields. Provide a submit control and a local submission recorder file that the test route can update. Keep the fixture self-contained and deterministic.
  - Tests: Parse fixture HTML and assert required selectors, field names, posting link and submit control exist. Assert initial submission recorder is empty.
  - Done when: Fixture tests pass and all four pages render without scripts or remote assets.

## Wave 2

- [x] T5: Define SQLite schema, migrations and database client (commit 7b3eb79)
  - Satisfies: AC-3, AC-4, AC-5, AC-6, AC-7, AC-13, AC-15, AC-16
  - Files: `apps/control-plane/src/db/schema.ts`, `apps/control-plane/src/db/client.ts`, `apps/control-plane/src/db/migrate.ts`, `apps/control-plane/drizzle.config.ts`, `apps/control-plane/drizzle/0000_init.sql`
  - Do: Define all tables from the plan with Drizzle SQLite columns, JSON text modes, unique dedupe key, foreign keys and indexes. Create the node:sqlite client with WAL and foreign keys enabled. Generate the initial migration and apply it idempotently with Drizzle's node-sqlite migrator. Add a transaction helper using prepared `BEGIN`, `COMMIT` and `ROLLBACK` statements.
  - Tests: Fresh migration, repeat migration, insert and read session and event, unique dedupe constraint, transaction rollback, file recreation after close.
  - Done when: Database tests pass against a temporary SQLite file and generated migration is committed.

- [x] T6: Build Hono app shell, static serving and stream hub (commit a8a396c)
  - Satisfies: AC-1, AC-2, AC-6, AC-7, AC-9, AC-10
  - Files: `apps/control-plane/src/app.ts`, `apps/control-plane/src/index.ts`, `apps/control-plane/src/stream/hub.ts`, `apps/control-plane/src/routes/health.ts`, `apps/control-plane/src/routes/static.ts`
  - Do: Wire Hono with config and auth guards, mount `/api/health`, serve the built web directory and local fixture, create `WebSocketServer({ noServer: true })` and pass it to `serve()` with the `websocket` option, bind explicitly to `127.0.0.1`, publish envelope events through the hub, and close server, stream and agent host on SIGINT and SIGTERM. Apply CORS only to HTTP API routes so WebSocket upgrades keep mutable headers.
  - Tests: Health route success, unauthorized API rejection, disallowed origin rejection, WebSocket token subprotocol authentication, event fanout to authorized subscribers, bind address assertion.
  - Done when: App shell tests pass with a real loopback server and one real WebSocket client; no listener is created on a non-loopback address.

## Wave 3

- [x] T7: Implement event ingest and session timeline API (commit 280da7a)
  - Satisfies: AC-3, AC-7, AC-16
  - Files: `apps/control-plane/src/repositories/events.ts`, `apps/control-plane/src/repositories/sessions.ts`, `apps/control-plane/src/repositories/traces.ts`, `apps/control-plane/src/repositories/revisions.ts`, `apps/control-plane/src/services/session-timeline.ts`, `apps/control-plane/src/routes/events.ts`, `apps/control-plane/src/routes/sessions.ts`
  - Do: Accept validated event batches, deduplicate by `dedupe_key`, upsert sessions, return field-specific validation errors, and assemble a chronological timeline from events, traces, revisions and rehearsal actions. Publish `session.updated` when a batch lands.
  - Tests: Valid batch storage, duplicate event IDs ignored, malformed envelope rejected without partial writes, chronological ordering from out-of-order timestamps, persistence after reopening the database, timeline includes trace and revision entries.
  - Done when: Ingest and timeline tests pass and events from either browser kind are stored without browser-specific branching.

- [x] T8: Implement local Parakeet speech transcription (commit d06f59f)
  - Satisfies: AC-8, AC-16
  - Files: `apps/control-plane/src/stt/wav.ts`, `apps/control-plane/src/stt/transcriber.ts`, `apps/control-plane/src/stt/parakeet-transcriber.ts`, `apps/control-plane/src/stt/worker.ts`, `apps/control-plane/src/routes/stt.ts`
  - Do: Validate 16 kHz mono 16-bit WAV requests with a size limit. Run `sherpa-onnx-node` `OfflineRecognizer` in a worker thread using the configured Parakeet TDT v3 int8 encoder, decoder, joiner and tokens, with `modelType: nemo_transducer` and CPU provider. Load lazily, return a typed unavailable error when model files are missing, return only `{ text }`, and persist no audio.
  - Tests: Valid WAV accepted, invalid header and sample rate rejected, oversized body rejected, unavailable model returns typed error, route returns transcript from a fake transcriber, no database write occurs.
  - Done when: STT unit tests pass; a real sample transcription runs if the configured model is present and is reported as skipped with reason otherwise.

- [x] T9: Define agent adapter and deterministic implementation (commit dd0fbbc)
  - Satisfies: AC-4, AC-5, AC-6, AC-9, AC-13
  - Files: `apps/control-plane/src/agent/adapter.ts`, `apps/control-plane/src/agent/deterministic-adapter.ts`, `apps/control-plane/src/agent/results.ts`, `apps/control-plane/src/agent/prompts.ts`
  - Do: Implement the adapter interface, four prompt builders, Zod result schemas for profile, rules, rehearsal plan and correction, and a deterministic adapter driven by local fixtures. Normalize status, reasoning, result and error events. Honor `AbortSignal` cancellation.
  - Tests: Each task kind emits a valid result, reasoning events appear before result, invalid fixture result fails schema validation, cancellation stops further emissions.
  - Done when: Agent contract tests pass without importing OpenCode or any network client.

## Wave 4

- [x] T10: Implement OpenCode SDK v2 agent adapter (commit 4c2dcc0)
  - Satisfies: AC-4, AC-6, AC-9
  - Files: `apps/control-plane/src/agent/opencode-adapter.ts`, `apps/control-plane/src/agent/factory.ts`
  - Do: Create one `OpenCode.create()` host with a persistent database path and structured logging. Create sessions under the data directory workspace, prompt with task-specific text, filter `opencode.events.subscribe()` by session ID, normalize events into the shared adapter contract, validate final JSON with the result schemas, support cancellation through request signals, and close the host explicitly. Select the deterministic adapter when the runtime asks for it.
  - Tests: Mock `@opencode/sdk` with `vi.mock`; assert host database path, session creation, event filtering, reasoning normalization, final JSON validation, cancellation and host close.
  - Done when: OpenCode adapter tests pass with the SDK mocked; live provider verification is reserved for Phase 5.

- [x] T11: Implement profile inference, rules and revision API (commit 1b25718)
  - Satisfies: AC-4, AC-5, AC-6, AC-7
  - Files: `apps/control-plane/src/repositories/profile.ts`, `apps/control-plane/src/repositories/rules.ts`, `apps/control-plane/src/repositories/revisions.ts`, `apps/control-plane/src/services/profile-inference.ts`, `apps/control-plane/src/routes/profile.ts`, `apps/control-plane/src/routes/rules.ts`, `apps/control-plane/src/routes/revisions.ts`
  - Do: Infer four-section profile entries from stored events with the agent adapter. Link entries to source event IDs and traces. Leave unsupported sections empty. Expose endpoints to inspect and correct entries, create and edit rules, and query revision history with source session and trace details. Write all changes atomically in one transaction.
  - Tests: Deterministic inference populates all four sections, insufficient evidence leaves sections empty, correction persists and creates a revision, revision query returns actor and source session, concurrent writes roll back cleanly.
  - Done when: Profile, rules and revision tests pass and web clients can fetch all required data through these routes.

- [x] T12: Implement teaching drafts and teaching API (commit 77e6395)
  - Satisfies: AC-8, AC-9
  - Files: `apps/control-plane/src/repositories/teaching.ts`, `apps/control-plane/src/services/teaching.ts`, `apps/control-plane/src/routes/teaching.ts`
  - Do: Create voice transcript drafts from the extension, list pending drafts, confirm or edit a transcript into a `reason_stated` event and teaching task, discard drafts, and accept typed teaching directly. Preserve drafts when the agent task fails and publish trace updates through the stream hub.
  - Tests: Draft lifecycle, confirmation creates event and trace, typed teaching bypasses draft, invalid transcript rejected, agent failure preserves pending draft.
  - Done when: Teaching tests pass and a confirmed voice draft appears in the session timeline.

## Wave 5

- [x] T13: Implement rehearsal planner and control API (commit fc4d069)
  - Satisfies: AC-10, AC-11, AC-12
  - Files: `apps/control-plane/src/repositories/rehearsals.ts`, `apps/control-plane/src/services/rehearsal-planner.ts`, `apps/control-plane/src/services/rehearsal-controller.ts`, `apps/control-plane/src/routes/rehearsals.ts`
  - Do: Accept a page snapshot from the extension, plan only allowed actions with confidence, pause when confidence is below config threshold, handle approve, correct, reject, pause and resume decisions, mark rehearsal paused on extension disconnect, require explicit resume before more actions, and record blocked submission attempts. Never create a submit action.
  - Tests: Confident action continues, low-confidence action pauses, correction changes proposed action, disconnect prevents further execution, blocked submit attempt recorded, submit action cannot be created through routes or schemas.
  - Done when: Rehearsal tests pass and the planner output contains no submit action type.

- [x] T14: Build web shell, API client and stream client (commit ca13f70)
  - Satisfies: AC-1, AC-2, AC-16, AC-17
  - Files: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles.css`, `apps/web/src/api/client.ts`, `apps/web/src/stream/useDexStream.ts`, `apps/web/src/components/TokenGate.tsx`, `apps/web/src/components/PrivacyNotice.tsx`
  - Do: Build a React 19 app with TanStack Query, token entry, REST client with bearer token, native WebSocket client using the token subprotocol, tab layout for the four panels, CSS variables, and privacy notice stating that prompts go to the selected provider while SQLite data and voice audio stay local. Rebuild query cache on relevant stream events.
  - Tests: Token gate validation, API client sends bearer token and handles errors, stream client sets subprotocol and reconnects in paused state, privacy notice contains required disclosures.
  - Done when: Web shell unit tests pass and `vite build` emits assets for control-plane static serving.

- [x] T15: Build Chrome and Firefox extension manifests and background coordinator (commit 66fc6b9)
  - Satisfies: AC-2, AC-3, AC-7, AC-10
  - Files: `apps/extension/package.json`, `apps/extension/vite.config.ts`, `apps/extension/manifest.config.ts`, `apps/extension/src/background/index.ts`, `apps/extension/src/shared/api-client.ts`, `apps/extension/src/shared/auth.ts`, `apps/extension/src/shared/messages.ts`
  - Do: Use one manifest definition and CRXJS `browser` mode to produce Chrome service-worker and Firefox background-script builds with pinned extension origins. In the coordinator, store the token, buffer event batches, post authenticated batches, open the stream, route rehearsal decisions to the active tab, and mark the control plane session paused on disconnect.
  - Tests: Both manifest outputs, token persistence, batch retry and dedupe behavior, WebSocket reconnect, active-tab message routing, no cross-origin request without token.
  - Done when: Both extension builds succeed and coordinator unit tests pass.

- [x] T16: Implement correction propagation and fixture evaluation (commit f70f84f)
  - Satisfies: AC-13, AC-14, AC-15
  - Files: `apps/control-plane/src/services/correction-propagation.ts`, `apps/control-plane/src/services/evaluation.ts`, `apps/control-plane/src/routes/evaluations.ts`, `apps/control-plane/fixtures/job-site/expected-session.json`
  - Do: Read contributing rule IDs from trace output, write a linked revision for each affected rule, make updated rules part of future prompts, and run a repeatable held-out fixture evaluation that reports `errors_unchanged`, `errors_corrected` and `errors_new`. Define expected navigation and field values in the fixture file.
  - Tests: Correction updates every contributing rule, corrected decision does not recur, unaffected rules are not changed, baseline and post-correction counters differ as expected, revision history remains complete.
  - Done when: Correction and evaluation tests pass and the evaluation endpoint returns three counters.

## Wave 6

- [x] T17: Build profile and rules editor panel (commit 5115257)
  - Satisfies: AC-4, AC-5, AC-6, AC-17
  - Files: `apps/web/src/panels/ProfileEditor.tsx`, `apps/web/src/components/RevisionList.tsx`
  - Do: Render four profile sections with source links and empty states, inline edit entries and rules, show trace details for inferred values, and show revision history with source session and actor.
  - Tests: Render fixture profile, edit mutation payload, empty section display, trace expansion, revision source session link.
  - Done when: Panel tests pass and the panel works against the profile and rules routes.

- [x] T18: Build session timeline panel (commit 87c8947)
  - Satisfies: AC-7, AC-17
  - Files: `apps/web/src/panels/SessionTimeline.tsx`
  - Do: List sessions, show selected session events, traces, corrections and rehearsal actions in chronological order, and refresh from WebSocket `session.updated` and `trace.completed` events.
  - Tests: Chronological ordering, live event insertion, trace detail expansion, empty session state.
  - Done when: Timeline tests pass and live updates appear without a full page reload.

- [x] T19: Build teaching console panel (commit 12c2b83)
  - Satisfies: AC-8, AC-9, AC-17
  - Files: `apps/web/src/panels/TeachingConsole.tsx`
  - Do: Provide typed teaching input, pending voice drafts with editable transcript confirmation and discard, agent status, reasoning trace display, and a clear message when browser or local speech capture is unavailable.
  - Tests: Typed submit payload, voice draft confirm and discard, transcript editing before confirmation, fallback message, failure state preserving draft.
  - Done when: Teaching panel tests pass and voice drafts become teaching events only after confirmation.

- [x] T20: Build rehearsal observer panel (commit e933419)
  - Satisfies: AC-10, AC-11, AC-12, AC-17
  - Files: `apps/web/src/panels/RehearsalObserver.tsx`
  - Do: Start a rehearsal for the current posting, display proposed actions with confidence and reasoning, provide approve, correct, reject, pause and resume controls, show blocked submission attempts, and require explicit resume after disconnect.
  - Tests: Low-confidence pause UI, correction payload, reject action, resume requirement, blocked submission banner, no submit control in the action list.
  - Done when: Rehearsal panel tests pass and every action control maps to a supported route decision.

## Wave 7

- [ ] T21: Build content observer and submit guard
  - Satisfies: AC-3, AC-10, AC-12
  - Files: `apps/extension/src/content/index.ts`, `apps/extension/src/content/observer.ts`, `apps/extension/src/content/snapshot.ts`, `apps/extension/src/content/rehearsal-executor.ts`, `apps/extension/src/content/submit-guard.ts`
  - Do: Capture searches and filters, postings opened and field fills from real tabs and the local fixture. Build posting snapshots for the planner. Execute only approved rehearsal actions. Block form submit events, submit-button activation and direct submit calls on forms under rehearsal, and report blocked attempts to the background coordinator.
  - Tests: Fixture DOM event detection, snapshot shape, approved fill execution, submit click blocked, form submit event blocked, no submit command accepted from stream messages.
  - Done when: Content script tests pass in a DOM test environment and the submit guard records blocked attempts.

- [x] T22: Build extension popup and local voice capture (commit 3072666)
  - Satisfies: AC-2, AC-8, AC-10
  - Files: `apps/extension/src/popup/index.html`, `apps/extension/src/popup/main.tsx`, `apps/extension/src/popup/styles.css`, `apps/extension/src/shared/audio.ts`, `apps/extension/src/shared/recorder.ts`
  - Do: Provide token setup, microphone permission handling, Web Audio capture resampled to 16 kHz mono 16-bit WAV, authenticated STT request, transcript confirmation, teaching draft creation, and start rehearsal for the current tab. Keep typed teaching available when speech is unavailable.
  - Tests: PCM to WAV encoding, 48 kHz to 16 kHz resampling, permission denied fallback, STT request payload, teaching draft payload, start rehearsal message.
  - Done when: Popup unit tests pass in both extension builds and no audio is sent to a remote recognition service.

## Wave 8

- [ ] T23: Build web Playwright suites
  - Satisfies: AC-1, AC-2, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-11, AC-13, AC-16, AC-17
  - Files: `tests/e2e/playwright.config.ts`, `tests/e2e/web/control-plane.spec.ts`, `tests/e2e/web/fixture.spec.ts`
  - Do: Configure Chromium and Firefox projects with a temporary `DEX_AI_HOME` and deterministic agent adapter. Exercise startup, token rejection, profile correction, revision trace inspection, timeline live updates, typed teaching, voice draft confirmation, rehearsal pause and correction, restart persistence and privacy disclosure. Assert the fixture never records a submission.
  - Tests: none, this task creates the E2E harness.
  - Done when: `bun run e2e:web` passes in both browser projects.

- [ ] T24: Build extension Playwright suites and smoke harness
  - Satisfies: AC-3, AC-8, AC-10, AC-12, AC-14, AC-15
  - Files: `tests/e2e/extension/chrome.spec.ts`, `tests/e2e/extension/firefox.spec.ts`, `tests/e2e/extension/public-posting.smoke.ts`, `tests/e2e/README.md`
  - Do: Load the Chrome and Firefox development builds, capture local fixture events, run a supervised rehearsal with a low-confidence pause, confirm a voice transcript through the local model when available, assert no submission recorder entry, run the evaluation endpoint before and after a correction, and document the public posting smoke that stops before final submission.
  - Tests: none, this task creates the E2E harness.
  - Done when: `bun run e2e:extension` passes for Chrome and Firefox; public posting smoke result is documented with no submitted application.

## Coverage

- AC-1: T1, T3, T6, T14, T23
- AC-2: T2, T3, T6, T14, T15, T22, T23
- AC-3: T2, T5, T7, T15, T21, T24
- AC-4: T5, T9, T10, T11, T17, T23
- AC-5: T5, T9, T11, T17, T23
- AC-6: T5, T6, T9, T10, T11, T17, T23
- AC-7: T2, T5, T6, T7, T11, T18, T23
- AC-8: T3, T8, T12, T14, T19, T22, T23, T24
- AC-9: T9, T10, T12, T19, T23
- AC-10: T2, T5, T6, T13, T15, T20, T21, T22, T24
- AC-11: T2, T3, T13, T20, T23
- AC-12: T2, T4, T13, T20, T21, T24
- AC-13: T5, T9, T11, T16, T23
- AC-14: T4, T16, T24
- AC-15: T4, T5, T16, T24
- AC-16: T5, T7, T8, T14, T23
- AC-17: T1, T14, T17, T18, T19, T20, T23
