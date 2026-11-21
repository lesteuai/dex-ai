# Plan: Control plane first milestone

Status: approved
Spec: SPEC.md

## Approach

Bootstrap a Bun workspace with a Node 26 control plane, a React web interface, a shared Zod contract package, and one extension source built for Chrome and Firefox. One local process serves the API, WebSocket stream, built web assets, and deterministic job-site fixture. All durable state lives in SQLite under a configurable local data directory.

The control plane exposes thin HTTP handlers that delegate to repositories and services. A local token, loopback and Host checks, origin checks, and a WebSocket subprotocol token protect the process. A narrow `AgentAdapter` separates OpenCode v2 inference and reasoning events from deterministic test behavior. A local speech adapter sends recorded WAV bytes to a Parakeet recognizer in a worker thread and returns text without storing audio or calling a remote recognition service.

The extension source has three layers: content scripts injected into job-site tabs, a background coordinator that owns transport, and a toolbar popup for setup, voice input and rehearsal controls. Both browsers build from these same sources. Observation and rehearsal share one envelope protocol. The extension batches captured events and executes only explicitly approved rehearsal actions. The rehearsal action schema has no submit action, and the extension guard blocks form submission and submit-button activation on forms it manages. Playwright verifies the local fixture in both browser engines, then a public posting smoke test confirms capture and fill behavior without entering the final submission flow.

## Affected Code

- Root workspace, TypeScript project references, ESLint, Vitest and Playwright configuration: establishes build, test and verification commands (AC-1, AC-14, AC-17).
- `packages/shared/src/`: envelope, event types, REST request and response schemas, WebSocket event schemas, rehearsal action schema (AC-2, AC-3, AC-7, AC-10, AC-11, AC-12).
- `apps/control-plane/src/config.ts`: first-run local config, random token, ports, data directory, allowed origins, confidence threshold, Parakeet model path (AC-1, AC-2, AC-8, AC-11).
- `apps/control-plane/src/app.ts`, `src/index.ts`, `src/auth.ts`: Hono routes, loopback binding, token and origin guards, static web and fixture serving, graceful shutdown (AC-1, AC-2).
- `apps/control-plane/src/db/`: Drizzle schema, generated migrations, migration runner, repositories for sessions, events, profile, rules, revisions, traces, rehearsals, teaching drafts and evaluations (AC-3, AC-4, AC-5, AC-6, AC-7, AC-13, AC-15, AC-16).
- `apps/control-plane/src/routes/`: event ingest, profile and rules, sessions, teaching drafts, STT, rehearsals, evaluations and health endpoints (AC-1, AC-3, AC-5, AC-7, AC-8, AC-10, AC-15).
- `apps/control-plane/src/stream/hub.ts`: per-client WebSocket subscription, authorization, typed event fanout and live session updates (AC-2, AC-6, AC-7, AC-9, AC-10).
- `apps/control-plane/src/agent/`: adapter interface, OpenCode v2 adapter, deterministic adapter, prompts and JSON result schemas (AC-4, AC-5, AC-6, AC-9, AC-13).
- `apps/control-plane/src/learning/`: profile inference, correction propagation, revision writing and fixture evaluation (AC-4, AC-5, AC-6, AC-13, AC-14, AC-15).
- `apps/control-plane/src/rehearsal/`: page-snapshot planner, confidence gating, decision handling and submitted-state protection (AC-10, AC-11, AC-12).
- `apps/control-plane/src/stt/`: WAV validation, Parakeet recognizer worker and transcription endpoint adapter (AC-8, AC-16).
- `apps/control-plane/fixtures/job-site/`: local search, posting and application pages with deterministic form fields and a submission recorder used only by tests (AC-10, AC-12, AC-14, AC-15).
- `apps/web/src/main.tsx`, `src/App.tsx`, `src/api/`, `src/stream/`: token gate, REST client, WebSocket client, layout and privacy disclosure (AC-1, AC-2, AC-16, AC-17).
- `apps/web/src/panels/`: profile and rules editor, session timeline, teaching console, rehearsal observer (AC-4, AC-5, AC-6, AC-7, AC-8, AC-10, AC-11, AC-12, AC-17).
- `apps/extension/manifest.config.ts`: one shared manifest definition. The Vite mode and CRXJS browser target generate a Chrome build with a service worker and a Firefox build with a background script, each with its own extension origin (AC-2, AC-3, AC-10).
- `apps/extension/src/content/`: content scripts injected into job-site tabs. They observe DOM and user interactions, report the current posting snapshot, execute approved rehearsal actions in the page, and block form submission and submit-button activation on forms under rehearsal (AC-3, AC-10, AC-11, AC-12).
- `apps/extension/src/background/`: the extension coordinator. It buffers captured events, holds the local token, posts authenticated batches to the control plane, maintains the stream connection, and routes rehearsal decisions to the active tab (AC-2, AC-3, AC-7, AC-10, AC-11).
- `apps/extension/src/popup/`: the toolbar UI. It stores the local token, starts and stops microphone capture, sends WAV audio for local transcription, shows the transcript for confirmation, creates teaching drafts, and starts rehearsals (AC-2, AC-8, AC-10).
- `tests/e2e/`: Playwright projects for Chromium and Firefox, local fixture flows, extension loading and public posting smoke harness (AC-3, AC-8, AC-10, AC-12, AC-13, AC-14, AC-15).

