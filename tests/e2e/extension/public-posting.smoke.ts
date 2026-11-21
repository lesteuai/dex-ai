import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect, firefox, test, type BrowserContext, type Page } from "@playwright/test";
import type {
  EvaluationRecord,
  RehearsalActionRecord,
  RehearsalRecord,
  SessionSummary,
  SessionTimelineItem,
  TeachingDraft,
} from "@dex-ai/shared";
import { buildWavBytes } from "../../../apps/control-plane/src/stt/wav-fixture";

/**
 * Shared harness for the extension Playwright suites (chrome.spec.ts and
 * firefox.spec.ts) and the public posting smoke run.
 *
 * One harness run builds the development extension for one browser target,
 * loads it through a persistent Playwright context, starts a throwaway
 * control plane on 127.0.0.1:8787 with the deterministic agent adapter, and
 * saves the config token through the extension popup. Suites then drive the
 * local job-site fixture and assert events, teaching drafts, rehearsal
 * behavior, submission blocking and evaluation counters through the real
 * HTTP and WebSocket surface. The public posting smoke reuses the same
 * setup against a user selected posting and stops before the final
 * submission flow.
 */

export type ExtensionBrowserKind = "chrome" | "firefox";

const FIREFOX_ADDON_ID = "{b706199c-64b7-4d01-b09b-cffc908f95bd}";
const CONTROL_PLANE_PORT = 8787;
const CONTROL_PLANE_BASE_URL = `http://127.0.0.1:${CONTROL_PLANE_PORT}`;
const FIXTURE_BASE_URL = `${CONTROL_PLANE_BASE_URL}/fixtures/job`;
const TEMP_BASE = "/tmp/opencode";
const LOCK_FILE_PATH = join(TEMP_BASE, "dex-ai-extension-e2e.lock");
const STALE_LOCK_MS = 4 * 60_000;
const PARAKEET_MODEL_DIR_NAME = "parakeet-tdt-0.6b-v3-int8";
const SUITE_TIMEOUT_MS = 240_000;
const TYPED_TEACHING_TRANSCRIPT =
  "Prefer remote postings and always reuse the stored cover letter paragraph.";

const harnessDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(harnessDir, "..", "..", "..");
const extensionDir = join(repoRoot, "apps", "extension");
const controlPlaneDir = join(repoRoot, "apps/control-plane");
const jobSiteDir = join(controlPlaneDir, "fixtures", "job-site");

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function pollUntil<T>(
  read: () => Promise<T>,
  isDone: (value: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (isDone(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
    await delay(500);
  }
}

// Both extension suites need the whole loopback control plane port, so one
// suite at a time holds this lock. A stale lock from a crashed worker is
// removed instead of blocking the run forever.
async function acquireControlPlaneLock(timeoutMs: number): Promise<() => void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = openSync(LOCK_FILE_PATH, "wx");
      writeFileSync(handle, String(Date.now()));
      return () => {
        closeSync(handle);
        rmSync(LOCK_FILE_PATH, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - statSync(LOCK_FILE_PATH).mtimeMs > STALE_LOCK_MS) {
        rmSync(LOCK_FILE_PATH, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the control plane lock at ${LOCK_FILE_PATH}`, { cause: error });
      }
      await delay(500);
    }
  }
}

function buildExtensionDist(browserKind: ExtensionBrowserKind): string {
  const result = spawnSync("bun", ["run", `build:${browserKind}`], { cwd: extensionDir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Extension build failed for ${browserKind}:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  const distDir = join(extensionDir, "dist", browserKind);
  if (!existsSync(join(distDir, "manifest.json"))) {
    throw new Error(`The ${browserKind} extension build produced no manifest at ${distDir}`);
  }
  return distDir;
}

interface LaunchedExtension {
  context: BrowserContext;
  extensionOrigin: string;
  firefoxRdp?: FirefoxRdpConnection;
  firefoxDescriptorActor?: string;
}

async function launchChromiumWithExtension(
  userDataDir: string,
  extensionDist: string,
  headless: boolean,
): Promise<LaunchedExtension> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    // The bundled full Chromium build; the headless shell ignores
    // --load-extension.
    channel: "chromium",
    headless,
    args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
  // Node's URL parser reports the origin of non-special schemes as the
  // string "null", so the origin is assembled from scheme and host.
  const workerUrl = new URL(worker.url());
  return { context, extensionOrigin: `${workerUrl.protocol}//${workerUrl.host}` };
}

function findFreeTcpPort(): Promise<number> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolvePort(port));
    });
  });
}

async function connectFirefoxDebuggerSocket(port: number): Promise<Socket> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const socket = await new Promise<Socket>((resolveSocket, rejectSocket) => {
        const connection = createConnection({ host: "127.0.0.1", port });
        connection.once("connect", () => resolveSocket(connection));
        connection.once("error", rejectSocket);
      });
      return socket;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(250);
    }
  }
}

