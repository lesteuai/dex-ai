# Tech Stack

Proposed 2026-11-21 from [the solution architecture graph](research/261120-dex-ai-vision/architecture.html). The control plane first milestone is implemented; the versions below are the pinned ones from the workspace manifests. See [control-plane.md](control-plane.md) for how to run it.

## Principles

- TypeScript everywhere: extension, server, web UI, and the shared protocol.
- Local only: bind to `127.0.0.1`, keep the SQLite file on disk, call no remote service of our own. LLM inference goes to the user's subscribed provider by design; stored data does not.
- No agent framework. The interpreter that executes the learning spec is fixed code; the agent changes the rules, playbooks, policy, and spec that the interpreter reads.
- Small packages with one responsibility each.

## Repository layout

Bun 1.4.2 workspaces with TypeScript project references. Bun installs dependencies and runs tasks; the control plane itself executes under Node 26.10 (`tsx watch src/index.ts`), so `node:sqlite` and the OpenCode SDK run on the pinned runtime.

```
apps/control-plane   Node server, SQLite, LLM adapters, learning interpreter
apps/web             React UI, built into control-plane static assets
apps/extension       Manifest V3 browser extension
packages/shared      Zod schemas, message envelope, shared types
```

## Mapping from the graph

| Graph node | Choice | Reason |
| --- | --- | --- |
| Browser extension (client) | TypeScript, Manifest V3, Vite 8.3.8, `@crxjs/vite-plugin` 3.0.0, `webextension-polyfill` 0.12.0 | CRXJS gives HMR in content scripts and the service worker and generates manifest entries. One manifest builds for both browsers: `--mode chrome` emits an MV3 service worker, `--mode firefox` emits MV3 background event-page scripts (`apps/extension/manifest.config.ts`). Firefox injects `upgrade-insecure-requests` into the default MV3 CSP, which would upgrade the loopback `ws://127.0.0.1:8787/stream` connection to `wss://` and break it; the Firefox build declares `content_security_policy.extension_pages` as `script-src 'self'; object-src 'self'`, which excludes the upgrade directive while keeping scripts restricted to `'self'`. |
| Control plane (server) | Node 26.10.0 (pinned `~26.10.0`), TypeScript, Hono 4.13.19 with `@hono/node-server` 2.1.11 and `ws` 8.18.3 | One small process serves REST and WebSocket. Hono's Node WebSocket path uses `upgradeWebSocket` from `@hono/node-server` with a `WebSocketServer({ noServer: true })`; `@hono/node-ws` is deprecated. Bind `127.0.0.1` only. |
| Memory (SQLite) | `node:sqlite` built in, Drizzle ORM 0.45.4 through the `sqlite-proxy` driver, drizzle-kit 0.31.5 | No native addon, no `node-gyp`, no prebuilt binary roulette on Node upgrades. The module is synchronous and the database is a local file. Drizzle 0.45.4 does not ship a `node-sqlite` driver, so the control plane uses its `sqlite-proxy` driver over raw `node:sqlite` `DatabaseSync` (`apps/control-plane/src/db/client.ts`). |
| LLM agent tasks | Thin `AgentAdapter` interface implemented by `@opencode/sdk` 2.3.2 alone | `OpenCode.create()` hosts OpenCode in process and streams events through `opencode.events.subscribe()`. One adapter serves all three subscriptions through the user's OpenCode config: Claude Agent, the ChatGPT `openai` provider for Codex, and OpenCode Go. Direct SDKs (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`) stay optional behind the same interface if we need tighter trace control later. The user's existing login or config is reused, so we store no API keys. The config field `agentKind` selects `"opencode"` (production, default) or `"deterministic"` (automated runs) in `apps/control-plane/src/config.ts` and `apps/control-plane/src/agent/factory.ts`. |
| Learning interpreter and rules | Plain TypeScript modules, no framework | Reads rules, playbooks, policy, and the learning spec from SQLite, applies them, and writes a revision row. Deterministic, pure where possible, easy to unit test. |
| Profile and rules editor, timeline, teaching console, rehearsal observer | React 19.3.1, Vite 8.3.8, TypeScript, TanStack Query 5.108.2 for server state, native WebSocket for live streams | The four panels are interactive but not large. CSS variables instead of a UI kit at first. |
| Extension to control plane transport | HTTP POST for event batches and commands, WebSocket `/stream` for reasoning traces, rehearsal steps, approval requests, and teaching | One envelope shape: `{ type, id, ts, payload }`, validated with Zod schemas in `packages/shared`. A random token in a local config file plus an Origin allowlist for `chrome-extension://` and `moz-extension://` restricts access to the loopback server. |
| Voice input in the teaching console | sherpa-onnx-node 2.0.2 running the Parakeet TDT v3 int8 model (`parakeet-tdt-0.6b-v3-int8`) in a worker thread | The extension captures the microphone through the Web Audio API, resamples one mono channel to 16 kHz, encodes a 16-bit PCM WAV, and posts it to the control plane `/api/stt/transcribe` endpoint. The control plane transcribes on the device and returns the transcript for confirmation before it becomes a teaching event. No remote recognition service; typed teaching stays usable when the model is unavailable (`apps/control-plane/src/stt/`, `apps/extension/src/shared/audio.ts`). |
| Tests | Vitest 5.1.1 for units, Playwright 1.65.1 for extension and UI E2E | The repo already has Playwright MCP output, so browser verification is available. The extension suites load the development builds into real Chromium and Firefox and drive the local job-site fixture. |
| Verification | `bun run typecheck` (`tsc -b --noEmit`), `bun run lint`, `bun run build`, `bun run test`, `bun run e2e:web`, `bun run e2e:extension` | Run all four gates before merge; the E2E scripts run the Playwright suites from `tests/e2e`. |

