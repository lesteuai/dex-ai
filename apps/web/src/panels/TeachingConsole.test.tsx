// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SessionSummary, SessionTimelineItem, TeachingDraft } from "@dex-ai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "../api/client";
import { TeachingConsole } from "./TeachingConsole";

const TOKEN = "t".repeat(64);
const TYPED_TEACHING = "Prefer remote roles and skip postings without a salary.";
const TEACHING_TASK_ID = "44444444-4444-4444-8444-444444444444";
const VOICE_TRANSCRIPT = "Prefer remote roles over hybrid ones.";

const SESSION: SessionSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  browserKind: "chrome",
  sourceUrl: "https://jobs.example.com/search",
  postingUrl: null,
  status: "active",
  startedAt: "2026-11-21T10:00:00Z",
  endedAt: null,
};

function pendingVoiceDraft(id: string, transcript: string): TeachingDraft {
  return { id, source: "voice", transcript, status: "pending", sessionId: null, createdAt: "2026-11-21T10:05:00Z" };
}

const KEEP_DRAFT = pendingVoiceDraft("99999999-9999-4999-8999-999999999991", "Always attach a cover letter when the posting allows one.");
const DROP_DRAFT = pendingVoiceDraft("99999999-9999-4999-8999-999999999992", "Ignore postings older than thirty days.");
const EDITABLE_DRAFT = pendingVoiceDraft("99999999-9999-4999-8999-999999999993", "Skip unpaid trial tasks entirely.");

const TEACHING_TRACE_ITEM: SessionTimelineItem = {
  kind: "trace",
  trace: {
    id: "55555555-5555-4555-8555-555555555555",
    taskId: TEACHING_TASK_ID,
    sessionId: SESSION.id,
    eventId: null,
    step: 3,
    reasoning: "Weighed the teaching against the existing remote-work rule.",
    confidence: 0.8,
    createdAt: "2026-11-21T10:06:40Z",
  },
};

const LATEST_TRACE_ITEM: SessionTimelineItem = {
  kind: "trace",
  trace: {
    id: "33333333-3333-4333-8333-333333333333",
    taskId: null,
    sessionId: SESSION.id,
    eventId: null,
    step: 1,
    reasoning: "Observed several remote postings during the last session.",
    confidence: null,
    createdAt: "2026-11-21T10:00:40Z",
  },
};

function teachingRunResponse(
  status: "completed" | "failed" | "cancelled",
  taskId: string,
): { taskId: string; status: string; eventId: string; draft: null } {
  return { taskId, status, eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", draft: null };
}

type MockClientOptions = {
  sessions: () => SessionSummary[];
  drafts: () => TeachingDraft[];
  timelineFor?: (sessionId: string) => SessionTimelineItem[];
  onPost: (path: string, body?: unknown) => Promise<unknown>;
};

function createMockClient(options: MockClientOptions): {
  client: ApiClient;
  post: ReturnType<typeof vi.fn>;
} {
  const timelineFor = options.timelineFor ?? (() => []);
  // Bare vi.fn keeps the mocks assignable to the generic get and post methods.
  const get = vi.fn();
  get.mockImplementation(async (path: string) => {
    if (path === "/teaching/drafts") return { drafts: options.drafts() };
    throw new Error(`Unexpected GET ${path}`);
  });
  const post = vi.fn();
  post.mockImplementation(async (path: string, body?: unknown) => options.onPost(path, body));
  const getSession = vi.fn(async (sessionId: string) => {
    const session = options.sessions().find((candidate) => candidate.id === sessionId);
    if (session === undefined) throw new Error(`Unknown session ${sessionId}`);
    return { session, timeline: timelineFor(sessionId) };
  });
  const client: ApiClient = {
    get,
    post,
    patch: vi.fn(),
    getHealth: vi.fn(async () => ({ ok: true })),
    getSessions: vi.fn(async () => ({ sessions: options.sessions() })),
    getSession,
    getProfile: vi.fn(async () => ({ entries: [] })),
    getRules: vi.fn(async () => ({ rules: [] })),
    getRevisions: vi.fn(async () => ({ revisions: [] })),
  };
  return { client, post };
}

function rejectUnexpectedPost(): (path: string) => Promise<never> {
  return async (path: string) => {
    throw new Error(`Unexpected POST ${path}`);
  };
}

function renderPanel(client: ApiClient): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TeachingConsole client={client} token={TOKEN} />
    </QueryClientProvider>,
  );
}