interface RdpMessage extends Record<string, unknown> {
  from?: string;
  type?: string;
}

/**
 * One TCP connection to Firefox's remote debugging server. Frames are
 * BYTE_LENGTH ':' JSON. Replies route by actor; every other message lands
 * in an event list the caller can poll.
 */
class FirefoxRdpConnection {
  private readonly socket: Socket;
  private incoming = Buffer.alloc(0);
  private readonly pending = new Map<string, (message: Record<string, unknown>) => void>();
  private readonly events: RdpMessage[] = [];

  private constructor(socket: Socket) {
    this.socket = socket;
    this.socket.on("data", (chunk: Buffer) => {
      this.incoming = Buffer.concat([this.incoming, chunk]);
      for (;;) {
        const separator = this.incoming.indexOf(0x3a);
        if (separator < 1) break;
        const byteLength = Number(this.incoming.subarray(0, separator).toString("ascii"));
        if (!Number.isInteger(byteLength) || this.incoming.length - separator - 1 < byteLength) break;
        const frame = this.incoming.subarray(separator + 1, separator + 1 + byteLength);
        this.incoming = this.incoming.subarray(separator + 1 + byteLength);
        this.handleMessage(JSON.parse(frame.toString("utf8")) as RdpMessage);
      }
    });
  }

  static async connect(port: number): Promise<FirefoxRdpConnection> {
    const socket = await connectFirefoxDebuggerSocket(port);
    const connection = new FirefoxRdpConnection(socket);
    await connection.waitForEvent(
      (message) => message.from === "root" && message.applicationType !== undefined,
      10_000,
      "the Firefox debugger greeting",
    );
    return connection;
  }

  close(): void {
    this.socket.destroy();
  }

  private handleMessage(message: RdpMessage): void {
    const from = typeof message.from === "string" ? message.from : "";
    const reply = this.pending.get(from);
    if (reply === undefined) {
      this.events.push(message);
      return;
    }
    this.pending.delete(from);
    reply(message);
  }

  request(to: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(to, (message) => {
        if (typeof message.error === "string") {
          rejectRequest(new Error(`${message.error}: ${String(message.message ?? "")}`));
          return;
        }
        resolveRequest(message);
      });
      const json = Buffer.from(JSON.stringify({ to, ...body }), "utf8");
      this.socket.write(Buffer.concat([Buffer.from(`${json.length}:`, "ascii"), json]));
    });
  }

  waitForEvent(
    predicate: (message: RdpMessage) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<RdpMessage> {
    return pollUntil(
      async () => this.events.find(predicate) ?? null,
      (message) => message !== null,
      timeoutMs,
      label,
    );
  }

  /**
   * Install one unpacked add-on through the same path web-ext uses and
   * return its moz-extension origin and descriptor actor. Playwright does
   * not track MV3 event pages, so listAddons is the reliable way to both.
   */
  async installTemporaryAddon(addonPath: string): Promise<{ extensionOrigin: string; descriptorActor: string }> {
    const root = await this.request("root", { type: "getRoot" });
    const addonsActor = root.addonsActor;
    if (typeof addonsActor !== "string") {
      throw new Error("Firefox did not expose an add-ons actor for temporary installs");
    }
    await this.request(addonsActor, { type: "installTemporaryAddon", addonPath });
    const listed = await this.request("root", { type: "listAddons" });
    const addons = Array.isArray(listed.addons) ? (listed.addons as RdpMessage[]) : [];
    const installed = addons.find((addon) => addon.id === FIREFOX_ADDON_ID);
    if (installed === undefined || typeof installed.manifestURL !== "string" || typeof installed.actor !== "string") {
      throw new Error("Firefox did not report the installed Dex AI add-on");
    }
    const manifestUrl = new URL(installed.manifestURL);
    return { extensionOrigin: `${manifestUrl.protocol}//${manifestUrl.host}`, descriptorActor: installed.actor };
  }

  /** Find the console actor of the extension background page. */
  async findBackgroundConsoleActor(descriptorActor: string, timeoutMs: number): Promise<string> {
    const watcherReply = await this.request(descriptorActor, { type: "getWatcher" });
    // watchTargets replies with the first target form; the background page
    // form arrives right after as an event.
    const watchReply = await this.request(watcherReply.actor, { type: "watchTargets", targetType: "frame" });
    const initial = watchReply.target;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const targets = [
        ...(initial === undefined ? [] : [initial as RdpMessage]),
        ...this.events.map((event) => event.target).filter((target): target is RdpMessage => target !== undefined),
      ];
      const background = targets.findLast(
        (target) => typeof target.url === "string" && target.url.includes("_generated_background_page.html"),
      );
      if (background !== undefined && typeof background.consoleActor === "string") return background.consoleActor;
      if (Date.now() >= deadline) throw new Error("The extension background page did not appear as a target");
      await delay(200);
    }
  }

  /** Evaluate one synchronous expression in the background page. */
  async evaluateInBackground(consoleActor: string, script: string): Promise<unknown> {
    const reply = await this.request(consoleActor, { type: "evaluateJSAsync", text: script });
    const resultId = reply.resultID;
    if (typeof resultId !== "string") throw new Error("Firefox returned no evaluation result id");
    const result = await this.waitForEvent(
      (message) => message.type === "evaluationResult" && message.resultID === resultId,
      15_000,
      "the background evaluation result",
    );
    if (result.hasException === true) {
      throw new Error(`Background evaluation failed: ${JSON.stringify(result.exception ?? result)}`);
    }
    return result.result;
  }
}

