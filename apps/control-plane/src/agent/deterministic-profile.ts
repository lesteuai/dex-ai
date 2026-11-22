/**
 * Rule-based profile for the deterministic adapter on live sessions: it reads
 * the observed events embedded in the profile prompt and cites them, so local
 * runs without a provider still produce inspectable entries.
 */
import type { ProfileResult } from "./results";

const EVENTS_START_MARKER = "Observed events in captured order:\n";
const EVENTS_END_MARKER = "\n\nExisting profile entries";
const SINGLE_FILL_CONFIDENCE = 0.6;
const REPEATED_FILL_CONFIDENCE = 0.8;
const SEARCH_CONFIDENCE = 0.6;
const REASON_CONFIDENCE = 0.7;

interface PromptEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

type ProfileEntryResult = ProfileResult["sections"][number]["entries"][number];

export function readPromptEvents(prompt: string): PromptEvent[] {
  const start = prompt.indexOf(EVENTS_START_MARKER);
  const end = prompt.indexOf(EVENTS_END_MARKER, start);
  if (start === -1 || end === -1) return [];
  const json = prompt.slice(start + EVENTS_START_MARKER.length, end);
  return JSON.parse(json) as PromptEvent[];
}

function fieldKey(selector: string): string {
  const slug = selector.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug === "" ? "field" : slug;
}

function deriveFieldFacts(events: PromptEvent[]): ProfileEntryResult[] {
  const bySelector = new Map<string, PromptEvent[]>();
  for (const event of events.filter((candidate) => candidate.type === "field_filled")) {
    const selector = String(event.payload.selector ?? "");
    bySelector.set(selector, [...(bySelector.get(selector) ?? []), event]);
  }
  return [...bySelector].map(([selector, fills]) => {
    const values = new Set(fills.map((fill) => fill.payload.value));
    const repeated = fills.length > 1 && values.size === 1;
    const lastValue = fills.at(-1)?.payload.value;
    return {
      key: fieldKey(selector),
      value: lastValue,
      confidence: repeated ? REPEATED_FILL_CONFIDENCE : SINGLE_FILL_CONFIDENCE,
      sourceEventIds: fills.map((fill) => fill.id),
      reasoningTrace: repeated
        ? `The same value was typed into ${selector} ${fills.length} times.`
        : `The user typed this value into ${selector}.`,
    };
  });
}

function deriveListEntry(
  events: PromptEvent[],
  type: string,
  payloadField: string,
  key: string,
  confidence: number,
  reasoningTrace: string,
): ProfileEntryResult[] {
  const matching = events.filter((event) => event.type === type);
  if (matching.length === 0) return [];
  const values = [...new Set(matching.map((event) => String(event.payload[payloadField] ?? "")))];
  return [{ key, value: values, confidence, sourceEventIds: matching.map((event) => event.id), reasoningTrace }];
}

export function deriveProfileFromEvents(events: PromptEvent[]): ProfileResult {
  const searches = deriveListEntry(
    events, "search_filter", "query", "search_queries", SEARCH_CONFIDENCE,
    "Queries the user searched for in this session.",
  );
  const reasons = deriveListEntry(
    events, "reason_stated", "text", "stated_reasons", REASON_CONFIDENCE,
    "Reasons the user stated in their own words.",
  );
  return {
    sections: [
      { section: "user_facts", entries: deriveFieldFacts(events) },
      { section: "job_sources", entries: searches },
      { section: "preferences", entries: reasons },
      // Criteria and form rules need judgment, so a rule-based run leaves them empty.
      { section: "criteria", entries: [] },
      { section: "form_rules", entries: [] },
    ],
  };
}
