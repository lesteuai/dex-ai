// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY, TokenGate } from "./TokenGate";

const TOKEN = "b".repeat(64);

function stubFetch(acceptsToken: boolean) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>>(
    async () => ({
      ok: acceptsToken,
      status: acceptsToken ? 200 : 401,
      json: async () => ({ ok: acceptsToken }),
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("TokenGate", () => {
  it("shows the entry form with a disabled submit when no token is remembered", () => {
    stubFetch(true);

    render(<TokenGate onAuthenticated={vi.fn()} />);

    expect(screen.getByLabelText("Local access token")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Open control plane" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("authenticates silently from a remembered token the control plane accepts", async () => {
    const fetchMock = stubFetch(true);
    window.localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    const onAuthenticated = vi.fn();

    render(<TokenGate onAuthenticated={onAuthenticated} />);

    expect(screen.getByText("Checking saved token...")).toBeTruthy();
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
    expect(onAuthenticated).toHaveBeenCalledWith(TOKEN);

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/health");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("clears a remembered token the control plane rejects", async () => {
    stubFetch(false);
    window.localStorage.setItem(TOKEN_STORAGE_KEY, "rejected-token");
    const onAuthenticated = vi.fn();

    render(<TokenGate onAuthenticated={onAuthenticated} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Open control plane" })).toBeTruthy());

    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("trims, stores and forwards a token entered in the form", async () => {
    stubFetch(true);
    const onAuthenticated = vi.fn();

    render(<TokenGate onAuthenticated={onAuthenticated} />);
    fireEvent.change(screen.getByLabelText("Local access token"), { target: { value: `  ${TOKEN} ` } });
    fireEvent.click(screen.getByRole("button", { name: "Open control plane" }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(TOKEN));

    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
  });

  it("shows an alert and stores nothing for a token the control plane rejects", async () => {
    stubFetch(false);
    const onAuthenticated = vi.fn();

    render(<TokenGate onAuthenticated={onAuthenticated} />);
    fireEvent.change(screen.getByLabelText("Local access token"), { target: { value: "rejected-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Open control plane" }));

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toBe(
      "The control plane rejected this token. Check the token in your local Dex AI config file.",
    );
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
});