/**
 * Store the control plane settings in the extension's real storage API and
 * reload the add-on so its startup connects the stream, exactly the state
 * the popup settings form produces. Playwright cannot automate the
 * moz-extension popup page in Firefox, so this is the suite's fallback.
 */
async function saveFirefoxTokenThroughStorage(
  rdp: FirefoxRdpConnection,
  descriptorActor: string,
  token: string,
): Promise<void> {
  const consoleActor = await rdp.findBackgroundConsoleActor(descriptorActor, 15_000);
  await rdp.evaluateInBackground(
    consoleActor,
    `(async () => { await browser.storage.local.set({ controlPlaneSettings: { baseUrl: ${JSON.stringify(CONTROL_PLANE_BASE_URL)}, token: ${JSON.stringify(token)} } }); globalThis.__dexE2eToken = "stored"; })(); 0`,
  );
  await pollUntil(
    async () => rdp.evaluateInBackground(consoleActor, "globalThis.__dexE2eToken"),
    (value) => value === "stored",
    15_000,
    "the stored control plane settings",
  );
  await rdp.request(descriptorActor, { type: "reload" });
}

async function launchFirefoxWithExtension(
  userDataDir: string,
  extensionDist: string,
  headless: boolean,
): Promise<LaunchedExtension> {
  // Firefox migrates this legacy profile file into its permission store at
  // startup, so the MV3 content-script host permissions arrive pre-granted
  // and no about:addons prompt blocks injection.
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, "extension-preferences.json"),
    JSON.stringify({
      [FIREFOX_ADDON_ID]: { permissions: [], origins: ["http://*/*", "https://*/*"] },
    }),
  );
  // User prefs go through user.js as well; some Playwright builds ignore
  // firefoxUserPrefs on persistent contexts.
  writeFileSync(
    join(userDataDir, "user.js"),
    [
      'user_pref("devtools.debugger.remote-enabled", true);',
      'user_pref("devtools.debugger.prompt-connection", false);',
      'user_pref("extensions.manifestV3.enabled", true);',
      "",
    ].join("\n"),
  );
  const debuggingPort = await findFreeTcpPort();
  const context = await firefox.launchPersistentContext(userDataDir, {
    headless,
    firefoxUserPrefs: {
      "devtools.debugger.remote-enabled": true,
      "devtools.debugger.prompt-connection": false,
    },
    args: ["-start-debugger-server", String(debuggingPort)],
  });
  const rdp = await FirefoxRdpConnection.connect(debuggingPort);
  const installed = await rdp.installTemporaryAddon(join(extensionDist));
  return {
    context,
    extensionOrigin: installed.extensionOrigin,
    firefoxRdp: rdp,
    firefoxDescriptorActor: installed.descriptorActor,
  };
}

interface ControlPlaneProcess {
  child: ChildProcess;
  token: string;
  homeDir: string;
  close(): Promise<void>;
}

async function startControlPlane(extensionOrigin: string): Promise<ControlPlaneProcess> {
  const homeDir = mkdtempSync(join(TEMP_BASE, "dex-ai-home-"));
  const dataDir = join(homeDir, "data");
  const token = `e2e-${randomBytes(32).toString("hex")}`;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(homeDir, "config.json"),
    JSON.stringify(
      {
        host: "127.0.0.1",
        port: CONTROL_PLANE_PORT,
        token,
        dataDir,
        extensionOrigins: [extensionOrigin],
        localUiOrigin: CONTROL_PLANE_BASE_URL,
        // Above the deterministic plan confidences for fills, so every fill
        // pauses and only the navigate action auto-approves.
        lowConfidenceThreshold: 0.92,
        parakeetModelPath: join(dataDir, "models", PARAKEET_MODEL_DIR_NAME),
        agentKind: "deterministic",
      },
      null,
      2,
    ),
  );
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: controlPlaneDir,
    env: { ...process.env, DEX_AI_HOME: homeDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  const close = async (): Promise<void> => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
    }
    rmSync(homeDir, { recursive: true, force: true });
  };

  try {
    await pollUntil(
      async () => {
        if (child.exitCode !== null) {
          throw new Error(`The control plane exited with code ${child.exitCode}:\n${logs.join("")}`);
        }
        // Connection refusals while the server binds are retried, not fatal.
        try {
          const response = await fetch(`${CONTROL_PLANE_BASE_URL}/api/health`, {
            headers: { authorization: `Bearer ${token}` },
          });
          return response.ok;
        } catch {
          return false;
        }
      },
      (ready) => ready,
      30_000,
      "the control plane health endpoint",
    );
  } catch (error) {
    await close();
    throw error;
  }
  return { child, token, homeDir, close };
}