## Data Model and Contracts

SQLite tables generated from `apps/control-plane/src/db/schema.ts`:

- `sessions`: `id`, `browser_kind`, `source`, `posting_url`, `status`, `started_at`, `ended_at`.
- `events`: `id`, `session_id`, `type` (`search_filter`, `posting_opened`, `field_filled`, `reason_stated`), `captured_at`, `source_url`, `payload` JSON, unique `dedupe_key`.
- `profile_entries`: `id`, `section`, `key`, `value` JSON, `confidence`, `status` (`inferred`, `confirmed`, `corrected`), `source_event_ids` JSON, `updated_at`.
- `rules`: `id`, `scope`, `condition` JSON, `action` JSON, `confidence`, `status`, `source_session_id`, `contributing_rule_ids` JSON, `updated_at`.
- `agent_tasks`: `id`, `session_id`, `kind`, `status`, `provider_session_id`, `model`, `started_at`, `finished_at`, `error`.
- `traces`: `id`, `task_id`, `session_id`, `event_id`, `step`, `input` JSON, `reasoning`, `output` JSON, `confidence`, `created_at`.
- `revisions`: `id`, `entity_type`, `entity_id`, `source_session_id`, `trace_id`, `actor` (`agent`, `user`), `before` JSON, `after` JSON, `reason`, `created_at`.
- `teaching_drafts`: `id`, `source`, `transcript`, `status` (`pending`, `confirmed`, `discarded`), `session_id`, `created_at`.
- `rehearsals`: `id`, `session_id`, `posting_url`, `browser_kind`, `status` (`running`, `paused`, `completed`, `failed`), `confidence_threshold`, `current_action_id`, `started_at`.
- `rehearsal_actions`: `id`, `rehearsal_id`, `sequence`, `kind` (`navigate`, `focus`, `fill`, `click_non_submit`, `scroll`, `wait`), `target` JSON, `value`, `confidence`, `status` (`proposed`, `approved`, `executed`, `rejected`, `blocked`), `trace_id`, `created_at`.
- `evaluations`: `id`, `fixture_session_id`, `errors_unchanged`, `errors_corrected`, `errors_new`, `created_at`.

Shared envelope: `{ type, id, ts, payload }`, validated with Zod in `packages/shared`. HTTP clients send `Authorization: Bearer <token>`. Browsers authenticate WebSocket connections with `Sec-WebSocket-Protocol: dex-ai.<token>`, which Hono validates alongside `Origin`.

HTTP routes:

- `GET /api/health`: loopback status and readiness.
- `POST /api/events/batches`: validated event batch with idempotent event IDs.
- `GET /api/sessions`, `GET /api/sessions/:id`: session list and detailed timeline.
- `GET /api/profile`, `PATCH /api/profile/:id`, `GET /api/rules`, `POST /api/rules`, `PATCH /api/rules/:id`: profile and rules editing.
- `GET /api/revisions`: filterable revision history.
- `POST /api/teaching/drafts`, `GET /api/teaching/drafts`, `POST /api/teaching`: voice transcript confirmation and typed or approved teaching.
- `POST /api/stt/transcribe`: 16 kHz mono 16-bit WAV in, `{ text }` out, no audio persistence.
- `POST /api/rehearsals`, `GET /api/rehearsals/:id`, `POST /api/rehearsals/:id/decisions`: start, inspect and approve, correct, reject, pause or resume a rehearsal.
- `POST /api/evaluations/run`: run the held-out fixture and report error counts.
- `GET /fixtures/job/*`, `POST /fixtures/job/applications`: deterministic local job site and submission recorder for tests.

WebSocket `/stream` events: `session.updated`, `trace.started`, `trace.delta`, `trace.completed`, `task.failed`, `profile.updated`, `revision.created`, `rehearsal.proposed`, `rehearsal.paused`, `rehearsal.executed`, `rehearsal.blocked`. All use the shared envelope.

Agent adapter contract:

```ts
type AgentEvent =
  | { type: "status"; status: string }
  | { type: "reasoning"; text: string }
  | { type: "result"; value: unknown }
  | { type: "error"; message: string };

interface AgentAdapter {
  start(input: {
    taskId: string;
    kind: "profile_inference" | "teaching" | "rehearsal_planning" | "correction_propagation";
    sessionId: string;
    prompt: string;
    resultSchema: "profile" | "rules" | "rehearsalPlan" | "correction";
    signal: AbortSignal;
  }): AsyncIterable<AgentEvent>;
  cancel(taskId: string): Promise<void>;
}
```

The OpenCode adapter creates one host with `OpenCode.create({ database: { path: <dataDir>/opencode.db }, log })`, creates sessions under `<dataDir>/workspace`, prompts with task-specific text, filters `opencode.events.subscribe()` by session ID, and validates final JSON against the Zod result schema. The deterministic adapter returns scripted events from fixtures. The correction service parses the rule IDs that produced a decision from `traces.output`, then writes one revision per affected rule through the same repository used by manual edits.

Speech adapter contract:

```ts
interface SpeechTranscriber {
  transcribe(wav: Buffer): Promise<{ text: string }>;
}
```

The Parakeet implementation uses `sherpa-onnx-node` `OfflineRecognizer` with the int8 Parakeet TDT v3 package (`encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt`), `modelType: "nemo_transducer"`, `provider: "cpu"`, `sampleRate: 16000`, `featureDim: 80`. It runs in a worker thread, loads the model lazily, and returns a typed unavailability error when the model files are missing.

## Libraries

- Node.js 26.10.0 and `node:sqlite`: control-plane runtime and synchronous SQLite file access. Drizzle 0.45.4 has no `node-sqlite` driver, so the control plane connects through Drizzle's `sqlite-proxy` driver over raw `node:sqlite` `DatabaseSync`. Migrations use Drizzle's `sqlite-proxy` migrator and prepared `BEGIN`, `COMMIT` and `ROLLBACK` statements for multi-table writes.
- Bun 1.4.2: workspace dependency manager and task runner. The control plane executes under Node to keep `node:sqlite` and OpenCode SDK behavior explicit.
- TypeScript 7.0.2: project references and `tsc --noEmit` gate.
- Hono 4.13.19 with `@hono/node-server` 2.1.11: HTTP routes, middleware and `serve()` with `websocket: { server }`.
- `ws` 8.18.3: `WebSocketServer({ noServer: true })` passed to the Hono Node adapter. Authentication uses `verifyClient` and `Origin` validation.
- Drizzle ORM 0.45.4 and drizzle-kit 0.31.5: typed SQLite schema, generated migrations and repositories.
- Zod 4.6.7: shared envelope, API payloads and agent result validation. Validation errors use `z.flattenError()` for field-specific API responses.
- React 19.3.1 with `createRoot`, `useState` and `useEffect`: four control-plane panels.
- TanStack Query 5.108.2: server state with `useQuery`, `useMutation` and targeted `invalidateQueries()` after WebSocket events.
- Vite 8.3.8 and `@vitejs/plugin-react` 6.3.0: web and extension builds. Vite mode selects the extension browser target.
- CRXJS 3.0.0: Manifest V3 builds for Chrome and Firefox via `crx({ manifest, browser })`, with mode-specific background entry and Firefox `gecko.id`.
- WebExtension Polyfill 0.12.0: Promise-based `browser` API across both extension builds.
- `@opencode/sdk` 2.3.2: in-process OpenCode host, sessions and event subscription. The package is beta, so it stays behind `AgentAdapter` and is pinned.
- `sherpa-onnx-node` 2.0.2: native ONNX Runtime addon for local Parakeet transcription, with prebuilt Linux, macOS and Windows binaries.
- Vitest 5.1.1: unit tests for contracts, repositories, auth, learning services, rehearsal logic, STT validation and extension helpers.
- Playwright 1.65.1: Chromium and Firefox E2E against the local fixture, extension loading and public posting smoke harness.
- ESLint 10.15.0 and `tsx` 4.23.15: lint gate and TypeScript execution for local control-plane startup.

