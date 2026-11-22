/**
 * Scores a job posting against the learned profile without an LLM, so the
 * extension can show a match instantly and explain it term by term.
 */
import type { JobMatchRequest, JobMatchResponse, ProfileEntry } from "@dex-ai/shared";

const MATCH_SECTIONS = new Set(["preferences", "criteria", "job_sources"]);
const MIN_TERM_LENGTH = 4;
// ponytail: fixed English stopword list, swap for per-language lists if postings vary.
const STOPWORDS = new Set([
  "always", "never", "only", "with", "that", "this", "from", "have", "prefer", "want", "like",
  "skip", "role", "roles", "jobs", "apply", "posting", "postings", "should", "would", "every",
  "them", "they", "their", "than", "then", "into", "about", "your", "mine",
]);

type Signal = JobMatchResponse["matched"][number];

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(collectStrings);
  return [];
}

function extractTerms(value: unknown): string[] {
  const words = collectStrings(value).join(" ").toLowerCase().match(/[a-z0-9+#.]+/g) ?? [];
  const meaningful = words
    .map((word) => word.replace(/\.+$/, ""))
    .filter((word) => word.length >= MIN_TERM_LENGTH && !STOPWORDS.has(word));
  return [...new Set(meaningful)];
}

function toSignal(entry: ProfileEntry): Signal {
  return { section: entry.section, key: entry.key, terms: extractTerms(entry.value) };
}

export function scorePosting(posting: JobMatchRequest, entries: ProfileEntry[]): JobMatchResponse {
  const haystack = `${posting.title ?? ""} ${posting.text}`.toLowerCase();
  const signals = entries
    .filter((entry) => MATCH_SECTIONS.has(entry.section))
    .map(toSignal)
    .filter((signal) => signal.terms.length > 0);
  if (signals.length === 0) return { score: null, matched: [], missed: [] };

  const matched: Signal[] = [];
  const missed: Signal[] = [];
  for (const signal of signals) {
    const hits = signal.terms.filter((term) => haystack.includes(term));
    if (hits.length > 0) matched.push({ ...signal, terms: hits });
    else missed.push(signal);
  }
  const score = Math.round((matched.length / signals.length) * 100);
  return { score, matched, missed };
}