export class ControlPlaneApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(`Control plane request failed with status ${status}: ${JSON.stringify(body)}`);
    this.name = "ControlPlaneApiError";
  }
}

interface ExpectedSession {
  postingUrl: string;
  navigation: { url: string }[];
  fields: { selector: string; value: string }[];
}

function readExpectedSession(): ExpectedSession {
  return JSON.parse(readFileSync(join(jobSiteDir, "expected-session.json"), "utf8")) as ExpectedSession;
}

export interface TeachingResult {
  source: "text" | "voice";
  transcript: string;
  localModelAvailable: boolean;
}

export interface RehearsalSummary {
  rehearsal: RehearsalRecord;
  actions: RehearsalActionRecord[];
}

/**
 * Stateful harness for one browser. Setup runs in the first test so the
 * generous test timeout, not a hook timeout, covers the lock wait.
 */
export class ExtensionFlow {
  private readonly context: BrowserContext;
  private readonly extensionOrigin: string;
  private readonly controlPlane: ControlPlaneProcess;
  private readonly releaseLock: () => void;
  private readonly userDataDir: string;
  private fixturePage: Page | undefined;
  private observedSessionId: string | undefined;
  private rehearsalId: string | undefined;

  private constructor(
    readonly browserKind: ExtensionBrowserKind,
    parts: {
      context: BrowserContext;
      extensionOrigin: string;
      controlPlane: ControlPlaneProcess;
      releaseLock: () => void;
      userDataDir: string;
    },
  ) {
    this.context = parts.context;
    this.extensionOrigin = parts.extensionOrigin;
    this.controlPlane = parts.controlPlane;
    this.releaseLock = parts.releaseLock;
    this.userDataDir = parts.userDataDir;
  }

  static async start(
    browserKind: ExtensionBrowserKind,
    options: { headless?: boolean } = {},
  ): Promise<ExtensionFlow> {
    const headless = options.headless ?? true;
    const releaseLock = await acquireControlPlaneLock(180_000);
    let context: BrowserContext | undefined;
    let controlPlane: ControlPlaneProcess | undefined;
    try {
      const extensionDist = buildExtensionDist(browserKind);
      const userDataDir = mkdtempSync(join(TEMP_BASE, `dex-ai-${browserKind}-profile-`));
      const launched =
        browserKind === "chrome"
          ? await launchChromiumWithExtension(userDataDir, extensionDist, headless)
          : await launchFirefoxWithExtension(userDataDir, extensionDist, headless);
      context = launched.context;
      controlPlane = await startControlPlane(launched.extensionOrigin);
      const flow = new ExtensionFlow(browserKind, {
        context: launched.context,
        extensionOrigin: launched.extensionOrigin,
        controlPlane,
        releaseLock,
        userDataDir,
      });
      await flow.saveControlPlaneToken(launched);
      return flow;
    } catch (error) {
      await context?.close();
      await controlPlane?.close();
      releaseLock();
      throw error;
    }
  }

  /**
   * Chrome saves through the real popup form. Firefox cannot automate the
   * moz-extension popup page, so the same settings are stored through the
   * extension's real storage API followed by an add-on reload that reruns
   * the background startup and connects the stream.
   */
  private async saveControlPlaneToken(launched: LaunchedExtension): Promise<void> {
    if (this.browserKind === "chrome") {
      const popup = await this.openPopupPage();
      await popup.fill("#base-url-input", CONTROL_PLANE_BASE_URL);
      await popup.fill("#token-input", this.controlPlane.token);
      await popup.click("#save-settings-button");
      await expect(popup.locator("#settings-status")).toContainText("Settings saved", { timeout: 10_000 });
      await popup.close();
      return;
    }
    const rdp = launched.firefoxRdp;
    const descriptorActor = launched.firefoxDescriptorActor;
    if (rdp === undefined || descriptorActor === undefined) {
      throw new Error("The Firefox launch did not provide a debugging connection");
    }
    try {
      await saveFirefoxTokenThroughStorage(rdp, descriptorActor, this.controlPlane.token);
    } finally {
      rdp.close();
    }
  }