Documentation used for API details: [Hono Node.js and WebSocket](https://hono.dev/docs/getting-started/nodejs), [Drizzle sqlite-proxy](https://orm.drizzle.team/docs/sqlite/connect-drizzle-proxy), [Node sqlite](https://nodejs.org/api/sqlite.html), [Zod error formatting](https://zod.dev/error-formatting), [OpenCode SDK v2](https://opencode.ai/v2/docs/build/sdk), [CRXJS browser support](https://crxjs-chrome-extension-tools-38.mintlify.app/config/browser-support), [WebExtension Polyfill](https://github.com/mozilla/webextension-polyfill), [sherpa-onnx Node addon example](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_asr_non_streaming_nemo_parakeet_tdt_v2.js), [Parakeet TDT model package](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo/parakeet-tdt-0.6b-v3.html), [TanStack Query](https://tanstack.com/query/latest), [Playwright test configuration](https://playwright.dev/docs/test-configuration).

## Risks

- OpenCode v2 is beta and its API can change. Pin 2.3.2, keep all calls inside `OpenCodeAgentAdapter`, and verify the live provider smoke test with the provider already configured on the device.
- The Parakeet TDT v3 int8 package is about 640 MB on disk. Keep the model outside the repository, expose its path through config, load it lazily, and keep the text workflow usable when the model is absent.
- Native `sherpa-onnx-node` binaries depend on platform and Node ABI. Pin 2.0.2, verify on the development platform first, and surface a typed unavailability error instead of crashing the control plane.
- CRXJS Firefox output differs from Chrome for background scripts and MAIN world bridges. Build both targets on every verification pass and run Playwright projects for both engines.
- Browser-side submission blocking cannot cover arbitrary page code that posts directly to an application API. The action schema excludes submit, the guard intercepts managed-form submit paths, the fixture asserts no submission record, and the public smoke test stops before entering the final submission flow.
- LLM inference is nondeterministic. Use the deterministic adapter for unit and fixture tests, then use the live provider only for the planned smoke test and manual inspection of traces.
- Multitable revision writes must be atomic. Drizzle writes run inside explicit `node:sqlite` transactions using prepared `BEGIN`, `COMMIT` and `ROLLBACK` statements.
- Local-only storage does not mean every network request stays local. The interface states that LLM prompts go to the selected provider while SQLite data, voice audio and transcripts remain on the device.

## Verification Approach

- Run `tsc --noEmit`, ESLint, `vite build` for web and both extension targets, and `vitest run` after each implementation wave.
- Drive AC-1, AC-2, AC-3, AC-7, AC-8, AC-10, AC-11, AC-12, AC-13, AC-16 and AC-17 through Playwright against the local fixture in Chromium and Firefox.
- Use deterministic adapter fixtures for AC-4, AC-5, AC-6, AC-13 and AC-14, then run one live OpenCode smoke test for AC-9 with the configured provider.
- Run the fixture evaluation twice for AC-15, once before a correction and once after, and compare the three error counters.
- Complete the public posting smoke test for AC-10 and AC-12 without submitting an application, then inspect the recorded session, traces and revisions in the web interface.
