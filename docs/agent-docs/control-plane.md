# Control plane first milestone

Implemented 21 November 2026. The spec, plan, tasks, and the two deferred verification checks live in [specs/261121-control-plane/](specs/261121-control-plane/). This page records how to run what exists.

## Start the control plane and web UI

Prerequisites: Bun 1.4.2, Node 26.10 (pinned `~26.10.0` in `apps/control-plane/package.json`, because Node 26.11 renamed `DatabaseSync` to `Database`).

```bash
bun install
bun run --filter '@dex-ai/web' build        # builds apps/web/dist, served by the control plane
bun run --filter '@dex-ai/control-plane' dev
```

The control plane binds `127.0.0.1:8787`, serves the built web UI with an `index.html` fallback, and logs the config file path at startup (`apps/control-plane/src/index.ts`). Open `http://127.0.0.1:8787`, enter the token from the config file, and the four panels appear.

For web UI development with hot reload, run the Vite dev server next to the control plane: `bun run --filter '@dex-ai/web' dev`. The dev server proxies `/api`, `/fixtures`, and the `/stream` WebSocket to the control plane (`apps/web/vite.config.ts`, target overridable with `DEX_AI_CONTROL_PLANE_URL`).

The config field `agentKind` selects the agent adapter (`apps/control-plane/src/agent/factory.ts`):

- `"opencode"` (default): real `@opencode/sdk` 2.3.2 work through the user's configured OpenCode provider. Automated tests never use this.
- `"deterministic"`: scripted adapter for automated runs and E2E suites.

The optional field `opencodeModel` (`provider/model`, as `opencode models` prints it) picks the model for every agent session; unset uses the OpenCode default. OpenCode's free `opencode/*-free` models answer `Free usage limit reached` through the SDK on the first call (verified 22 November 2026; the error says free models work only in the OpenCode app), so live runs need a connected provider such as Claude, ChatGPT, or OpenCode Go.

For a throwaway environment, set `DEX_AI_HOME` before starting: `DEX_AI_HOME=/tmp/opencode/smoke bun run --filter '@dex-ai/control-plane' dev`.

## Local files

`apps/control-plane/src/config.ts` decides the locations:

| File | `DEX_AI_HOME` set | default |
| --- | --- | --- |
| Config | `$DEX_AI_HOME/config.json` | `~/.config/dex-ai/config.json` |
| Data directory | `$DEX_AI_HOME/data` | `~/.local/share/dex-ai` |
| SQLite | `<dataDir>/control-plane.sqlite` | same rule |
| Parakeet model | `<dataDir>/models/parakeet-tdt-0.6b-v3-int8` | same rule |

First run creates the config with a random token, written with mode `0600`. Config fields: `host` (127.0.0.1), `port` (8787), `token`, `dataDir`, `extensionOrigins`, `localUiOrigin`, `lowConfidenceThreshold` (default 0.7), `parakeetModelPath`, `agentKind`, and the optional `opencodeModel`. The SQLite database runs in WAL mode with foreign keys on (`apps/control-plane/src/db/client.ts`).

## The four web panels

`apps/web/src/App.tsx` gates on the token, then shows the tabs:

- **Profile & Rules** (`panels/ProfileEditor.tsx`): inspect and correct inferred profile entries and form-filling rules, run inference on an observed session, and read the revision history that links every change to its reasoning trace and source session.
- **Session Timeline** (`panels/SessionTimeline.tsx`): list stored sessions and each session's captured events, reasoning traces, corrections, and rehearsal actions in chronological order, with live updates over the `/stream` WebSocket while a session is active.
- **Teaching Console** (`panels/TeachingConsole.tsx`): typed teaching input, and voice transcripts that must be confirmed before they become teaching events.
- **Rehearsal Observer** (`panels/RehearsalObserver.tsx`): start a rehearsal for the posting open in the extension, watch proposed actions with reasoning and confidence, approve or correct actions paused below the confidence threshold, and see blocked submission attempts.

A `PrivacyNotice` component states where prompts, data, keys, and audio travel (`components/PrivacyNotice.tsx`).

## Extension setup

One source builds for both browsers (`apps/extension/manifest.config.ts`):

```bash
bun run --filter '@dex-ai/extension' build    # emits dist/chrome and dist/firefox
```

**Chrome.** Load `dist/chrome` as an unpacked extension. The pinned manifest `key` keeps the extension ID stable at `ffvdecqdiyveusqd`, so add `chrome-extension://ffvdecqdiyveusqd` to `extensionOrigins` in the config once.

**Firefox.** Load `dist/firefox` as a temporary add-on through `about:debugging`. Firefox 128 or newer is required for the MAIN-world content script. Firefox assigns a random `moz-extension://` UUID per install, so copy the origin shown in `about:debugging` into `extensionOrigins` in the config.

Open the extension popup, paste the control plane token, and save. The background coordinator owns the token and the WebSocket stream from there. A `403` response in the popup means the extension origin is missing from `extensionOrigins`.

Firefox's default MV3 CSP injects `upgrade-insecure-requests`, which would upgrade the loopback `ws://127.0.0.1:8787/stream` connection to `wss://` and break it. The Firefox build declares `content_security_policy.extension_pages: "script-src 'self'; object-src 'self'"` to exclude the upgrade directive while keeping scripts restricted to `'self'`. `apps/extension/src/manifest.test.ts` asserts the policy.

## Local voice capture and transcription

The popup records the microphone through the Web Audio API, resamples one mono channel to 16 kHz, and encodes a 16-bit PCM WAV (`apps/extension/src/shared/audio.ts`, `recorder.ts`). It posts the WAV to the control plane `POST /api/stt/transcribe` endpoint.

The control plane transcribes in a worker thread with `sherpa-onnx-node` 2.0.2 `OfflineRecognizer` and the Parakeet TDT v3 int8 model (`apps/control-plane/src/stt/worker.ts`). The model dir is `parakeetModelPath` from the config, default `<dataDir>/models/parakeet-tdt-0.6b-v3-int8`, and must contain `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, and `tokens.txt`. The model loads lazily on the first request.

When the model files or the native addon are missing, the endpoint answers `503 stt_unavailable`, the popup shows the reason, and typed teaching keeps working. Audio samples are transferred to the worker and never persisted or sent anywhere else.

## Verification

From the repository root:

```bash
bun run typecheck       # tsc -b --noEmit
bun run lint            # eslint .
bun run build           # builds web and extension
bun run test            # vitest run
bunx playwright install chromium firefox   # once, for E2E
bun run e2e:web         # web interface suites in Chromium and Firefox
bun run e2e:extension   # extension suites in Chrome and Firefox development builds
```

The E2E suites use throwaway configs under `/tmp/opencode` and the deterministic adapter. `tests/e2e/README.md` documents the suite structure, the port-8787 file lock, and the Firefox loading details.

## Deferred verification

Two checks are deferred by user decision and recorded in [specs/261121-control-plane/DEFERRED-VERIFICATION.md](specs/261121-control-plane/DEFERRED-VERIFICATION.md):

- AC-9: live OpenCode-provider smoke for one profile-inference task.
- AC-10 and AC-12: public posting smoke that proves capture and the pre-submission stop on a real posting.

Follow the steps in that file, then record the results there.
