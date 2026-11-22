# Dex AI

A local-first personal job-application agent. A browser extension watches you apply for jobs on the sites you already use, learns your profile and your rules from what you do, and rehearses applications under your supervision. A control plane running on your own machine stores everything it learns in SQLite and reasons through the LLM subscription you already have. Nothing it stores leaves your device.

Dex AI works like an intern sitting next to you. You apply for jobs in your browser as usual. The agent records what you search, which postings you open, which fields you fill, and the reasons you give in text or voice. It builds a profile you can inspect and correct at any time. Later, when it has seen the same role type and the same form enough times, it can prepare applications itself, still asking before anything new.

## How it fits together

```
Browser extension (client)          Control plane (server, 127.0.0.1:8787)
  observes pages, records audio  -->  Hono REST + WebSocket stream
  executes rehearsal actions    <--  agent tasks over @opencode/sdk
                                      SQLite memory (WAL)
                                      Parakeet STT in a worker thread
                                                |
                                                v
                                      Web UI (React, four panels)
```

The extension is the client. The control plane owns the memory, the SQLite database, and the LLM work, routed through your existing OpenCode subscription: Claude through Claude Agent, Codex through the ChatGPT OpenAI provider, or OpenCode Go through its API key. Dex AI stores no API keys; it reuses the login already configured in your OpenCode setup.

Storage and privacy: config, sessions, profile, rules, and revision history live in one SQLite file on your disk. The server binds to `127.0.0.1` only, guarded by a random token and an origin allowlist. Prompts do go to your chosen LLM provider, because that is where the reasoning happens; voice audio is transcribed on the device and never sent anywhere.

## Repository layout

Bun workspaces with TypeScript project references.

```
apps/control-plane    Node server: Hono REST + WebSocket, SQLite via Drizzle,
                      LLM adapters, learning interpreter
apps/web              React UI, built into the control plane's static assets
apps/extension        Manifest V3 extension, one source for Chrome and Firefox
packages/shared       Zod schemas, message envelope, shared types
tests/e2e             Playwright suites for the web UI and the extension
docs/agent-docs       Project memory: tech stack, run instructions, specs
```

## Getting started

Prerequisites: Bun 1.4.2 and Node 26.10 (the control plane pins `~26.10.0`, because Node 26.11 renamed `DatabaseSync`). Your OpenCode config must have a working provider for the default `agentKind: "opencode"`.

```bash
bun install
bun run --filter '@dex-ai/web' build
bun run --filter '@dex-ai/control-plane' dev
```

Open `http://127.0.0.1:8787`. On first start the control plane writes `~/.config/dex-ai/config.json` with a random token (file mode `0600`). Paste that token into the web UI to unlock the four panels.

For web UI development with hot reload, run `bun run --filter '@dex-ai/web' dev` next to the control plane; the Vite dev server proxies `/api`, `/fixtures`, and the `/stream` WebSocket to it.

### Install the extension

```bash
bun run --filter '@dex-ai/extension' build    # emits dist/chrome and dist/firefox
```

**Chrome:** load `apps/extension/dist/chrome` as an unpacked extension. The pinned manifest key keeps the extension ID stable, so add `chrome-extension://ffvdecqdiyveusqd` to `extensionOrigins` in the config once.

**Firefox:** load `apps/extension/dist/firefox` as a temporary add-on through `about:debugging` (Firefox 128 or newer). Copy the `moz-extension://<uuid>` origin shown there into `extensionOrigins` in the config, because the UUID changes per install.

Then open the extension popup, paste the control plane token, and save. A `403` in the popup means the extension origin is missing from `extensionOrigins`.

### Optional: voice input

Voice teaching uses the Parakeet TDT v3 int8 model, transcribed on your device by `sherpa-onnx-node`. Run `bun run setup:voice` (about 640 MB, safe to rerun) or download the model into the data directory yourself:

```
~/.local/share/dex-ai/models/parakeet-tdt-0.6b-v3-int8/
    encoder.int8.onnx  decoder.int8.onnx  joiner.int8.onnx  tokens.txt
```

The model loads lazily on the first request. Without it, the STT endpoint answers `503`, the popup says why, and typed teaching keeps working. Audio is processed in a worker thread and never persisted or sent anywhere.

## Using the app

The web UI has four panels.

- **Profile & Rules:** inspect and correct inferred profile entries and form-filling rules, run inference on a stored session, and read the revision history that ties every change to its reasoning trace.
- **Session Timeline:** every stored session with its captured events, reasoning traces, corrections, and rehearsal actions, updating live over the WebSocket while a session runs.
- **Teaching Console:** typed teaching input, plus voice transcripts that you confirm before they become teaching events.
- **Rehearsal Observer:** start a rehearsal for the posting open in the extension, watch each proposed action with its reasoning and confidence, approve or correct actions that fall below the confidence threshold, and see blocked submission attempts.

**Job match:** the extension popup's "Check match" button scores the posting in the current tab against your learned preferences, criteria and job sources (`POST /api/match`), and lists which ones matched and which are missing. It runs locally without an LLM.
**Auto mode:** tick "Auto mode" when starting a rehearsal (web observer or extension popup). If the posting's platform (url host) and role type (posting title without the company) have each appeared in `autonomyThreshold` completed rehearsals, the rehearsal runs with no confidence pauses. A new platform or role type keeps the normal pause-and-ask behavior, and a new company alone counts as familiar. Submission stays blocked in every mode, so the final submit is always yours.

A typical flow: apply for jobs normally while the extension records, open the Session Timeline to see what was captured, run inference from Profile & Rules, correct what it got wrong, then start a rehearsal from Rehearsal Observer to watch it attempt a posting under your supervision. Rehearsals pause on low confidence (configurable, default `0.7`) and block all submissions.

## Configuration

`~/.config/dex-ai/config.json`, created on first run. Set `DEX_AI_HOME` to relocate everything, useful for a throwaway environment.

| Field | Default | Purpose |
| --- | --- | --- |
| `host` / `port` | `127.0.0.1` / `8787` | Where the control plane listens |
| `token` | random | Auth for the web UI and the extension |
| `dataDir` | `~/.local/share/dex-ai` | SQLite file and models live here |
| `extensionOrigins` | `[]` | Allowed `chrome-extension://` or `moz-extension://` origins |
| `agentKind` | `"opencode"` | `"opencode"` for real LLM work, `"deterministic"` for automated runs |
| `opencodeModel` | unset | `provider/model` from `opencode models`, such as `anthropic/claude-sonnet-5-5`; unset uses the OpenCode default |
| `autonomyThreshold` | `3` | Completed rehearsals needed on a platform and on a role type before auto mode stops pausing |
| `lowConfidenceThreshold` | `0.7` | Rehearsal actions below this confidence pause for approval |
| `parakeetModelPath` | `<dataDir>/models/parakeet-tdt-0.6b-v3-int8` | Local STT model directory |

## Verification

From the repository root:

```bash
bun run typecheck       # tsc -b --noEmit
bun run lint            # eslint .
bun run build           # builds web and extension
bun run test            # vitest run
bunx playwright install chromium firefox   # once, for E2E
bun run e2e:web         # web UI suites in Chromium and Firefox
bun run e2e:extension   # extension suites in real Chrome and Firefox
```

The E2E suites run against throwaway configs under `/tmp/opencode` with the deterministic adapter, so they never call a real provider. See `tests/e2e/README.md` for the suite structure.

## License

MIT, see [LICENSE](LICENSE).
