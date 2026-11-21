import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  ApplyTeachingRequest,
  SessionSummary,
  TeachingDraft,
} from "@dex-ai/shared";
import { ApiError, type ApiClient, queryKeys } from "../api/client";

/** The STT route takes a raw WAV body, which the JSON client cannot carry. */
const STT_TRANSCRIBE_PATH = "/api/stt/transcribe";
const TARGET_SAMPLE_RATE_HZ = 16000;
const WAV_HEADER_BYTES = 44;
const PCM_FORMAT = 1;
const MONO_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const RECORDER_CHUNK_SAMPLES = 4096;
const MIC_PERMISSION_ERROR_NAMES = ["NotAllowedError", "SecurityError", "PermissionDeniedError"];

export type TeachingConsoleProps = {
  client: ApiClient;
  /** Bearer token for the raw transcription request only. */
  token: string;
};

type TeachingRunStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

type TeachingRun = {
  status: TeachingRunStatus;
  taskId: string | null;
  message: string | null;
};

type TeachingRunResponse = {
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  eventId: string;
  draft: TeachingDraft | null;
};

type VoiceCapturePhase = "idle" | "recording" | "transcribing" | "unavailable";

type VoiceCapture = {
  phase: VoiceCapturePhase;
  message: string | null;
};

type ActiveRecording = {
  audioContext: AudioContext;
  stream: MediaStream;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
};

type DraftCardProps = {
  draft: TeachingDraft;
  fallbackSessionId: string | null;
  busy: boolean;
  onConfirm: (request: ApplyTeachingRequest) => void;
  onDiscard: (draftId: string) => void;
};

const RUN_STATUS_LABELS: Record<TeachingRunStatus, string> = {
  idle: "The teaching agent is idle.",
  running: "The teaching agent is running through your configured provider.",
  completed: "Teaching completed and the transcript became a teaching event.",
  failed: "Teaching failed. Completed work is kept.",
  cancelled: "Teaching was cancelled. Completed work is kept.",
};

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

