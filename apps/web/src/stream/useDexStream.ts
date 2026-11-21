import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { queryKeys } from "../api/client";
import { wsEventSchema, type WsEvent } from "@dex-ai/shared";

export type StreamStatus = "idle" | "connecting" | "open" | "reconnecting";

const TOKEN_PROTOCOL_PREFIX = "dex-ai.";
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 10000;

function streamUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/stream`;
}

/** Query keys to invalidate after a stream event, by event type. */
function keysForEvent(event: WsEvent): readonly QueryKey[] {
  switch (event.type) {
    case "session.updated":
    case "trace.started":
    case "trace.completed":
    case "task.failed":
      return [queryKeys.sessions];
    case "profile.updated":
      return [queryKeys.profile];
    case "revision.created":
      return [queryKeys.revisions, queryKeys.profile, queryKeys.rules];
    case "rehearsal.proposed":
    case "rehearsal.paused":
    case "rehearsal.executed":
    case "rehearsal.blocked":
      return [queryKeys.rehearsals, queryKeys.sessions];
  }
  // trace.delta is live reasoning text; panels consume it directly, no refetch.
  return [];
}

function handleStreamMessage(message: MessageEvent<string>, invalidate: (keys: readonly QueryKey[]) => void): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.data);
  } catch {
    return;
  }
  const event = wsEventSchema.safeParse(parsed);
  if (!event.success) return;
  invalidate(keysForEvent(event.data));
}

/**
 * Live control-plane stream. Connects to /stream with the token subprotocol,
 * reconnects with backoff while the control plane is unreachable, and
 * invalidates the query cache on events that change stored state.
 */
export function useDexStream(token: string | null): StreamStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>(token === null ? "idle" : "connecting");

  useEffect(() => {
    if (token === null) {
      setStatus("idle");
      return;
    }

    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let reconnectDelayMs = BASE_RECONNECT_DELAY_MS;

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");
      socket = new WebSocket(streamUrl(), TOKEN_PROTOCOL_PREFIX + token);
      socket.onopen = () => {
        reconnectDelayMs = BASE_RECONNECT_DELAY_MS;
        if (!disposed) setStatus("open");
      };
      socket.onmessage = (message: MessageEvent<string>) => {
        handleStreamMessage(message, (keys) => {
          for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
        });
      };
      socket.onclose = () => {
        if (disposed) return;
        setStatus("reconnecting");
        reconnectTimer = window.setTimeout(connect, reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [token, queryClient]);

  return status;
}
