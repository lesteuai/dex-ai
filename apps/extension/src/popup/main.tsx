import browser from "webextension-polyfill";
import {
  ControlPlaneRequestError,
  createTeachingDraft,
  postJobMatch,
  postSttTranscription,
} from "../shared/api-client";
import type { JobMatchResponse } from "@dex-ai/shared";
import type { ControlPlaneSettings } from "../shared/auth";
import type {
  CoordinatorResponse,
  ExtensionMessage,
  PostingText,
  SaveSettingsResponse,
  StartRehearsalResponse,
} from "../shared/messages";
import { READ_POSTING_MESSAGE_TYPE } from "../shared/messages";
import { VoiceRecorder, VoiceRecorderError } from "../shared/recorder";

/**
 * Popup behavior: control plane token setup, typed and voice teaching with
 * local transcription, and starting a rehearsal for the current tab. The
 * background coordinator owns the token, the stream and the observed session,
 * so every write and rehearsal start goes through it.
 */

function getElement<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Popup element is missing: ${id}`);
  return element as ElementType;
}

const settingsForm = getElement<HTMLFormElement>("settings-form");
const baseUrlInput = getElement<HTMLInputElement>("base-url-input");
const tokenInput = getElement<HTMLInputElement>("token-input");
const settingsStatus = getElement<HTMLElement>("settings-status");
const typedTeachingInput = getElement<HTMLTextAreaElement>("typed-teaching-input");
const createDraftButton = getElement<HTMLButtonElement>("create-draft-button");
const recordButton = getElement<HTMLButtonElement>("record-button");
const recordingIndicator = getElement<HTMLElement>("recording-indicator");
const voiceResult = getElement<HTMLElement>("voice-result");
const transcriptInput = getElement<HTMLTextAreaElement>("transcript-input");
const confirmTranscriptButton = getElement<HTMLButtonElement>("confirm-transcript-button");
const discardTranscriptButton = getElement<HTMLButtonElement>("discard-transcript-button");
const teachingStatus = getElement<HTMLElement>("teaching-status");
const startRehearsalButton = getElement<HTMLButtonElement>("start-rehearsal-button");
const rehearsalStatus = getElement<HTMLElement>("rehearsal-status");
const checkMatchButton = getElement<HTMLButtonElement>("check-match-button");
const matchStatus = getElement<HTMLElement>("match-status");
const matchReasons = getElement<HTMLUListElement>("match-reasons");

function showStatus(element: HTMLElement, text: string, tone: "info" | "error" = "info"): void {
  element.textContent = text;
  element.classList.toggle("error", tone === "error");
  element.hidden = false;
}

async function requestCoordinator(message: ExtensionMessage): Promise<CoordinatorResponse> {
  return (await browser.runtime.sendMessage(message)) as CoordinatorResponse;
}

async function getSettings(): Promise<ControlPlaneSettings> {
  // The dex-ai:get-settings response shape matches ControlPlaneSettings.
  return (await requestCoordinator({ type: "dex-ai:get-settings" })) as ControlPlaneSettings;
}

function requireToken(settings: ControlPlaneSettings, status: HTMLElement): boolean {
  if (settings.token !== null) return true;
  showStatus(status, "Save the control plane token in the panel above first", "error");
  return false;
}

function requestFailureText(error: unknown): string {
  if (error instanceof ControlPlaneRequestError) {
    if (error.status === 403) {
      return `${error.message} Add this extension origin to extensionOrigins in the control plane config.`;
    }
    if (error.status === 401) {
      return `${error.message} Check the token in the control plane config.json.`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

// Token setup. Saves go through the coordinator so it reconnects the stream.

async function loadCurrentSettings(): Promise<void> {
  const settings = await getSettings();
  baseUrlInput.value = settings.baseUrl;
  tokenInput.value = "";
  tokenInput.placeholder = settings.token === null
    ? "Paste the token from the control plane config.json"
    : "A token is stored. Paste a new one to replace it.";
}

async function handleSettingsSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const baseUrl = baseUrlInput.value.trim();
  const token = tokenInput.value.trim();
  const response = (await requestCoordinator({
    type: "dex-ai:set-settings",
    ...(baseUrl === "" ? {} : { baseUrl }),
    ...(token === "" ? {} : { token }),
  })) as SaveSettingsResponse;
  if (!response.ok) {
    showStatus(settingsStatus, response.error, "error");
    return;
  }
  await loadCurrentSettings();
  showStatus(settingsStatus, "Settings saved. The coordinator reconnected to the control plane.");
}

// Teaching. Typed and voice input both create a pending draft; the teaching
// console confirms the draft into a teaching event.

async function handleCreateDraftClick(): Promise<void> {
  const transcript = typedTeachingInput.value.trim();
  if (transcript === "") {
    showStatus(teachingStatus, "Type what Dex AI should learn first", "error");
    return;
  }
  const settings = await getSettings();
  if (!requireToken(settings, teachingStatus)) return;
  try {
    const draft = await createTeachingDraft(settings, { source: "text", transcript });
    typedTeachingInput.value = "";
    showStatus(teachingStatus, `Draft ${draft.id.slice(0, 8)} is pending. Confirm it in the teaching console.`);
  } catch (error) {
    showStatus(teachingStatus, requestFailureText(error), "error");
  }
}

let voiceRecorder: VoiceRecorder | null = null;

function voiceCaptureFailureText(error: unknown): string {
  if (error instanceof VoiceRecorderError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function transcriptionFailureText(error: unknown): string {
  // 503 means the local Parakeet model is unavailable; never fall back to a
  // remote recognition service.
  if (error instanceof ControlPlaneRequestError && error.status === 503) {
    return `The local speech model is unavailable: ${error.message} Typed teaching remains available.`;
  }
  return requestFailureText(error);
}

async function transcribeCapturedVoice(recorder: VoiceRecorder): Promise<void> {
  voiceRecorder = null;
  recordButton.textContent = "Record voice";
  recordingIndicator.hidden = true;
  let wav: ArrayBuffer;
  try {
    wav = await recorder.stop();
  } catch (error) {
    showStatus(teachingStatus, voiceCaptureFailureText(error), "error");
    return;
  }
  const settings = await getSettings();
  showStatus(teachingStatus, "Transcribing locally. Audio and transcript stay on this device.");
  try {
    const text = await postSttTranscription(settings, wav);
    const transcript = text.trim();
    if (transcript === "") {
      showStatus(
        teachingStatus,
        "No speech was recognized. Record again or type the teaching instead.",
        "error",
      );
      return;
    }
    transcriptInput.value = transcript;
    voiceResult.hidden = false;
    showStatus(teachingStatus, "Review and edit the transcript, then confirm to create the teaching draft.");
  } catch (error) {
    showStatus(teachingStatus, transcriptionFailureText(error), "error");
  }
}

async function handleRecordButtonClick(): Promise<void> {
  if (voiceRecorder !== null) {
    await transcribeCapturedVoice(voiceRecorder);
    return;
  }
  const settings = await getSettings();
  if (!requireToken(settings, teachingStatus)) return;
  const recorder = new VoiceRecorder();
  try {
    await recorder.start();
  } catch (error) {
    showStatus(teachingStatus, voiceCaptureFailureText(error), "error");
    return;
  }
  voiceRecorder = recorder;
  recordButton.textContent = "Stop recording";
  recordingIndicator.hidden = false;
  showStatus(teachingStatus, "Recording. Speak, then press Stop recording.");
}

function resetTranscriptReview(): void {
  transcriptInput.value = "";
  voiceResult.hidden = true;
}

async function handleConfirmTranscriptClick(): Promise<void> {
  const transcript = transcriptInput.value.trim();
  if (transcript === "") {
    showStatus(teachingStatus, "The transcript is empty. Edit it or discard and record again.", "error");
    return;
  }
  const settings = await getSettings();
  if (!requireToken(settings, teachingStatus)) return;
  try {
    const draft = await createTeachingDraft(settings, { source: "voice", transcript });
    resetTranscriptReview();
    showStatus(teachingStatus, `Draft ${draft.id.slice(0, 8)} is pending. Confirm it in the teaching console.`);
  } catch (error) {
    showStatus(teachingStatus, requestFailureText(error), "error");
  }
}

// Rehearsal start for the posting open in the current tab.

async function handleStartRehearsalClick(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const postingUrl = tab?.url !== undefined && /^https?:\/\//i.test(tab.url) ? tab.url : undefined;
  const response = (await requestCoordinator({
    type: "dex-ai:start-rehearsal",
    postingUrl,
  })) as StartRehearsalResponse;
  if (!response.ok) {
    showStatus(rehearsalStatus, response.error, "error");
    return;
  }
  const rehearsal = response.rehearsal;
  showStatus(
    rehearsalStatus,
    `Rehearsal ${rehearsal.id.slice(0, 8)} is ${rehearsal.status}. Watch proposed actions in the rehearsal observer.`,
  );
}

// Job match for the posting open in the current tab.

function renderMatchReasons(result: JobMatchResponse): void {
  const lines = [
    ...result.matched.map((signal) => `Matches ${signal.key}: ${signal.terms.join(", ")}`),
    ...result.missed.map((signal) => `Missing ${signal.key}: ${signal.terms.join(", ")}`),
  ];
  matchReasons.replaceChildren(
    ...lines.map((line) => {
      const item = document.createElement("li");
      item.textContent = line;
      return item;
    }),
  );
  matchReasons.hidden = lines.length === 0;
}

async function handleCheckMatchClick(): Promise<void> {
  const settings = await getSettings();
  if (!requireToken(settings, matchStatus)) return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    showStatus(matchStatus, "No active tab to score", "error");
    return;
  }
  try {
    const posting = (await browser.tabs.sendMessage(tab.id, { type: READ_POSTING_MESSAGE_TYPE })) as PostingText;
    const result = await postJobMatch(settings, posting);
    const summary = result.score === null
      ? "No preferences or criteria learned yet. Observe sessions and run inference first."
      : `Match ${result.score}% (${result.matched.length} of ${result.matched.length + result.missed.length} signals)`;
    showStatus(matchStatus, summary);
    renderMatchReasons(result);
  } catch (error) {
    showStatus(matchStatus, requestFailureText(error), "error");
  }
}

settingsForm.addEventListener("submit", (event) => {
  void handleSettingsSubmit(event);
});
createDraftButton.addEventListener("click", () => {
  void handleCreateDraftClick();
});
recordButton.addEventListener("click", () => {
  void handleRecordButtonClick();
});
confirmTranscriptButton.addEventListener("click", () => {
  void handleConfirmTranscriptClick();
});
discardTranscriptButton.addEventListener("click", resetTranscriptReview);
checkMatchButton.addEventListener("click", () => {
  void handleCheckMatchClick();
});
startRehearsalButton.addEventListener("click", () => {
  void handleStartRehearsalClick();
});

void loadCurrentSettings();
