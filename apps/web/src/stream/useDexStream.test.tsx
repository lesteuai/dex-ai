// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDexStream } from "./useDexStream";

const TOKEN = "a".repeat(64);

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.onclose?.();
  }
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

function renderStreamHook(token: string | null) {
  return renderHook(() => useDexStream(token), { wrapper });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useDexStream", () => {
  it("stays idle and opens no socket without a token", () => {
    const { result } = renderStreamHook(null);

    expect(result.current).toBe("idle");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("connects to /stream with the dex-ai token subprotocol", () => {
    const { result } = renderStreamHook(TOKEN);

    expect(result.current).toBe("connecting");
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toMatch(/^ws:/);
    expect(socket.url).toContain("/stream");
    expect(socket.protocols).toBe(`dex-ai.${TOKEN}`);
  });

  it("reports open once the socket is open", () => {
    const { result } = renderStreamHook(TOKEN);

    act(() => {
      FakeWebSocket.instances[0].onopen?.();
    });

    expect(result.current).toBe("open");
  });

  it("pauses in reconnecting state and reconnects with the same subprotocol", async () => {
    const { result } = renderStreamHook(TOKEN);

    act(() => {
      FakeWebSocket.instances[0].onclose?.();
    });

    expect(result.current).toBe("reconnecting");
    expect(FakeWebSocket.instances).toHaveLength(1);

    await vi.waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(2);
    }, { timeout: 2500 });

    expect(result.current).toBe("connecting");
    expect(FakeWebSocket.instances[1].protocols).toBe(`dex-ai.${TOKEN}`);
  });
});
