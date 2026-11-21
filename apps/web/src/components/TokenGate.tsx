import { useEffect, useState, type FormEvent } from "react";
import { createApiClient } from "../api/client";

export const TOKEN_STORAGE_KEY = "dex-ai.control-plane-token";

type TokenGateProps = {
  onAuthenticated: (token: string) => void;
};

async function verifyToken(token: string): Promise<boolean> {
  try {
    await createApiClient(token).getHealth();
    return true;
  } catch {
    return false;
  }
}

async function handleRememberedToken(
  onAuthenticated: (token: string) => void,
  setMode: (mode: "checking" | "form") => void,
): Promise<void> {
  const remembered = window.localStorage.getItem(TOKEN_STORAGE_KEY);
  if (remembered === null) {
    setMode("form");
    return;
  }
  if (await verifyToken(remembered)) onAuthenticated(remembered);
  else {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    setMode("form");
  }
}

/** Local-token entry gate shown until the control plane accepts the token. */
export function TokenGate({ onAuthenticated }: TokenGateProps) {
  const [mode, setMode] = useState<"checking" | "form">(() =>
    window.localStorage.getItem(TOKEN_STORAGE_KEY) === null ? "form" : "checking",
  );
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (mode === "checking") void handleRememberedToken(onAuthenticated, setMode);
  }, [mode, onAuthenticated]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setVerifying(true);
    setError(null);
    const accepted = await verifyToken(token.trim());
    setVerifying(false);
    if (!accepted) {
      setError("The control plane rejected this token. Check the token in your local Dex AI config file.");
      return;
    }
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
    onAuthenticated(token.trim());
  };

  if (mode === "checking") {
    return <section className="token-gate"><p className="token-gate-checking">Checking saved token...</p></section>;
  }

  return (
    <section className="token-gate">
      <h1>Dex AI Control Plane</h1>
      <p className="token-gate-lead">
        This interface runs on your device and talks only to the local control plane. Enter the access token from{" "}
        <code>~/.config/dex-ai/config.json</code>.
      </p>
      <form onSubmit={(event) => void handleSubmit(event)} className="token-gate-form">
        <label htmlFor="token-input">Local access token</label>
        <input
          id="token-input"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
        <button type="submit" disabled={verifying || token.trim().length === 0}>
          {verifying ? "Verifying..." : "Open control plane"}
        </button>
      </form>
      {error !== null && <p className="token-gate-error" role="alert">{error}</p>}
    </section>
  );
}
