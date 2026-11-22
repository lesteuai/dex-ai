// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  draftResponse,
  jsonResponse,
  sttResponse,
  TEST_DRAFT,
  TEST_REHEARSAL,
} from "../testing/fixtures";
import { FakeAudioContext, audioChunkEvent, fakeStream } from "../testing/webaudio";

/**
 * Popup behavior tests. The real popup markup from index.html is loaded into
 * a happy-dom document, the background coordinator is a scripted message
 * responder, and fetch, getUserMedia and Web Audio are mocked, so no control
 * plane and no real browser are involved.
 */

const CONTROL_PLANE = { baseUrl: "http://127.0.0.1:8787", token: "token-123" };

const polyfill = vi.hoisted(() => {
  const sentMessages: unknown[] = [];
  let tabs: Array<{ url?: string }> = [];
  let respond: (message: unknown) => unknown = () => undefined;

  const browser = {
    runtime: {
      sendMessage: async (message: unknown): Promise<unknown> => {
        sentMessages.push(message);
        return respond(message);
      },
    },
    tabs: {
      query: async (): Promise<Array<{ url?: string }>> => tabs,
    },
  };

  return {
    browser,
    sentMessages,
    respondWith(next: (message: unknown) => unknown): void {
      respond = next;
    },
    setTabs(next: Array<{ url?: string }>): void {
      tabs = next;
    },
    reset(): void {
      sentMessages.length = 0;
      tabs = [];
      respond = () => undefined;
    },
  };
});

vi.mock("webextension-polyfill", () => ({ default: polyfill.browser }));

function defaultCoordinatorResponse(message: unknown): unknown {
  const type = (message as { type?: string }).type;
  if (type === "dex-ai:get-settings") return { ...CONTROL_PLANE };
  if (type === "dex-ai:set-settings") return { ok: true };
  if (type === "dex-ai:start-rehearsal") return { ok: true, rehearsal: TEST_REHEARSAL };
  return undefined;
}

const popupHtml = readFileSync(
  join(fileURLToPath(import.meta.url), "..", "index.html"),
  "utf8",
);
const mainHtml = /<main class="popup">[\s\S]*<\/main>/.exec(popupHtml)?.[0];
if (mainHtml === undefined) {
  throw new Error("popup <main> markup was not found in index.html");
}

let fetchMock: ReturnType<typeof vi.fn>;
let getUserMediaMock: Mock<(...args: unknown[]) => Promise<unknown>>;

beforeEach(async () => {
  document.body.innerHTML = mainHtml;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  getUserMediaMock = vi.fn();
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: (...args: unknown[]) => getUserMediaMock(...args) },
  });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  FakeAudioContext.instances.length = 0;
  FakeAudioContext.sampleRate = 48000;
  polyfill.reset();
  polyfill.respondWith(defaultCoordinatorResponse);
  vi.resetModules();
  await import("./main");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`popup element is missing: ${id}`);
  return found as T;
};

const clickButton = (id: string): void => element<HTMLButtonElement>(id).click();

async function settleMicrotasks(): Promise<void> {
  for (let step = 0; step < 25; step += 1) await Promise.resolve();
}

function submitSettingsForm(): void {
  element<HTMLFormElement>("settings-form").dispatchEvent(
    new SubmitEvent("submit", { bubbles: true, cancelable: true }),
  );
}

/** Record, feed constant 0.5 samples at 48 kHz, and leave the recorder live. */
async function startVoiceCapture(): Promise<void> {
  getUserMediaMock.mockResolvedValue(fakeStream() as unknown as MediaStream);
  clickButton("record-button");
  await settleMicrotasks();
  const context = FakeAudioContext.instances.at(-1);
  if (context === undefined) throw new Error("no audio context was created");
  context.processor.onaudioprocess?.(audioChunkEvent([new Array<number>(48).fill(0.5)]));
}

async function stopVoiceCapture(): Promise<void> {
  clickButton("record-button");
  await settleMicrotasks();
}

