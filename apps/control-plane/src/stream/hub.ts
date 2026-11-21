import type { WebSocketLike } from "@hono/node-server";
import { wsEventSchema, type WsEvent } from "@dex-ai/shared";

const OPEN_READY_STATE = 1;
const SHUTDOWN_CLOSE_CODE = 1001;

/**
 * Fanout hub for envelope events streamed to authorized WebSocket clients.
 * Subscribers are added after the /stream upgrade succeeds.
 */
export class StreamHub {
  private readonly subscribers = new Set<WebSocketLike>();

  subscribe(ws: WebSocketLike): void {
    this.subscribers.add(ws);
    ws.on("close", () => {
      this.subscribers.delete(ws);
    });
  }

  unsubscribe(ws: WebSocketLike): void {
    this.subscribers.delete(ws);
  }

  publish(event: WsEvent): void {
    // Validate the wire envelope once before fanout.
    const message = JSON.stringify(wsEventSchema.parse(event));
    for (const ws of this.subscribers) {
      if (ws.readyState === OPEN_READY_STATE) ws.send(message);
      else this.subscribers.delete(ws);
    }
  }

  close(): void {
    for (const ws of this.subscribers) ws.close(SHUTDOWN_CLOSE_CODE, "control-plane shutdown");
    this.subscribers.clear();
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