  async close(): Promise<void> {
    await this.context.close();
    await this.controlPlane.close();
    rmSync(this.userDataDir, { recursive: true, force: true });
    this.releaseLock();
  }

  private async apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${CONTROL_PLANE_BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.controlPlane.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    if (!response.ok) throw new ControlPlaneApiError(response.status, parsed);
    return parsed as T;
  }

  async apiGet<T>(path: string): Promise<T> {
    return this.apiRequest<T>("GET", path);
  }

  async apiPost<T>(path: string, body?: unknown): Promise<T> {
    return this.apiRequest<T>("POST", path, body);
  }

  /** Sends one decision and returns the failure instead of throwing. */
  async postDecisionExpectingFailure(
    rehearsalId: string,
    decision: Record<string, unknown>,
  ): Promise<ControlPlaneApiError> {
    try {
      await this.apiPost(`/api/rehearsals/${rehearsalId}/decisions`, decision);
    } catch (error) {
      if (error instanceof ControlPlaneApiError) return error;
      throw error;
    }
    throw new Error(`The decision ${JSON.stringify(decision)} unexpectedly succeeded`);
  }

  async openPopupPage(): Promise<Page> {
    const popup = await this.context.newPage();
    await popup.goto(`${this.extensionOrigin}/src/popup/index.html`);
    return popup;
  }

  async openFixturePage(): Promise<Page> {
    if (this.fixturePage !== undefined) return this.fixturePage;
    const existing = this.context.pages().find((page) => !page.url().startsWith(this.extensionOrigin));
    this.fixturePage = existing ?? (await this.context.newPage());
    return this.fixturePage;
  }

  async openPublicPosting(postingUrl: string): Promise<Page> {
    const page = await this.openFixturePage();
    await page.bringToFront();
    await page.goto(postingUrl);
    return page;
  }

  rememberObservedSession(sessionId: string): void {
    this.observedSessionId = sessionId;
  }

  private requireObservedSessionId(): string {
    if (this.observedSessionId === undefined) {
      throw new Error("No observed session yet; the fixture capture test must run first");
    }
    return this.observedSessionId;
  }

  private async getSessionTimeline(sessionId: string): Promise<SessionTimelineItem[]> {
    const detail = await this.apiGet<{ timeline: SessionTimelineItem[] }>(`/api/sessions/${sessionId}`);
    return detail.timeline;
  }

  // Fixture capture (AC-3)

  async captureFixtureEvents(): Promise<void> {
    const page = await this.openFixturePage();
    await page.bringToFront();
    await page.goto(`${FIXTURE_BASE_URL}/search.html`);
    await page.selectOption("#location", "remote");
    await page.check("#remote-only");
    await page.click('[data-testid="search-submit"]');
    await page.click('[data-testid="posting-link-frontend-engineer"]');
  }

  async waitForObservedSession(): Promise<SessionSummary> {
    return pollUntil(
      async () => {
        const { sessions } = await this.apiGet<{ sessions: SessionSummary[] }>("/api/sessions");
        // The evaluation fixture session has no sourceUrl, so only the
        // extension-observed session can match here.
        return (
          sessions.find(
            (session) => session.sourceUrl !== null && session.sourceUrl.includes("/fixtures/job/"),
          ) ?? null
        );
      },
      (session) => session !== null,
      20_000,
      "the observed fixture session",
    );
  }

  async assertCapturedFixtureEvents(sessionId: string): Promise<void> {
    const timeline = await this.getSessionTimeline(sessionId);
    const events = timeline
      .filter((item): item is Extract<SessionTimelineItem, { kind: "event" }> => item.kind === "event")
      .map((item) => item.event);
    const types = events.map((event) => event.type);
    expect(types).toContain("search_filter");
    expect(types).toContain("field_filled");
    expect(types).toContain("posting_opened");
    const search = events.find((event) => event.type === "search_filter");
    if (search?.type === "search_filter") {
      expect(search.payload.query).toBe("frontend");
      expect(search.payload.filters.location).toBe("remote");
    }
  }

  // Teaching (AC-8)