describe("token setup", () => {
  it("saves the base URL and token through the background message channel", async () => {
    element<HTMLInputElement>("base-url-input").value = "http://127.0.0.1:8999";
    element<HTMLInputElement>("token-input").value = "token-abc";

    submitSettingsForm();
    await settleMicrotasks();

    expect(polyfill.sentMessages).toContainEqual({
      type: "dex-ai:set-settings",
      baseUrl: "http://127.0.0.1:8999",
      token: "token-abc",
    });
    expect(element("settings-status").textContent).toContain("Settings saved");
  });

  it("omits blank fields so an empty token input keeps the stored token", async () => {
    element<HTMLInputElement>("base-url-input").value = "http://127.0.0.1:8999";
    element<HTMLInputElement>("token-input").value = "";

    submitSettingsForm();
    await settleMicrotasks();

    expect(polyfill.sentMessages).toContainEqual({
      type: "dex-ai:set-settings",
      baseUrl: "http://127.0.0.1:8999",
    });
  });

  it("shows the coordinator error when the save is rejected", async () => {
    polyfill.respondWith((message) =>
      (message as { type?: string }).type === "dex-ai:set-settings"
        ? { ok: false, error: "The control plane rejected the token" }
        : defaultCoordinatorResponse(message),
    );
    element<HTMLInputElement>("token-input").value = "token-bad";

    submitSettingsForm();
    await settleMicrotasks();

    const status = element("settings-status");
    expect(status.textContent).toContain("The control plane rejected the token");
    expect(status.classList.contains("error")).toBe(true);
  });
});

describe("typed teaching", () => {
  it("posts a text draft with the bearer token and shows it pending", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, draftResponse(TEST_DRAFT)));
    element<HTMLTextAreaElement>("typed-teaching-input").value = "  Always mention the gap year.  ";

    clickButton("create-draft-button");
    await settleMicrotasks();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/teaching/drafts");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer token-123",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      source: "text",
      transcript: "Always mention the gap year.",
    });
    expect(element("teaching-status").textContent).toContain("Draft 55555555 is pending");
    expect(element<HTMLTextAreaElement>("typed-teaching-input").value).toBe("");
  });

  it("refuses to create a draft without a stored token", async () => {
    polyfill.respondWith((message) =>
      (message as { type?: string }).type === "dex-ai:get-settings"
        ? { baseUrl: CONTROL_PLANE.baseUrl, token: null }
        : defaultCoordinatorResponse(message),
    );
    element<HTMLTextAreaElement>("typed-teaching-input").value = "Teaching without a token";

    clickButton("create-draft-button");
    await settleMicrotasks();

    expect(element("teaching-status").textContent).toContain("Save the control plane token");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("voice teaching", () => {
  it("keeps typed teaching available when the microphone is denied", async () => {
    getUserMediaMock.mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));
    clickButton("record-button");
    await settleMicrotasks();

    const status = element("teaching-status");
    expect(status.textContent).toMatch(/typed teaching/i);
    expect(status.classList.contains("error")).toBe(true);

    fetchMock.mockResolvedValue(jsonResponse(200, draftResponse(TEST_DRAFT)));
    element<HTMLTextAreaElement>("typed-teaching-input").value = "Typed teaching still works";
    clickButton("create-draft-button");
    await settleMicrotasks();

    // Only the typed draft was sent; no audio ever left the device.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(element("teaching-status").textContent).toContain("Draft 55555555 is pending");
  });

  it("sends the bearer token and the WAV body to the loopback control plane only", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, sttResponse("  Always proofread the profile section.  ")),
    );

    await startVoiceCapture();
    await stopVoiceCapture();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/stt/transcribe");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer token-123",
      "content-type": "audio/wav",
    });
    // The body is the captured audio as a 16 kHz mono 16-bit WAV.
    const wav = init.body as ArrayBuffer;
    const view = new DataView(wav);
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1))).toBe("RI");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(32);

    // The trimmed transcript is shown for confirmation before any teaching event.
    expect(element<HTMLTextAreaElement>("transcript-input").value).toBe(
      "Always proofread the profile section.",
    );
    expect(element("voice-result").hidden).toBe(false);
    expect(element("teaching-status").textContent).toContain("Review and edit the transcript");
  });

  it("creates a voice draft from the confirmed transcript on the loopback control plane", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, sttResponse("Original transcript words")))
      .mockResolvedValueOnce(jsonResponse(200, draftResponse(TEST_DRAFT)));
    await startVoiceCapture();
    await stopVoiceCapture();

    element<HTMLTextAreaElement>("transcript-input").value = "Edited transcript words";
    clickButton("confirm-transcript-button");
    await settleMicrotasks();

    // Every request stayed on the loopback control plane; no audio or
    // transcript reached a remote recognition service.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [callUrl] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(callUrl.startsWith(`${CONTROL_PLANE.baseUrl}/`)).toBe(true);
    }
    const [draftUrl, draftInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(draftUrl).toBe("http://127.0.0.1:8787/api/teaching/drafts");
    expect((draftInit.headers as Record<string, string>).authorization).toBe("Bearer token-123");
    expect(JSON.parse(draftInit.body as string)).toEqual({
      source: "voice",
      transcript: "Edited transcript words",
    });

    // The review area resets after the draft is stored.
    expect(element("voice-result").hidden).toBe(true);
    expect(element<HTMLTextAreaElement>("transcript-input").value).toBe("");
    expect(element("teaching-status").textContent).toContain("Draft 55555555 is pending");
  });

  it("refuses to confirm an empty transcript", async () => {
    clickButton("confirm-transcript-button");
    await settleMicrotasks();

    expect(element("teaching-status").textContent).toContain("The transcript is empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps typed teaching usable when the local speech model is unavailable", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(503, { error: "SttUnavailable", message: "Parakeet is not running" }),
    );

    await startVoiceCapture();
    await stopVoiceCapture();

    const status = element("teaching-status");
    expect(status.textContent).toContain("local speech model is unavailable");
    expect(status.textContent).toContain("Typed teaching remains available");
    expect(element("voice-result").hidden).toBe(true);

    fetchMock.mockResolvedValue(jsonResponse(200, draftResponse(TEST_DRAFT)));
    element<HTMLTextAreaElement>("typed-teaching-input").value = "Typed fallback teaching";
    clickButton("create-draft-button");
    await settleMicrotasks();

    expect(element("teaching-status").textContent).toContain("Draft 55555555 is pending");
  });

  it("asks to record again or type when the local model returns no speech", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, sttResponse("   ")));

    await startVoiceCapture();
    await stopVoiceCapture();

    const status = element("teaching-status");
    expect(status.textContent).toContain("No speech was recognized");
    expect(status.textContent).toMatch(/record again or type/i);
    expect(element("voice-result").hidden).toBe(true);
  });
});