function sessionOptionLabel(session: SessionSummary): string {
  const activity = session.status === "active" ? "live" : "ended";
  return `${session.browserKind} session, ${activity}, started ${formatTimestamp(session.startedAt)}`;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/** Linear resample of mono PCM into the 16 kHz rate the local recognizer needs. */
function resampleTo16kHz(samples: Float32Array, sourceRateHz: number): Float32Array {
  if (samples.length === 0 || sourceRateHz === TARGET_SAMPLE_RATE_HZ) return samples;
  const targetLength = Math.max(1, Math.floor((samples.length * TARGET_SAMPLE_RATE_HZ) / sourceRateHz));
  const resampled = new Float32Array(targetLength);
  for (let i = 0; i < targetLength; i++) {
    const sourcePosition = (i * sourceRateHz) / TARGET_SAMPLE_RATE_HZ;
    const left = Math.floor(sourcePosition);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = sourcePosition - left;
    resampled[i] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return resampled;
}

function encodeMono16kHzWav(samples: Float32Array): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, MONO_CHANNELS, true);
  view.setUint32(24, TARGET_SAMPLE_RATE_HZ, true);
  view.setUint32(28, TARGET_SAMPLE_RATE_HZ * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/** Tears the recording graph down and returns the captured mono PCM. */
function stopRecording(recording: ActiveRecording): { samples: Float32Array; sampleRate: number } {
  const { audioContext, stream, processor } = recording;
  const sampleRate = audioContext.sampleRate;
  processor.disconnect();
  void audioContext.close();
  for (const track of stream.getTracks()) track.stop();
  let total = 0;
  for (const chunk of recording.chunks) total += chunk.length;
  const samples = new Float32Array(total);
  let offset = 0;
  for (const chunk of recording.chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return { samples, sampleRate };
}

function isMicPermissionError(error: unknown): boolean {
  return error instanceof DOMException && MIC_PERMISSION_ERROR_NAMES.includes(error.name);
}

async function transcribeWav(token: string, wav: ArrayBuffer): Promise<{ text: string } | { error: string }> {
  let response: Response;
  try {
    response = await fetch(STT_TRANSCRIBE_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "audio/wav" },
      body: wav,
    });
  } catch {
    return {
      error: "Voice transcription could not reach the local control plane. Typed teaching below stays fully usable.",
    };
  }
  if (response.status === 503) {
    return {
      error:
        "The local speech model is unavailable, so voice teaching is disabled here. Typed teaching below stays fully usable.",
    };
  }
  if (!response.ok) {
    return {
      error: `Local transcription failed with status ${response.status}. Typed teaching below stays fully usable.`,
    };
  }
  try {
    const body = (await response.json()) as { text?: string };
    return { text: (body.text ?? "").trim() };
  } catch {
    return { error: "The local transcription response was unreadable. Typed teaching below stays fully usable." };
  }
}

/**
 * One pending voice draft with an editable transcript. The transcript becomes
 * a teaching event only when the user presses Confirm and teach.
 */
function DraftCard({ draft, fallbackSessionId, busy, onConfirm, onDiscard }: DraftCardProps) {
  const [transcript, setTranscript] = useState(draft.transcript);
  const sessionForDraft = draft.sessionId ?? fallbackSessionId;
  const trimmed = transcript.trim();

  return (
    <li className="teaching-draft">
      <p className="teaching-draft-meta">
        Voice draft captured {formatTimestamp(draft.createdAt)}
        {draft.sessionId === null ? " without a session" : ""}
      </p>
      <label htmlFor={`teaching-draft-${draft.id}`}>Transcript, edit before teaching</label>
      <textarea
        id={`teaching-draft-${draft.id}`} rows={3} value={transcript}
        onChange={(event) => setTranscript(event.target.value)}
      />
      <div className="teaching-draft-actions">
        <button
          type="button" disabled={busy || trimmed === "" || sessionForDraft === null}
          onClick={() =>
            onConfirm({
              draftId: draft.id,
              text: trimmed,
              sessionId: sessionForDraft ?? undefined,
            })
          }
        >
          Confirm and teach
        </button>
        <button type="button" disabled={busy} onClick={() => onDiscard(draft.id)}>
          Discard
        </button>
      </div>
    </li>
  );
}

/**
 * Reasoning trace of the selected session, refreshed by the stream's
 * trace.started, trace.completed and task.failed invalidations. The trace of
 * the last run's task is preferred over the newest stored trace.
 */
function TeachingTrace({
  client,
  session,
  taskId,
}: {
  client: ApiClient;
  session: SessionSummary;
  taskId: string | null;
}) {
  const sessionDetailQuery = useQuery({
    queryKey: queryKeys.session(session.id),
    queryFn: () => client.getSession(session.id),
  });
  const traces = (sessionDetailQuery.data?.timeline ?? []).flatMap((item) =>
    item.kind === "trace" ? [item.trace] : [],
  );
  const latestTrace = traces.length === 0 ? null : traces[traces.length - 1];
  const shownTrace = taskId === null ? latestTrace : traces.find((trace) => trace.taskId === taskId) ?? latestTrace;

  return (
    <section className="teaching-trace" aria-label="Reasoning trace">
      <h3>Reasoning trace</h3>
      {sessionDetailQuery.isPending ? (
        <p className="teaching-note">Loading the reasoning trace.</p>
      ) : sessionDetailQuery.isError ? (
        <p className="teaching-error" role="alert">
          Could not load the reasoning trace: {sessionDetailQuery.error.message}
        </p>
      ) : shownTrace === null ? (
        <p className="teaching-note">No reasoning recorded for this session yet.</p>
      ) : (
        <article className="teaching-trace-entry">
          <p className="teaching-draft-meta">
            Trace for task {shownTrace.taskId} at {formatTimestamp(shownTrace.createdAt)}
          </p>
          {shownTrace.reasoning === null || shownTrace.reasoning === "" ? (
            <p className="teaching-note">The agent recorded no reasoning for this run.</p>
          ) : (
            <pre className="teaching-trace-reasoning">{shownTrace.reasoning}</pre>
          )}
        </article>
      )}
    </section>
  );
}

/**
 * Teaching console panel. Typed teaching, in-browser voice capture with local
 * transcription, pending draft confirmation and the teaching agent's status
 * and reasoning trace. When the browser blocks capture or the local speech
 * model is unavailable, the message says so and typed teaching stays usable.
 */
export function TeachingConsole({ client, token }: TeachingConsoleProps) {
  const queryClient = useQueryClient();
  const [typedText, setTypedText] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [run, setRun] = useState<TeachingRun>({ status: "idle", taskId: null, message: null });
  const [voice, setVoice] = useState<VoiceCapture>({ phase: "idle", message: null });
  const recordingRef = useRef<ActiveRecording | null>(null);

  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions,
    queryFn: () => client.getSessions(),
  });
  const draftsQuery = useQuery({
    queryKey: queryKeys.teachingDrafts,
    queryFn: () => client.get<{ drafts: TeachingDraft[] }>("/teaching/drafts"),
  });

  const sessions = sessionsQuery.data?.sessions ?? [];
  const sessionId = selectedSessionId ?? sessions[0]?.id ?? null;
  const session = sessions.find((candidate) => candidate.id === sessionId) ?? null;
  const drafts = draftsQuery.data?.drafts ?? [];

  function refreshTeachingState(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.teachingDrafts });
    void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
  }

  const applyTeachingMutation = useMutation({
    mutationFn: (request: ApplyTeachingRequest) => client.post<TeachingRunResponse>("/teaching", request),
    onMutate: () => {
      setRun({ status: "running", taskId: null, message: null });
    },
    onSuccess: (result, request) => {
      setRun({ status: result.status, taskId: result.taskId, message: null });
      if (request.draftId === undefined) setTypedText("");
      refreshTeachingState();
    },
    onError: (error: unknown) => {
      // A failed run leaves the source draft pending, so the transcript survives for retry.
      setRun({
        status: "failed",
        taskId: null,
        message: error instanceof ApiError ? error.message : "Teaching could not reach the control plane.",
      });
      refreshTeachingState();
    },
  });

  const discardMutation = useMutation({
    mutationFn: (draftId: string) => client.post<{ draft: TeachingDraft }>(`/teaching/drafts/${draftId}/discard`),
    onSuccess: () => refreshTeachingState(),
  });

  const createVoiceDraftMutation = useMutation({
    mutationFn: (transcript: string) =>
      client.post<{ draft: TeachingDraft }>("/teaching/drafts", {
        source: "voice",
        transcript,
        sessionId: sessionId ?? undefined,
      }),
    onSuccess: () => {
      setVoice({
        phase: "idle",
        message: "The transcript is saved below as a pending voice draft. Confirm it to teach.",
      });
      refreshTeachingState();
    },
    onError: (error: unknown) => {
      setVoice({
        phase: "unavailable",
        message: error instanceof ApiError ? error.message : "The voice draft could not be saved.",
      });
    },
  });

  useEffect(() => {
    return () => {
      if (recordingRef.current !== null) {
        stopRecording(recordingRef.current);
        recordingRef.current = null;
      }
    };
  }, []);

  function handleTypedSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = typedText.trim();
    if (text === "" || sessionId === null || applyTeachingMutation.isPending) return;
    applyTeachingMutation.mutate({ text, sessionId });
  }

  async function handleVoiceToggle(): Promise<void> {
    if (recordingRef.current !== null) {
      await finishVoiceRecording();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setVoice({
        phase: "unavailable",
        message:
          "This browser does not expose microphone capture, so voice teaching is unavailable here. Typed teaching above stays fully usable.",
      });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(RECORDER_CHUNK_SAMPLES, 1, 1);
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      // A zero-gain sink keeps onaudioprocess firing without echoing the mic.
      const sink = audioContext.createGain();
      sink.gain.value = 0;
      source.connect(processor);
      processor.connect(sink);
      sink.connect(audioContext.destination);
      recordingRef.current = { audioContext, stream, processor, chunks };
      setVoice({ phase: "recording", message: null });
    } catch (error) {
      setVoice({
        phase: "unavailable",
        message: isMicPermissionError(error)
          ? "Microphone permission was denied, so this browser blocks voice capture. Typed teaching above stays fully usable."
          : "Voice capture could not start. Typed teaching above stays fully usable.",
      });
    }
  }

  async function finishVoiceRecording(): Promise<void> {
    const recording = recordingRef.current;
    if (recording === null) return;
    recordingRef.current = null;
    const { samples, sampleRate } = stopRecording(recording);
    setVoice({ phase: "transcribing", message: null });
    const wav = encodeMono16kHzWav(resampleTo16kHz(samples, sampleRate));
    const result = await transcribeWav(token, wav);
    if ("error" in result) {
      setVoice({ phase: "unavailable", message: result.error });
      return;
    }
    if (result.text === "") {
      setVoice({
        phase: "unavailable",
        message: "No speech was recognized in the recording. Typed teaching above stays fully usable.",
      });
      return;
    }
    createVoiceDraftMutation.mutate(result.text);
  }

  const voiceBusy = voice.phase === "transcribing" || createVoiceDraftMutation.isPending;
  const teachingBusy = applyTeachingMutation.isPending || discardMutation.isPending;

  return (
    <section className="teaching-console" aria-label="Teaching console">
      <h2>Teaching Console</h2>

      <form className="teaching-form" onSubmit={(event) => handleTypedSubmit(event)}>
        <h3>Teach by text</h3>
        {sessions.length === 0 ? (
          <p className="teaching-note" role="note">
            Teaching attaches to an observed session. Open a job site with the Dex AI extension to create one;
            typed teaching unlocks as soon as a session exists.
          </p>
        ) : (
          <>
            <label htmlFor="teaching-session-select">Attach to session</label>
            <select
              id="teaching-session-select" value={sessionId ?? ""}
              onChange={(event) => setSelectedSessionId(event.target.value === "" ? null : event.target.value)}
            >
              {sessions.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {sessionOptionLabel(candidate)}
                </option>
              ))}
            </select>
          </>
        )}
        <label htmlFor="teaching-text-input">What should Dex AI learn from you?</label>
        <textarea
          id="teaching-text-input" rows={4} value={typedText}
          onChange={(event) => setTypedText(event.target.value)}
          placeholder="For example: always prefer remote roles and skip postings without a salary."
        />
        <button type="submit" disabled={applyTeachingMutation.isPending || typedText.trim() === "" || sessionId === null}>
          {applyTeachingMutation.isPending ? "Teaching..." : "Teach"}
        </button>
      </form>

      <section className="teaching-voice" aria-label="Voice teaching">
        <h3>Teach by voice</h3>
        <p className="teaching-note">
          The microphone records in this browser and the local model transcribes it on your device. The transcript
          becomes a pending draft you confirm below, never a teaching event on its own.
        </p>
        <button type="button" onClick={() => void handleVoiceToggle()} disabled={voiceBusy}>
          {voice.phase === "recording"
            ? "Stop and transcribe locally"
            : voice.phase === "transcribing"
              ? "Transcribing locally..."
              : "Record voice teaching"}
        </button>
        {voice.message !== null && (
          <p className="teaching-voice-message" role="status">
            {voice.message}
          </p>
        )}
      </section>

      <section className="teaching-drafts" aria-label="Pending teaching drafts">
        <h3>Pending voice drafts</h3>
        {draftsQuery.isPending ? (
          <p className="teaching-note">Loading pending drafts.</p>
        ) : draftsQuery.isError ? (
          <p className="teaching-error" role="alert">
            Could not load drafts: {draftsQuery.error.message}
          </p>
        ) : drafts.length === 0 ? (
          <p className="teaching-note">
            No pending drafts. Voice transcripts captured here or by the extension appear for confirmation.
          </p>
        ) : (
          <ul className="teaching-draft-list">
            {drafts.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                fallbackSessionId={sessionId}
                busy={teachingBusy}
                onConfirm={(request) => applyTeachingMutation.mutate(request)}
                onDiscard={(draftId) => discardMutation.mutate(draftId)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="teaching-run" aria-label="Agent status">
        <h3>Agent status</h3>
        <p className="teaching-run-status" data-status={run.status}>
          {RUN_STATUS_LABELS[run.status]}
        </p>
        {run.message !== null && (
          <p className="teaching-error" role="alert">
            {run.message}
          </p>
        )}
        {run.status === "failed" && (
          <p className="teaching-note">
            The transcript stays pending, so you can retry the same teaching without retyping it.
          </p>
        )}
      </section>

      {session === null ? null : <TeachingTrace client={client} session={session} taskId={run.taskId} />}
    </section>
  );
}
