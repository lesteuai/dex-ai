# Tech Stack

Proposed 2026-11-21 from [the solution architecture graph](research/261120-dex-ai-vision/architecture.html). Choices marked as decided have been confirmed by the user; the rest are proposals.

## Principles

- TypeScript everywhere: extension, server, web UI, and the shared protocol.
- Local only: bind to `127.0.0.1`, keep the SQLite file on disk, call no remote service of our own. LLM inference goes to the user's subscribed provider by design; stored data does not.
- No agent framework. The interpreter that executes the learning spec is fixed code; the agent changes the rules, playbooks, policy, and spec that the interpreter reads.
- Small packages with one responsibility each.

## Repository layout

Bun workspaces with TypeScript project references:

```
apps/control-plane   Node server, SQLite, LLM adapters, learning interpreter
apps/web             React UI, built into control-plane static assets
apps/extension       Manifest V3 browser extension
packages/shared      Zod schemas, message envelope, shared types
```

## Mapping from the graph

| Graph node | Choice | Reason |
| --- | --- | --- |
| Browser extension (client) | TypeScript, Manifest V3, Vite 8, `@crxjs/vite-plugin` 3.0 | CRXJS gives HMR in content scripts and the service worker and generates manifest entries. Chrome first; `webextension-polyfill` for Firefox later. |
| Control plane (server) | Node.js 26 LTS (Active LTS), TypeScript, Hono 4 with `@hono/node-server` and `ws` | One small process serves REST and WebSocket. Hono's Node WebSocket path uses `upgradeWebSocket` from `@hono/node-server` with a `WebSocketServer({ noServer: true })`; `@hono/node-ws` is deprecated. Bind `127.0.0.1` only. |
| Memory (SQLite) | `node:sqlite` built in, Drizzle ORM through the `sqlite-proxy` driver, drizzle-kit migrations | No native addon, no `node-gyp`, no prebuilt binary roulette on Node upgrades. The module is synchronous and the database is a local file. Drizzle 0.45.4 does not ship a `node-sqlite` driver, so the control plane uses its `sqlite-proxy` driver over raw `node:sqlite`. |
| LLM agent tasks | Thin `AgentAdapter` interface implemented by `@opencode/sdk` v2 alone | `OpenCode.create()` hosts OpenCode in process and streams events through `opencode.events.subscribe()`. One adapter serves all three subscriptions through the user's OpenCode config: Claude Agent, the ChatGPT `openai` provider for Codex, and OpenCode Go. Direct SDKs (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`) stay optional behind the same interface if we need tighter trace control later. The user's existing login or config is reused, so we store no API keys. |
| Learning interpreter and rules | Plain TypeScript modules, no framework | Reads rules, playbooks, policy, and the learning spec from SQLite, applies them, and writes a revision row. Deterministic, pure where possible, easy to unit test. |
| Profile and rules editor, timeline, teaching console, rehearsal observer | React 19, Vite 8, TypeScript, TanStack Query for server state, native WebSocket for live streams | The four panels are interactive but not large. CSS variables instead of a UI kit at first. |
| Extension to control plane transport | HTTP POST for event batches and commands, WebSocket `/stream` for reasoning traces, rehearsal steps, approval requests, and teaching | One envelope shape: `{ type, id, ts, payload }`, validated with Zod schemas in `packages/shared`. A random token in a local config file plus an Origin allowlist for `chrome-extension://` and `moz-extension://` restricts access to the loopback server. |
| Voice input in the teaching console | Web Speech API in the browser, with a local STT fallback | Chrome's Web Speech API sends audio to a provider. For strict local-only, add a local `whisper.cpp` or `faster-whisper` endpoint. This is an open decision. |
| Tests | Vitest for units, Playwright for extension and UI E2E | The repo already has Playwright MCP output, so browser verification is available. |
| Verification | `tsc --noEmit`, ESLint, `vite build`, `vitest run` | Run all four gates before merge. |

## Notes on the risky choices

**SQLite driver.** `node:sqlite` is stability 1.2, a release candidate, not fully stable. It is adequate for a local-first app and removes the native build problem. Node 26.11 renamed `DatabaseSync` to `Database`, so pin the Node minor. Drizzle 0.45.4 has no `node-sqlite` driver, so the control plane connects through Drizzle's `sqlite-proxy` driver over raw `node:sqlite` `DatabaseSync`. If the API status becomes a problem, Drizzle also supports `better-sqlite3` v13, which is stable but is a native addon.