/** Finds the draft card whose transcript textarea still holds the given text. */
function draftCardWithTranscript(transcript: string): HTMLElement {
  const card = screen.getAllByRole("listitem").find((item) => {
    const textarea = within(item).getByLabelText("Transcript, edit before teaching") as HTMLTextAreaElement;
    return textarea.value === transcript;
  });
  if (card === undefined) throw new Error(`No draft card holds the transcript "${transcript}"`);
  return card;
}

function stubMediaDevices(getUserMedia: (() => Promise<unknown>) | undefined): void {
  Object.defineProperty(window.navigator, "mediaDevices", {
    ...(getUserMedia === undefined ? {} : { value: { getUserMedia } }),
    configurable: true,
  });
}

type FakeProcessorNode = {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null;
  connect: () => void;
  disconnect: () => void;
};

/** Installs a fake mic and Web Audio graph so the panel records synthetic PCM. */
function installVoiceCapture(sampleRateHz = 48000): { pushSamples: (samples: number[]) => void } {
  let processor: FakeProcessorNode | null = null;
  class FakeAudioContext {
    readonly sampleRate = sampleRateHz;
    readonly destination = {};
    createMediaStreamSource(): { connect: () => void } {
      return { connect: vi.fn() };
    }
    createScriptProcessor(): FakeProcessorNode {
      const node: FakeProcessorNode = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() };
      processor = node;
      return node;
    }
    createGain(): { gain: { value: number }; connect: () => void } {
      return { gain: { value: 1 }, connect: vi.fn() };
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  stubMediaDevices(vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })));
  return {
    pushSamples: (samples: number[]) => {
      processor?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(samples) },
      } as unknown as AudioProcessingEvent);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window.navigator as { mediaDevices?: MediaDevices }).mediaDevices;
});

