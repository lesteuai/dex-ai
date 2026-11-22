# Spec: Control plane first milestone

Status: implemented
Request: $sdd let's start with the control plane first
Follow-up request: add make extensions for both firefox and chrome. For voice, use a local model like parakeet

## Overview

Build the localhost control plane as Dex AI's server and user interface, backed by SQLite and the user's configured OpenCode provider. This milestone covers observation, profile and rule learning, teaching, session inspection, and supervised rehearsal through development extensions for Chrome and Firefox. The extensions can navigate and fill forms during rehearsal, while the control plane prevents every application submission. Voice input is transcribed on the device by a local speech model such as Parakeet.

## User Stories

- As a job seeker using Chrome or Firefox, I want Dex AI to observe my searches, opened postings, completed fields, and stated reasons, so that it builds a personalized profile from my actual behavior.
- As a job seeker, I want to inspect and correct profile entries, rules, and their reasoning traces, so that future decisions reflect my preferences and I can audit every change.
- As a job seeker, I want to teach Dex AI with text or locally transcribed voice, so that I can explain my intent without manually editing every rule or sending my audio away.
- As a job seeker, I want a session timeline, so that I can reconstruct what the agent observed, inferred, and did.
- As a job seeker, I want to supervise a live rehearsal with visible reasoning, confidence-based pauses, corrections, and submission blocking, so that I can evaluate the agent safely before autonomous application work exists.

## Acceptance Criteria

- AC-1: A documented command starts the control plane on `127.0.0.1` and serves the React interface, HTTP API, and WebSocket stream from one local process. Loopback clients can reach it; a non-loopback listener is never created by the default configuration.
- AC-2: Browser clients authenticate with the local token, and extension requests must come from an allowed Chrome or Firefox extension origin. Requests with a missing or invalid token and requests from disallowed origins are rejected without changing stored state.
- AC-3: Development extensions for both Chrome and Firefox capture searches and filters, postings opened, fields filled, and reasons stated in text or voice. Valid event envelopes from either browser reach the control plane and appear in the correct session timeline; malformed events are rejected with an actionable error, and duplicate event IDs do not create duplicate records.
- AC-4: After an observed session, the configured OpenCode provider produces a profile containing facts about the user, job-source habits, preferences and criteria, and form-filling rules. Every populated section links its inferred entries to source events and an inspectable reasoning trace, and an empty or insufficiently supported section is shown as empty rather than filled with fabricated facts.
- AC-5: The profile and rules editor lets the user inspect and correct inferred entries and rules. Corrections persist after a control-plane restart and are used in the next similar inference or rehearsal decision.
- AC-6: Every inference, agent-proposed change, user correction, and rehearsal decision records its reasoning trace, source session, prior value, new value, and timestamp in a retrievable revision history. The user can inspect the history and identify the session that caused each change.
- AC-7: The timeline lists stored sessions and presents each session's captured events, reasoning traces, corrections, and rehearsal actions in chronological order, including live updates while a session is active.
- AC-8: The teaching console accepts typed input and voice captured by either development extension and transcribed by a local speech model such as Parakeet. The transcript is shown for confirmation before it becomes a teaching event, and audio and transcription remain on the device. If the local model is unavailable or the browser blocks capture, typed teaching stays usable and the interface explains the limitation.
- AC-9: Agent tasks run through the user's configured OpenCode provider, expose normalized reasoning and status updates to the interface, support cancellation, and preserve completed work when a task fails or is cancelled. A live smoke test succeeds with one provider already configured in the user's OpenCode environment, while automated tests use a deterministic adapter.
- AC-10: From the rehearsal observer, the user can start a rehearsal for the posting open in either development extension, watch proposed navigation and form-filling actions with reasoning, and allow the extension to execute permitted actions on the page. The same flow works against the deterministic local job-site fixture and a public posting selected by the user.
- AC-11: During rehearsal, a proposed action with confidence below the configured threshold pauses before execution, and the user can pause or interrupt at any time. Confident actions may proceed automatically; a paused action executes only after user approval, while a user correction changes the proposed action before execution. An interrupted or disconnected rehearsal executes no further action until explicitly resumed.
- AC-12: The rehearsal fills allowed fields but blocks navigation or activation that would submit the application, including an attempted submission followed by user approval. The block is visible in the observer and recorded in the session history; verification completes without submitting an application on either the local fixture or public posting.
- AC-13: A correction made once is applied to the next similar session and to every stored rule identified as contributing to the corrected decision. Regression verification shows that the corrected decision does not recur and that each affected rule has its own linked revision entry.
- AC-14: On a held-out local-fixture session with declared expected navigation and field values, rehearsal completes with no uncorrected errors. Any divergence is surfaced for correction and recorded instead of being silently accepted.
- AC-15: A repeatable local-fixture evaluation reports decision errors per session and demonstrates a lower error count after teaching or correction. Its results distinguish unchanged errors, corrected errors, and new errors so that improvement is measurable.
- AC-16: Profile data, sessions, configuration, reasoning traces, and revision history persist in the local SQLite database across process restarts. The interface discloses that LLM prompts are sent to the selected provider; Dex AI stores no API keys, sends voice audio to no provider, and runs no remote storage service.
- AC-17: The React interface exposes all four panels: profile and rules editor, session timeline, teaching console, and rehearsal observer. A user can complete the observation, correction, teaching, and supervised rehearsal flows through these panels without editing the database manually.