## Notes on the risky choices

**SQLite driver.** `node:sqlite` is stability 1.2, a release candidate, not fully stable. It is adequate for a local-first app and removes the native build problem. Node 26.11 renamed `DatabaseSync` to `Database`, so the control plane pins `~26.10.0` in its `engines` field (`apps/control-plane/package.json`). Drizzle 0.45.4 has no `node-sqlite` driver, so the control plane connects through Drizzle's `sqlite-proxy` driver over raw `node:sqlite` `DatabaseSync` (`apps/control-plane/src/db/client.ts`), with WAL mode and foreign keys enabled. If the API status becomes a problem, Drizzle also supports `better-sqlite3` v13, which is stable but is a native addon.

**LLM adapter boundary.** Decided 2026-11-21: `@opencode/sdk` v2 is the single production adapter for all three subscriptions. Keep the `AgentAdapter` interface narrow so another SDK can be added later: start a task, consume normalized events, request structured output, cancel. Pass a persistent `database.path` to `OpenCode.create()` so sessions survive a control-plane restart; the SDK defaults to in-memory sessions. Pin the SDK version and parse events defensively. Implemented in `apps/control-plane/src/agent/`: `opencode-adapter.ts` for production, `deterministic-adapter.ts` for automated runs, `factory.ts` selects by the config field `agentKind` (`"opencode"` or `"deterministic"`).

**TypeScript dual compiler setup.** The root `package.json` pins two compilers: `@typescript/native` aliasing `typescript@7.0.2` (the Go-based preview used for the `tsc -b --noEmit` gate; `apps/control-plane` and `apps/extension` also pin `typescript` 7.0.2 directly) and `typescript` aliasing `@typescript/typescript6@6.0.2`, which `typescript-eslint` 8.73.0 uses for lint-time type information. Project references in the root `tsconfig.json` cover `packages/shared`, `apps/control-plane`, `apps/web`, and `apps/extension`, all extending `tsconfig.base.json`.