**LLM adapter boundary.** Decided 2026-11-21: `@opencode/sdk` v2 is the single production adapter for all three subscriptions. Keep the `AgentAdapter` interface narrow so another SDK can be added later: start a task, consume normalized events, request structured output, cancel. Pass a persistent `database.path` to `OpenCode.create()` so sessions survive a control-plane restart; the SDK defaults to in-memory sessions. Pin the SDK version and parse events defensively.

**OpenCode SDK v1 vs v2.** `@opencode-ai/sdk` is the v1 network client. It talks to a server on `127.0.0.1:4096`, either starting one with `createOpencode()` or connecting to an external one with `createOpencodeClient({ baseUrl })`. `@opencode/sdk` is the v2 in-process host. `OpenCode.create()` assembles the OpenCode server and routes calls through its HTTP router in memory, with no listener and no network hop. It runs inside our control plane process, exposes `sessions` and `events`, accepts plugins to customize agents, models, and tools, and depends on Effect 4. Pin the version because the v2 API is still evolving. The v2 host fits our topology: the control plane owns the agent rather than calling a separate OpenCode daemon.

**OpenCode Go support.** Go is a low-cost model subscription that works as a provider inside OpenCode, not a separate agent. The user connects it once in their OpenCode config with `/connect` and selects a model such as `opencode-go/kimi-k3`. Because the v2 SDK runs OpenCode core in process, it uses those models with no separate integration. Go requires clients to send typical coding-agent traffic, a real user agent, and a stable session ID in `x-opencode-session`. OpenCode core already sets `x-opencode-session`, `x-opencode-session-id`, `User-Agent`, and `x-opencode-client` on every model request, so the SDK inherits that behavior. The Go docs list OpenCode itself as a validated client, rather than naming the SDK separately. Keep the API key in the user's OpenCode config, not in Dex AI.

**Codex subscription through OpenCode.** OpenCode supports a ChatGPT Plus or Pro plan as the `openai` provider. Connect with `/connect`, choose OpenAI, then "Sign in with ChatGPT" or one of the legacy Codex sign-in methods. The core plugin `opencode.provider.chatgpt` handles OAuth with the token-sharing scope, and OpenCode loads provider credentials from its global data directory at startup. The v2 SDK hosts that same core and uses the user's config and models, so it can use the Codex subscription without a second login. OpenCode caps context below the model limit by default to match Codex; the cap plugin can be disabled in config.

**Claude subscription through OpenCode.** Since v2.2.3 (30 October 2026), OpenCode has a built-in **Claude Agent** provider. Install Claude Code, run `claude auth login`, then select Claude Agent in `/connect` to use the Claude Code login and models. OpenCode drives the local `claude` binary through Anthropic's Agent SDK and never reads the saved token. The PR author stated that Anthropic gave permission and that the integration is terms compliant; Anthropic has not published a separate confirmation. This means `@opencode/sdk` covers all three subscriptions in the product vision: Claude through Claude Agent, Codex through the ChatGPT OpenAI provider, and OpenCode Go through its API key. Every subscription goes through this one adapter. The direct SDKs stay optional behind the `AgentAdapter` interface; `@anthropic-ai/claude-agent-sdk` is the more direct path if we later want tighter control over tool use and traces.

**Privacy boundary.** "Nothing leaves the device" means local storage. Prompts still go to Codex, Claude, or OpenCode because the user chose to run on those subscriptions. Voice input has the same caveat unless local STT is used. Make this visible in the control plane so the user is not misled.

## Open items from the research

- Exact N for familiarity. Store as config in SQLite, default 3.
- Rehearsal pause policy. Keep it a setting rather than a hardcoded rule.
- Rehearsal interaction detail and the final transport schema live in implementation design.

## Build order

1. Extension capture events, HTTP ingest, SQLite schema, profile sections, session timeline and rules editor. No submissions.
2. Teaching console and rehearsal observer with live reasoning traces over WebSocket.
3. Learning interpreter, revision history, and playbook distillation.
4. Autonomy gate and frozen core guards.