## Edge Cases

- Invalid event batch: reject the invalid envelope and return field-specific validation details; valid existing data remains unchanged.
- Duplicate or out-of-order events: deduplicate by event ID and display them in chronological order using their captured timestamps.
- Session with insufficient evidence: leave affected profile sections empty and request more observation or teaching instead of inventing entries.
- Conflicting corrections: the latest explicit user correction takes precedence in future decisions, while earlier values and corrections remain in revision history.
- LLM unavailable or cancelled: show the failure or cancellation in the current session, retain completed changes, and allow the user to retry without duplicating events.
- Local speech model unavailable: keep typed teaching available, explain the missing local model, and do not fall back to a remote recognition service.
- Browser microphone permission denied: retain the typed draft, show the permission issue, and retry voice capture only after the user grants permission.
- Extension disconnects or the control plane restarts during rehearsal: persist the rehearsal in a paused state and require explicit resume before any further browser action.
- Low-confidence action: keep it unexecuted until approval or correction, even if subsequent actions are already queued.
- Submit control, final application navigation, or implicit form submission: block it, record the attempted action, and keep the rehearsal active for safe navigation away from the submission path.
- Restart after completed work: reload profile data, configuration, sessions, traces, and revisions from SQLite without resetting them.

## Non-Goals

- Autonomous job applications or autonomous submission.
- Familiarity-threshold automation and approval policies for new role types, platforms, or forms.
- Production-ready support for arbitrary job platforms or CAPTCHA and anti-bot challenges.
- Remote speech recognition services.
- Direct Anthropic or OpenAI SDK integrations outside the OpenCode adapter.
- Cloud storage, multi-user accounts, or remote access to the control plane.
- Autonomous rewriting of executable code or the fixed learning interpreter.
- Publishing to the Chrome Web Store or Firefox Add-ons; development builds must load in both browsers.

## Open Questions

- The default numeric low-confidence threshold remains a configuration decision for planning; it does not block the criteria because tests can set an explicit threshold.
- The exact local speech runtime and Parakeet model variant remain implementation decisions; the observable requirement is on-device transcription.
- The exact public posting for the live smoke test will be selected by the user during verification; deterministic acceptance uses the local fixture. AC-9 and the public posting smoke are deferred in [DEFERRED-VERIFICATION.md](DEFERRED-VERIFICATION.md).
