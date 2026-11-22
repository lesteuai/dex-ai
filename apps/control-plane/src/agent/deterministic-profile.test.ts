import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./adapter";
import { DeterministicAgentAdapter, fixtureEventIds } from "./deterministic-adapter";
import { buildProfileInferencePrompt } from "./prompts";
import type { ProfileResult } from "./results";

const PAGE = "https://jobs.example/listings/senior-frontend";

function liveEvents() {
  return [
    { type: "search_filter", id: randomUUID(), ts: "2026-11-22T10:00:00.000Z",
      payload: { pageUrl: PAGE, query: "typescript remote", filters: {} } },
    { type: "field_filled", id: randomUUID(), ts: "2026-11-22T10:01:00.000Z",
      payload: { pageUrl: PAGE, selector: "#full-name", value: "Sam Rivera" } },
    { type: "field_filled", id: randomUUID(), ts: "2026-11-22T10:02:00.000Z",
      payload: { pageUrl: PAGE, selector: "#full-name", value: "Sam Rivera" } },
    { type: "reason_stated", id: randomUUID(), ts: "2026-11-22T10:03:00.000Z",
      payload: { pageUrl: PAGE, input: "text", text: "Only remote roles" } },
  ] as const;
}

async function runProfile(events: ReadonlyArray<{ id: string }>): Promise<ProfileResult> {
  const prompt = buildProfileInferencePrompt({
    sessionId: randomUUID(),
    events: events as never,
    existingEntries: [],
  });
  const adapter = new DeterministicAgentAdapter();
  const stream = adapter.start({
    taskId: randomUUID(),
    kind: "profile_inference",
    sessionId: randomUUID(),
    prompt,
    resultSchema: "profile",
    signal: new AbortController().signal,
  });
  const collected: AgentEvent[] = [];
  for await (const event of stream) collected.push(event);
  const result = collected.find((event) => event.type === "result");
  return (result as { value: ProfileResult }).value;
}

function entriesOf(result: ProfileResult, section: string) {
  return result.sections.find((candidate) => candidate.section === section)?.entries ?? [];
}

describe("deterministic profile on live sessions", () => {
  it("derives cited entries from the session's own events", async () => {
    const events = liveEvents();
    const result = await runProfile(events);

    const [fullName] = entriesOf(result, "user_facts");
    expect(fullName).toMatchObject({ key: "full_name", value: "Sam Rivera", confidence: 0.8 });
    expect(fullName?.sourceEventIds).toEqual([events[1].id, events[2].id]);
    expect(entriesOf(result, "job_sources")[0]?.value).toEqual(["typescript remote"]);
    expect(entriesOf(result, "preferences")[0]?.value).toEqual(["Only remote roles"]);
  });

  it("keeps the scripted profile for fixture sessions", async () => {
    const result = await runProfile([{ id: fixtureEventIds.search }]);

    expect(entriesOf(result, "user_facts")[0]?.value).toBe("Jordan Lee");
  });
});