describe("rehearsal start", () => {
  it("sends the active tab URL to the coordinator and shows the started rehearsal", async () => {
    polyfill.setTabs([{ url: "https://jobs.example.test/postings/1" }]);

    clickButton("start-rehearsal-button");
    await settleMicrotasks();

    expect(polyfill.sentMessages).toContainEqual({
      type: "dex-ai:start-rehearsal",
      postingUrl: "https://jobs.example.test/postings/1",
      autoMode: false,
    });
    expect(element("rehearsal-status").textContent).toContain("Rehearsal 44444444 is paused");
  });

  it("drops a non-http tab URL instead of passing it along", async () => {
    polyfill.setTabs([{ url: "chrome-extension://abcdef/popup.html" }]);

    clickButton("start-rehearsal-button");
    await settleMicrotasks();

    const message = polyfill.sentMessages.at(-1) as { type: string; postingUrl?: string };
    expect(message.type).toBe("dex-ai:start-rehearsal");
    expect(message.postingUrl).toBeUndefined();
  });

  it("shows the coordinator error when the rehearsal start is refused", async () => {
    polyfill.respondWith((message) =>
      (message as { type?: string }).type === "dex-ai:start-rehearsal"
        ? { ok: false, error: "No control plane token is stored" }
        : defaultCoordinatorResponse(message),
    );

    clickButton("start-rehearsal-button");
    await settleMicrotasks();

    expect(element("rehearsal-status").textContent).toContain("No control plane token is stored");
    expect(element("rehearsal-status").classList.contains("error")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
