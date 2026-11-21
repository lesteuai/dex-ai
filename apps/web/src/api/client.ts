import {
  apiErrorResponseSchema,
  type ProfileEntry,
  type Revision,
  type Rule,
  type SessionSummary,
  type SessionTimelineItem,
} from "@dex-ai/shared";

const API_BASE = "/api";

/** Error raised for non-2xx control-plane responses. */
export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors: Record<string, string[]>;

  constructor(status: number, message: string, fieldErrors: Record<string, string[]> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export type ApiClient = {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  getHealth(): Promise<{ ok: boolean }>;
  getSessions(): Promise<{ sessions: SessionSummary[] }>;
  getSession(id: string): Promise<{ session: SessionSummary; timeline: SessionTimelineItem[] }>;
  getProfile(): Promise<{ entries: ProfileEntry[] }>;
  getRules(): Promise<{ rules: Rule[] }>;
  getRevisions(): Promise<{ revisions: Revision[] }>;
};

async function toApiError(response: Response): Promise<ApiError> {
  let message = `Control plane responded with ${response.status}`;
  let fieldErrors: Record<string, string[]> = {};
  try {
    const body: unknown = await response.json();
    const parsed = apiErrorResponseSchema.safeParse(body);
    if (parsed.success) {
      message = parsed.data.message;
      fieldErrors = parsed.data.fieldErrors ?? {};
    }
  } catch {
    // Non-JSON error bodies keep the default status message.
  }
  return new ApiError(response.status, message, fieldErrors);
}

/** Token-scoped REST client for the control-plane HTTP API. */
export function createApiClient(token: string): ApiClient {
  async function request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw await toApiError(response);
    return (await response.json()) as T;
  }

  const get = <T>(path: string) => request<T>("GET", path);
  const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body);
  const patch = <T>(path: string, body?: unknown) => request<T>("PATCH", path, body);

  return {
    get,
    post,
    patch,
    getHealth: () => get<{ ok: boolean }>("/health"),
    getSessions: () => get<{ sessions: SessionSummary[] }>("/sessions"),
    getSession: (id) => get<{ session: SessionSummary; timeline: SessionTimelineItem[] }>(`/sessions/${id}`),
    getProfile: () => get<{ entries: ProfileEntry[] }>("/profile"),
    getRules: () => get<{ rules: Rule[] }>("/rules"),
    getRevisions: () => get<{ revisions: Revision[] }>("/revisions"),
  };
}

/** Shared query keys, invalidated by stream events and panel mutations. */
export const queryKeys = {
  sessions: ["sessions"] as const,
  session: (id: string) => ["sessions", id] as const,
  profile: ["profile"] as const,
  rules: ["rules"] as const,
  revisions: ["revisions"] as const,
  teachingDrafts: ["teaching-drafts"] as const,
  rehearsals: ["rehearsals"] as const,
  rehearsal: (id: string) => ["rehearsals", id] as const,
};