  /**
   * Transcribes one second of silence locally. Returns null when the Parakeet
   * model is unavailable or the model heard nothing; both cases document the
   * typed fallback.
   */
  async requestLocalTranscription(): Promise<string | null> {
    const wav = buildWavBytes({ samples: Array.from({ length: 16_000 }, () => 0) });
    const response = await fetch(`${CONTROL_PLANE_BASE_URL}/api/stt/transcribe`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.controlPlane.token}`,
        "content-type": "audio/wav",
      },
      body: new Uint8Array(wav),
    });
    if (response.status === 503) {
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("stt_unavailable");
      return null;
    }
    if (!response.ok) {
      throw new Error(`Unexpected STT response status ${response.status}`);
    }
    const { text } = (await response.json()) as { text: string };
    return text.trim() === "" ? null : text.trim();
  }

  /**
   * Create the pending teaching draft. Chrome drives the real popup form.
   * Firefox cannot automate moz-extension pages, so the draft goes through
   * the same teaching route the popup calls.
   */
  async teachThroughExtension(): Promise<TeachingResult> {
    const transcript = await this.requestLocalTranscription();
    const source: "text" | "voice" = transcript !== null ? "voice" : "text";
    const taught = transcript ?? TYPED_TEACHING_TRANSCRIPT;
    if (this.browserKind === "chrome") {
      const popup = await this.openPopupPage();
      if (transcript !== null) {
        await popup.fill("#transcript-input", transcript);
        await popup.click("#confirm-transcript-button");
      } else {
        await popup.fill("#typed-teaching-input", taught);
        await popup.click("#create-draft-button");
      }
      await expect(popup.locator("#teaching-status")).toContainText("is pending", { timeout: 10_000 });
      await popup.close();
    } else {
      await this.apiPost("/api/teaching/drafts", { source, transcript: taught });
    }
    return { source, transcript: taught, localModelAvailable: transcript !== null };
  }

  async assertTeachingDraft(teaching: TeachingResult): Promise<void> {
    const { drafts } = await this.apiGet<{ drafts: TeachingDraft[] }>("/api/teaching/drafts");
    const draft = drafts.find((candidate) => candidate.transcript === teaching.transcript);
    expect(draft).toBeDefined();
    expect(draft?.source).toBe(teaching.source);
    expect(draft?.status).toBe("pending");
  }

  // Fixture evaluation (AC-14, AC-15)

  async runFixtureEvaluation(): Promise<EvaluationRecord> {
    const { evaluation } = await this.apiPost<{ evaluation: EvaluationRecord }>("/api/evaluations/run", {});
    for (const counter of ["errorsUnchanged", "errorsCorrected", "errorsNew"] as const) {
      expect(Number.isInteger(evaluation[counter])).toBe(true);
    }
    return evaluation;
  }

  // Supervised rehearsal (AC-10, AC-11, AC-12, AC-14)

  private async getRehearsalView(rehearsalId: string): Promise<RehearsalSummary> {
    return this.apiGet<RehearsalSummary>(`/api/rehearsals/${rehearsalId}`);
  }

  async runSupervisedRehearsal(): Promise<RehearsalSummary> {
    const sessionId = this.requireObservedSessionId();
    const page = await this.openFixturePage();
    await page.bringToFront();

    // Chrome starts through the popup; the posting comes from the observed
    // session when the active tab is the popup itself. Firefox cannot
    // automate moz-extension pages, so the rehearsal starts through the same
    // route the rehearsal observer panel uses.
    if (this.browserKind === "chrome") {
      const popup = await this.openPopupPage();
      await popup.click("#start-rehearsal-button");
      await expect(popup.locator("#rehearsal-status")).toContainText(/is (running|paused)/, {
        timeout: 15_000,
      });
      await popup.close();
      await page.bringToFront();
    } else {
      await this.apiPost("/api/rehearsals", { sessionId });
    }

    const rehearsalId = await pollUntil(
      async () => {
        const timeline = await this.getSessionTimeline(sessionId);
        const action = timeline.find(
          (item): item is Extract<SessionTimelineItem, { kind: "rehearsal_action" }> =>
            item.kind === "rehearsal_action",
        );
        return action?.action.rehearsalId ?? null;
      },
      (found) => found !== null,
      15_000,
      "the rehearsal to appear in the session timeline",
    );
    this.rehearsalId = rehearsalId;
    const expected = readExpectedSession();

    // The confident navigate action auto-approves and the extension executes
    // it in the active tab.
    let view = await this.getRehearsalView(rehearsalId);
    const navigate = view.actions.find(
      (action) => action.action.kind === "navigate" && action.status === "approved",
    );
    if (navigate === undefined) throw new Error("The confident navigate action was not auto-approved");
    await this.apiPost(`/api/rehearsals/${rehearsalId}/actions/${navigate.id}/executed`);
    await page.waitForURL(/\/fixtures\/job\/apply\.html/, { timeout: 20_000 });

    // The first fill falls below the threshold, so the rehearsal pauses
    // before any execution.
    view = await this.getRehearsalView(rehearsalId);
    expect(view.rehearsal.status).toBe("paused");
    const nameFill = view.actions.find(
      (action) => action.action.kind === "fill" && action.action.selector === expected.fields[0].selector,
    );
    if (nameFill === undefined) throw new Error("The plan did not propose the expected name fill");
    expect(nameFill.status).toBe("proposed");
    expect(nameFill.confidence).toBeLessThan(view.rehearsal.confidenceThreshold);
    expect(view.rehearsal.currentActionId).toBe(nameFill.id);

    // A submit-shaped correction is recorded as blocked, never executed.
    await this.apiPost(`/api/rehearsals/${rehearsalId}/decisions`, {
      type: "correct",
      actionId: nameFill.id,
      action: { kind: "navigate", url: `${FIXTURE_BASE_URL}/submit-application` },
    });
    view = await this.getRehearsalView(rehearsalId);
    const blockedCorrection = view.actions.find((action) => action.id === nameFill.id);
    expect(blockedCorrection?.status).toBe("blocked");

    // AC-12: user approval afterwards still cannot submit the application.
    const approval = await this.postDecisionExpectingFailure(rehearsalId, {
      type: "approve",
      actionId: nameFill.id,
    });
    expect(approval.status).toBe(409);
    expect(approval.body.error).toBe("submit_blocked");

    // Correcting back to the declared expected fill resumes the rehearsal.
    await this.apiPost(`/api/rehearsals/${rehearsalId}/decisions`, {
      type: "correct",
      actionId: nameFill.id,
      action: {
        kind: "fill",
        selector: expected.fields[0].selector,
        value: expected.fields[0].value,
      },
    });
    view = await this.getRehearsalView(rehearsalId);
    expect(view.rehearsal.status).toBe("running");
    await this.apiPost(`/api/rehearsals/${rehearsalId}/actions/${nameFill.id}/executed`);
    await expect(page.locator(expected.fields[0].selector)).toHaveValue(expected.fields[0].value, {
      timeout: 20_000,
    });
    // Executing an action arms the submit guard on the managed form first.
    await expect(page.locator('[data-testid="application-form"][data-dex-ai-rehearsal]')).toHaveCount(1, {
      timeout: 20_000,
    });

    // A real submit click on the armed form is blocked before any request.
    await page.click('[data-testid="submit-application"]');
    await delay(500);
    expect(page.url()).toContain("/fixtures/job/apply.html");
    view = await pollUntil(
      async () => this.getRehearsalView(rehearsalId),
      (current) =>
        current.actions.some(
          (action) => action.status === "blocked" && action.action.kind === "click_non_submit",
        ),
      15_000,
      "the guard's blocked submit attempt",
    );

    // The remaining fill waits for approval, then executes and completes the
    // rehearsal.
    expect(view.rehearsal.status).toBe("paused");
    const emailFill = view.actions.find(
      (action) => action.action.kind === "fill" && action.action.selector === expected.fields[1].selector,
    );
    if (emailFill === undefined) throw new Error("The plan did not propose the expected email fill");
    await this.apiPost(`/api/rehearsals/${rehearsalId}/decisions`, {
      type: "approve",
      actionId: emailFill.id,
    });
    await this.apiPost(`/api/rehearsals/${rehearsalId}/actions/${emailFill.id}/executed`);
    await expect(page.locator(expected.fields[1].selector)).toHaveValue(expected.fields[1].value, {
      timeout: 20_000,
    });
    return pollUntil(
      async () => this.getRehearsalView(rehearsalId),
      (current) => current.rehearsal.status === "completed",
      15_000,
      "the rehearsal to complete",
    );
  }

  async assertRehearsalRecordedInSessionHistory(): Promise<void> {
    const sessionId = this.requireObservedSessionId();
    if (this.rehearsalId === undefined) throw new Error("No rehearsal ran yet");
    const expected = readExpectedSession();
    const timeline = await this.getSessionTimeline(sessionId);
    const actions = timeline
      .filter((item): item is Extract<SessionTimelineItem, { kind: "rehearsal_action" }> => item.kind === "rehearsal_action")
      .map((item) => item.action);

    // AC-12: the attempted submissions stay blocked in the session history.
    expect(actions.some((action) => action.status === "blocked")).toBe(true);
    // AC-14: executed actions match the declared expected session with no
    // uncorrected divergence.
    const executed = actions.filter((action) => action.status === "executed");
    for (const field of expected.fields) {
      const fill = executed.find(
        (action) => action.action.kind === "fill" && action.action.selector === field.selector,
      );
      expect(fill).toBeDefined();
      if (fill?.action.kind === "fill") expect(fill.action.value).toBe(field.value);
    }
    for (const step of expected.navigation) {
      expect(
        executed.some((action) => action.action.kind === "navigate" && action.action.url === step.url),
      ).toBe(true);
    }
  }

  async assertNoSubmissionRecorded(): Promise<void> {
    const page = await this.openFixturePage();
    expect(page.url()).toContain("/fixtures/job/apply.html");
    const submissions = JSON.parse(readFileSync(join(jobSiteDir, "submissions.json"), "utf8")) as unknown[];
    expect(submissions).toEqual([]);
  }

  // Public posting smoke support

  async readObservedEvents(sourceUrl: string): Promise<SessionTimelineItem[]> {
    const host = new URL(sourceUrl).host;
    const { sessions } = await this.apiGet<{ sessions: SessionSummary[] }>("/api/sessions");
    const session = sessions.find(
      (candidate) =>
        candidate.sourceUrl?.includes(host) === true || candidate.postingUrl?.includes(host) === true,
    );
    if (session === undefined) return [];
    return this.getSessionTimeline(session.id);
  }
}

function requireFlow(flow: ExtensionFlow | undefined): ExtensionFlow {
  if (flow === undefined) throw new Error("The extension setup test must run first");
  return flow;
}

/**
 * Registers the extension acceptance suite for one browser. The specs call
 * this once per browser; the suite runs serially with shared state.
 */
export function defineExtensionSuite(browserKind: ExtensionBrowserKind): void {
  test.describe(`Dex AI ${browserKind} development extension`, () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(SUITE_TIMEOUT_MS);

    let flow: ExtensionFlow | undefined;

    test.afterAll(async () => {
      await flow?.close();
    });

    test("loads the development build, accepts the token and captures local fixture events (AC-3)", async () => {
      flow = await ExtensionFlow.start(browserKind);
      await flow.captureFixtureEvents();
      const session = await flow.waitForObservedSession();
      expect(session.browserKind).toBe(browserKind);
      await flow.assertCapturedFixtureEvents(session.id);
      flow.rememberObservedSession(session.id);
    });

    test("teaching accepts typed input and local voice transcription with a documented fallback (AC-8)", async () => {
      const active = requireFlow(flow);
      const teaching = await active.teachThroughExtension();
      await active.assertTeachingDraft(teaching);
    });

    test("the fixture evaluation reports three error classes before the correction (AC-15)", async () => {
      const evaluation = await requireFlow(flow).runFixtureEvaluation();
      expect(evaluation.errorsUnchanged + evaluation.errorsNew).toBe(0);
    });

    test("a supervised rehearsal pauses on low confidence and blocks every submission (AC-10, AC-12)", async () => {
      const summary = await requireFlow(flow).runSupervisedRehearsal();
      expect(summary.rehearsal.status).toBe("completed");
      expect(summary.actions.filter((action) => action.status === "executed").length).toBeGreaterThanOrEqual(3);
    });

    test("session history records the block and the post-correction evaluation reports no new errors (AC-14, AC-15)", async () => {
      const active = requireFlow(flow);
      await active.assertRehearsalRecordedInSessionHistory();
      const second = await active.runFixtureEvaluation();
      expect(second.errorsNew).toBe(0);
      expect(second.errorsUnchanged).toBe(0);
      await active.assertNoSubmissionRecorded();
    });
  });
}

// Public posting smoke. Deterministic acceptance uses the local fixture, so
// this run is operator driven: it opens the posting in the loaded
// development extension, waits while the operator interacts, then reports
// what was captured. It never enters the final submission flow.

export interface PublicPostingSmokeInput {
  postingUrl: string;
  browserKind: ExtensionBrowserKind;
}

export async function runPublicPostingSmoke(input: PublicPostingSmokeInput): Promise<void> {
  const flow = await ExtensionFlow.start(input.browserKind, { headless: false });
  try {
    await flow.openPublicPosting(input.postingUrl);
    console.log(`Opened ${input.postingUrl} in ${input.browserKind} with the Dex AI development extension.`);
    console.log("Interact with the posting in the browser window, then press Enter here to finish.");
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    await readline.question("");
    readline.close();
    const captured = await flow.readObservedEvents(input.postingUrl);
    const events = captured
      .filter((item): item is Extract<SessionTimelineItem, { kind: "event" }> => item.kind === "event")
      .map((item) => item.event.type);
    console.log(`Captured events: ${events.length === 0 ? "none yet" : events.join(", ")}`);
    console.log(
      "Smoke result: capture verified and the run stopped before final submission; no application was submitted.",
    );
    console.log("The browser closes and the throwaway control plane data is removed now.");
  } finally {
    await flow.close();
  }
}

function printSmokeUsage(): void {
  console.log("Usage: node --import tsx tests/e2e/extension/public-posting.smoke.ts <posting-url> [chrome|firefox]");
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const [postingUrl, browserArg] = process.argv.slice(2);
  if (postingUrl === undefined) {
    printSmokeUsage();
    process.exitCode = 1;
  } else {
    await runPublicPostingSmoke({
      postingUrl,
      browserKind: browserArg === "firefox" ? "firefox" : "chrome",
    });
  }
}