describe("TeachingConsole", () => {
  it("submits typed teaching with the trimmed text and the attached session", async () => {
    const { client, post } = createMockClient({
      sessions: () => [SESSION],
      drafts: () => [],
      onPost: async (path) => {
        if (path === "/teaching") return teachingRunResponse("completed", TEACHING_TASK_ID);
        throw new Error(`Unexpected POST ${path}`);
      },
    });
    renderPanel(client);

    const input = await screen.findByLabelText("What should Dex AI learn from you?");
    fireEvent.change(input, { target: { value: `  ${TYPED_TEACHING}  ` } });
    fireEvent.click(screen.getByRole("button", { name: "Teach" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/teaching", { text: TYPED_TEACHING, sessionId: SESSION.id }),
    );
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
  });

  it("confirms a voice draft only after an explicit click and discards another draft", async () => {
    const drafts = [KEEP_DRAFT, DROP_DRAFT];
    const { client, post } = createMockClient({
      sessions: () => [SESSION],
      drafts: () => drafts.filter((draft) => draft.status === "pending"),
      onPost: async (path, body) => {
        if (path === "/teaching") {
          const request = body as { draftId: string };
          const draft = drafts.find((candidate) => candidate.id === request.draftId);
          if (draft === undefined) throw new Error(`Unknown draft ${request.draftId}`);
          draft.status = "confirmed";
          return teachingRunResponse("completed", TEACHING_TASK_ID);
        }
        if (path === `/teaching/drafts/${DROP_DRAFT.id}/discard`) {
          DROP_DRAFT.status = "discarded";
          return { draft: DROP_DRAFT };
        }
        throw new Error(`Unexpected POST ${path}`);
      },
    });
    renderPanel(client);

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(post).not.toHaveBeenCalledWith("/teaching", expect.anything());

    fireEvent.click(
      within(draftCardWithTranscript(KEEP_DRAFT.transcript)).getByRole("button", { name: "Confirm and teach" }),
    );

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/teaching", {
        draftId: KEEP_DRAFT.id,
        text: KEEP_DRAFT.transcript,
        sessionId: SESSION.id,
      }),
    );
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));

    fireEvent.click(
      within(draftCardWithTranscript(DROP_DRAFT.transcript)).getByRole("button", { name: "Discard" }),
    );

    await waitFor(() => expect(post).toHaveBeenCalledWith(`/teaching/drafts/${DROP_DRAFT.id}/discard`));
    expect(await screen.findByText(/No pending drafts/)).toBeTruthy();
  });

  it("sends the edited transcript when a draft is confirmed", async () => {
    const EDITED_TEXT = "Skip unpaid trial tasks and unpaid sample work.";
    const { client, post } = createMockClient({
      sessions: () => [SESSION],
      drafts: () => [EDITABLE_DRAFT],
      onPost: async (path) => {
        if (path === "/teaching") return teachingRunResponse("completed", TEACHING_TASK_ID);
        throw new Error(`Unexpected POST ${path}`);
      },
    });
    renderPanel(client);

    const transcript = await screen.findByLabelText("Transcript, edit before teaching");
    expect((transcript as HTMLTextAreaElement).value).toBe(EDITABLE_DRAFT.transcript);
    fireEvent.change(transcript, { target: { value: `  ${EDITED_TEXT}  ` } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm and teach" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/teaching", {
        draftId: EDITABLE_DRAFT.id,
        text: EDITED_TEXT,
        sessionId: SESSION.id,
      }),
    );
  });

  it("explains when the browser exposes no microphone capture and keeps typed teaching usable", async () => {
    stubMediaDevices(undefined);
    const { client } = createMockClient({
      sessions: () => [SESSION],
      drafts: () => [],
      onPost: rejectUnexpectedPost(),
    });
    renderPanel(client);

    fireEvent.click(await screen.findByRole("button", { name: "Record voice teaching" }));

    expect(await screen.findByText(/This browser does not expose microphone capture/)).toBeTruthy();
    expect(screen.getByText(/Typed teaching above stays fully usable/)).toBeTruthy();
    expect(screen.getByLabelText("What should Dex AI learn from you?")).toBeTruthy();
  });

  it("explains when microphone permission is denied", async () => {
    stubMediaDevices(
      vi.fn(async () => {
        throw new DOMException("Permission denied", "NotAllowedError");
      }),
    );
    const { client } = createMockClient({
      sessions: () => [SESSION],
      drafts: () => [],
      onPost: rejectUnexpectedPost(),
    });
    renderPanel(client);

    fireEvent.click(await screen.findByRole("button", { name: "Record voice teaching" }));

    expect(await screen.findByText(/Microphone permission was denied/)).toBeTruthy();
    expect(screen.getByLabelText("What should Dex AI learn from you?")).toBeTruthy();
  });

  it("keeps the typed text when the teaching run fails", async () => {
    const { client } = createMockClient({
      sessions: () => [SESSION],
      drafts: () => [],
      onPost: async (path) => {
        if (path === "/teaching") throw new ApiError(500, "The configured provider rejected the teaching run.");
        throw new Error(`Unexpected POST ${path}`);
      },
    });
    renderPanel(client);

    const input = await screen.findByLabelText("What should Dex AI learn from you?");
    fireEvent.change(input, { target: { value: TYPED_TEACHING } });
    fireEvent.click(screen.getByRole("button", { name: "Teach" }));

    expect(await screen.findByText("Teaching failed. Completed work is kept.")).toBeTruthy();
    expect(screen.getByText("The configured provider rejected the teaching run.")).toBeTruthy();
    expect(screen.getByText(/The transcript stays pending/)).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe(TYPED_TEACHING);
    expect((screen.getByRole("button", { name: "Teach" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the draft pending when confirming it fails", async () => {
    const { client } = createMockClient({
      sessions: () => [SESSION],
      drafts: () => [EDITABLE_DRAFT],
      onPost: async (path) => {
        if (path === "/teaching") throw new ApiError(503, "The teaching agent could not start.");
        throw new Error(`Unexpected POST ${path}`);
      },
    });
    renderPanel(client);

    await screen.findByLabelText("Transcript, edit before teaching");
    fireEvent.click(screen.getByRole("button", { name: "Confirm and teach" }));

    expect(await screen.findByText("Teaching failed. Completed work is kept.")).toBeTruthy();
    expect(screen.getByText("The teaching agent could not start.")).toBeTruthy();
    expect(
      (screen.getByLabelText("Transcript, edit before teaching") as HTMLTextAreaElement).value,
    ).toBe(EDITABLE_DRAFT.transcript);
    expect((screen.getByRole("button", { name: "Confirm and teach" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the agent status and the reasoning trace of the last run", async () => {
    let runCount = 0;
    const { client } = createMockClient({
      sessions: () => [SESSION],
      drafts: () => [],
      timelineFor: () => [TEACHING_TRACE_ITEM, LATEST_TRACE_ITEM],
      onPost: async (path) => {
        if (path === "/teaching") {
          runCount += 1;
          return runCount === 1
            ? teachingRunResponse("completed", TEACHING_TASK_ID)
            : teachingRunResponse("cancelled", TEACHING_TASK_ID);
        }
        throw new Error(`Unexpected POST ${path}`);
      },
    });
    renderPanel(client);

    expect(await screen.findByText("The teaching agent is idle.")).toBeTruthy();
    expect(await screen.findByText("Observed several remote postings during the last session.")).toBeTruthy();

    const input = screen.getByLabelText("What should Dex AI learn from you?");
    fireEvent.change(input, { target: { value: TYPED_TEACHING } });
    fireEvent.click(screen.getByRole("button", { name: "Teach" }));

    expect(await screen.findByText("Teaching completed and the transcript became a teaching event.")).toBeTruthy();
    expect(screen.getByText(/Trace for task/).textContent).toContain(TEACHING_TASK_ID);
    expect(screen.getByText("Weighed the teaching against the existing remote-work rule.")).toBeTruthy();
    expect(screen.queryByText("Observed several remote postings during the last session.")).toBeNull();

    fireEvent.change(input, { target: { value: "Also skip unpaid trial tasks." } });
    fireEvent.click(screen.getByRole("button", { name: "Teach" }));

    expect(await screen.findByText("Teaching was cancelled. Completed work is kept.")).toBeTruthy();
  });

  it("transcribes a local recording into a pending draft and teaches only after confirmation", async () => {
    const createdDrafts: TeachingDraft[] = [];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: `  ${VOICE_TRANSCRIPT}  ` }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const voiceCapture = installVoiceCapture();
    const { client, post } = createMockClient({
      sessions: () => [SESSION],
      drafts: () => createdDrafts.filter((draft) => draft.status === "pending"),
      onPost: async (path, body) => {
        if (path === "/teaching/drafts") {
          const request = body as { source: string; transcript: string; sessionId?: string };
          const draft = pendingVoiceDraft("99999999-9999-4999-8999-999999999994", request.transcript);
          createdDrafts.push(draft);
          return { draft };
        }
        if (path === "/teaching") return teachingRunResponse("completed", TEACHING_TASK_ID);
        throw new Error(`Unexpected POST ${path}`);
      },
    });
    renderPanel(client);

    fireEvent.click(await screen.findByRole("button", { name: "Record voice teaching" }));
    await screen.findByRole("button", { name: "Stop and transcribe locally" });
    voiceCapture.pushSamples([0.5, -0.25, 0.125]);
    fireEvent.click(screen.getByRole("button", { name: "Stop and transcribe locally" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/stt/transcribe", expect.objectContaining({
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "audio/wav" },
      body: expect.any(ArrayBuffer),
    }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/teaching/drafts", {
        source: "voice",
        transcript: VOICE_TRANSCRIPT,
        sessionId: SESSION.id,
      }),
    );

    const card = await screen.findByRole("listitem");
    expect(post).not.toHaveBeenCalledWith("/teaching", expect.anything());
    expect(
      (within(card).getByLabelText("Transcript, edit before teaching") as HTMLTextAreaElement).value,
    ).toBe(VOICE_TRANSCRIPT);

    fireEvent.click(within(card).getByRole("button", { name: "Confirm and teach" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/teaching", {
        draftId: "99999999-9999-4999-8999-999999999994",
        text: VOICE_TRANSCRIPT,
        sessionId: SESSION.id,
      }),
    );
    expect(await screen.findByText("Teaching completed and the transcript became a teaching event.")).toBeTruthy();
  });

  it("explains when the local speech model is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    const voiceCapture = installVoiceCapture();
    const { client } = createMockClient({
      sessions: () => [SESSION],
      drafts: () => [],
      onPost: rejectUnexpectedPost(),
    });
    renderPanel(client);

    fireEvent.click(await screen.findByRole("button", { name: "Record voice teaching" }));
    await screen.findByRole("button", { name: "Stop and transcribe locally" });
    voiceCapture.pushSamples([0.5, -0.25]);
    fireEvent.click(screen.getByRole("button", { name: "Stop and transcribe locally" }));

    expect(await screen.findByText(/The local speech model is unavailable/)).toBeTruthy();
    expect(screen.getByText(/Typed teaching below stays fully usable/)).toBeTruthy();
    expect(screen.getByLabelText("What should Dex AI learn from you?")).toBeTruthy();
  });
});
