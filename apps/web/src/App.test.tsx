// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY } from "./components/TokenGate";
import { App } from "./App";

const TOKEN = "c".repeat(64);
const TAB_NAMES = ["Profile & Rules", "Session Timeline", "Teaching Console", "Rehearsal Observer"];

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  close(): void {
    this.onclose?.();
  }
}

/** Empty but well-shaped payloads so every mounted panel query resolves cleanly. */
function payloadForPath(path: string): Record<string, unknown> {
  if (path === "/health") return { ok: true };
  if (path === "/sessions") return { sessions: [] };
  if (path === "/profile") return { entries: [] };
  if (path === "/rules") return { rules: [] };
  if (path === "/revisions") return { revisions: [] };
  if (path === "/teaching/drafts") return { drafts: [] };
  return { ok: true };
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname.replace(/^\/api/, "");
      return { ok: true, status: 200, json: async () => payloadForPath(path) };
    }),
  );
  window.localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function renderApp(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App shell", () => {
  it("signs in from the remembered token and exposes all four panel tabs", async () => {
    renderApp();

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(4));

    const tabNames = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabNames).toEqual(TAB_NAMES);
    expect(screen.getByRole("tab", { name: "Profile & Rules" }).getAttribute("aria-selected")).toBe("true");
  });

  it("switches the active panel tab on click", async () => {
    renderApp();

    await waitFor(() => expect(screen.getByRole("tab", { name: "Teaching Console" })).toBeTruthy());

    fireEvent.click(screen.getByRole("tab", { name: "Teaching Console" }));

    expect(screen.getByRole("tab", { name: "Teaching Console" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").id).toBe("panel-teaching-console");
  });

  it("renders the real profile editor as the default panel", async () => {
    renderApp();

    await screen.findByText(/No profile entries yet/);
    expect(screen.getByLabelText("Inferred profile")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run profile inference" }).hasAttribute("disabled")).toBe(true);
  });

  it("renders the real session timeline panel on its tab", async () => {
    renderApp();

    await screen.findByText(/No profile entries yet/);
    fireEvent.click(screen.getByRole("tab", { name: "Session Timeline" }));

    await screen.findByText(/No sessions captured yet/);
    expect(screen.getByRole("tabpanel").id).toBe("panel-session-timeline");
  });
});