**OpenCode SDK v1 vs v2.** `@opencode-ai/sdk` is the v1 network client. It talks to a server on `127.0.0.1:4096`, either starting one with `createOpencode()` or connecting to an external one with `createOpencodeClient({ baseUrl })`. `@opencode/sdk` is the v2 in-process host. `OpenCode.create()` assembles the OpenCode server and routes calls through its HTTP router in memory, with no listener and no network hop. It runs inside our control plane process, exposes `sessions` and `events`, accepts plugins to customize agents, models, and tools, and depends on Effect 4. Pin the version because the v2 API is still evolving. The v2 host fits our topology: the control plane owns the agent rather than calling a separate OpenCode daemon.

**OpenCode Go support.** Go is a low-cost model subscription that works as a provider inside OpenCode, not a separate agent. The user connects it once in their OpenCode config with `/connect` and selects a model such as `opencode-go/kimi-k3`. Because the v2 SDK runs OpenCode core in process, it uses those models with no separate integration. Go requires clients to send typical coding-agent traffic, a real user agent, and a stable session ID in `x-opencode-session`. OpenCode core already sets `x-opencode-session`, `x-opencode-session-id`, `User-Agent`, and `x-opencode-client` on every model request, so the SDK inherits that behavior. The Go docs list OpenCode itself as a validated client, rather than naming the SDK separately. Keep the API key in the user's OpenCode config, not in Dex AI.

**Codex subscription through OpenCode.** OpenCode supports a ChatGPT Plus or Pro plan as the `openai` provider. Connect with `/connect`, choose OpenAI, then "Sign in with ChatGPT" or one of the legacy Codex sign-in methods. The core plugin `opencode.provider.chatgpt` handles OAuth with the token-sharing scope, and OpenCode loads provider credentials from its global data directory at startup. The v2 SDK hosts that same core and uses the user's config and models, so it can use the Codex subscription without a second login. OpenCode caps context below the model limit by default to match Codex; the cap plugin can be disabled in config.

**Claude subscription through OpenCode.** Since v2.2.3 (30 October 2026), OpenCode has a built-in **Claude Agent** provider. Install Claude Code, run `claude auth login`, then select Claude Agent in `/connect` to use the Claude Code login and models. OpenCode drives the local `claude` binary through Anthropic's Agent SDK and never reads the saved token. The PR author stated that Anthropic gave permission and that the integration is terms compliant; Anthropic has not published a separate confirmation. This means `@opencode/sdk` covers all three subscriptions in the product vision: Claude through Claude Agent, Codex through the ChatGPT OpenAI provider, and OpenCode Go through its API key. Every subscription goes through this one adapter. The direct SDKs stay optional behind the `AgentAdapter` interface; `@anthropic-ai/claude-agent-sdk` is the more direct path if we later want tighter control over tool use and traces.

**Privacy boundary.** "Nothing leaves the device" means local storage. Prompts still go to Codex, Claude, or OpenCode because the user chose to run on those subscriptions. Voice input is transcribed on the device by the local Parakeet model, so audio never goes to a provider. The web interface discloses the prompt caveat in its `PrivacyNotice` component.

## Open items from the research

- Exact N for familiarity. Store as config in SQLite, default 3. Still open.
- Rehearsal pause policy. Implemented as the config field `lowConfidenceThreshold` (default 0.7) rather than a hardcoded rule (`apps/control-plane/src/config.ts`).
- Rehearsal interaction detail and the final transport schema. Implemented in `packages/shared/src/` (envelope, events, REST, WebSocket, rehearsal actions) and `apps/control-plane/src/services/rehearsal-controller.ts`.

## Build order

1. Extension capture events, HTTP ingest, SQLite schema, profile sections, session timeline and rules editor. No submissions. Done in the control plane milestone.
2. Teaching console and rehearsal observer with live reasoning traces over WebSocket. Done in the control plane milestone.
3. Learning interpreter, revision history, and playbook distillation.
4. Autonomy gate and frozen core guards.
