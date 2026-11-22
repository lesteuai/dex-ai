import type { ObservedEventEnvelope, ProfileEntry, RehearsalAction, Rule } from "@dex-ai/shared";
import { PROFILE_SECTIONS } from "./results";

/**
 * Prompt builders for the four agent task kinds. Each builder inlines the
 * observed context and the exact JSON shape the provider must return.
 */

const JSON_ONLY_INSTRUCTION =
  "Respond with exactly one JSON object and nothing else. No markdown fences and no commentary.";

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export interface ProfileInferencePromptInput {
  sessionId: string;
  events: ObservedEventEnvelope[];
  existingEntries: ProfileEntry[];
}

export function buildProfileInferencePrompt(input: ProfileInferencePromptInput): string {
  return [
    "Task: infer the user's job-application profile from one observed session.",
    "",
    `Session id: ${input.sessionId}`,
    "",
    "Observed events in captured order:",
    formatJson(input.events),
    "",
    "Existing profile entries, where earlier user corrections take precedence:",
    formatJson(input.existingEntries),
    "",
    "Inference rules:",
    "- Every entry must cite at least one event id from the observed events in sourceEventIds.",
    "- Every entry must carry a short reasoningTrace explaining the inference.",
    "- If a section has no sufficiently supported entry, return that section with an empty entries array. Never invent facts to fill it.",
    "- A value may be any JSON value. Keep it small and factual.",
    "",
    `Section names in order, one section object each inside the single sections array: ${PROFILE_SECTIONS.join(", ")}.`,
    "",
    'Return JSON: { "sections": [{ "section": "user_facts", "entries": [...] }, { "section": "job_sources", "entries": [...] }, { "section": "preferences", "entries": [...] }, { "section": "criteria", "entries": [...] }, { "section": "form_rules", "entries": [...] }] }',
    "",
    'Entry shape: { "key": string, "value": <any JSON>, "confidence": 0..1, "sourceEventIds": [event ids], "reasoningTrace": string }',
    "",
    JSON_ONLY_INSTRUCTION,
  ].join("\n");
}

export interface TeachingPromptInput {
  transcript: string;
  existingRules: Rule[];
}

export function buildTeachingPrompt(input: TeachingPromptInput): string {
  return [
    "Task: turn one confirmed teaching transcript into form-filling and decision rules.",
    "",
    "Transcript from the user:",
    '"""',
    input.transcript,
    '"""',
    "",
    "Existing rules. Update or refine them instead of duplicating when the teaching contradicts one:",
    formatJson(input.existingRules),
    "",
    "Output rules:",
    "- Each rule needs scope, condition and action as JSON values, a confidence between 0 and 1, and a reasoningTrace quoting or paraphrasing the part of the transcript that justifies it.",
    "- Only state what the transcript supports. Prefer zero rules over stretching it.",
    "- Teaching has no observed events behind it, so keep sourceEventIds an empty array.",
    "",
    'Return JSON: { "rules": [{ "scope": string, "condition": <any JSON>, "action": <any JSON>, "confidence": 0..1, "sourceEventIds": [], "reasoningTrace": string }] }',
    "",
    JSON_ONLY_INSTRUCTION,
  ].join("\n");
}

export interface RehearsalPlanPromptInput {
  postingUrl: string;
  postingTitle?: string;
  /** Page snapshot captured by the extension, when one has arrived. */
  snapshot?: unknown;
  entries: ProfileEntry[];
  rules: Rule[];
}

export function buildRehearsalPlanPrompt(input: RehearsalPlanPromptInput): string {
  const titleLine = input.postingTitle ? `\nPosting title: ${input.postingTitle}` : "";
  return [
    "Task: propose a rehearsal plan that navigates to and fills the application form for one posting.",
    "",
    `Posting url: ${input.postingUrl}${titleLine}`,
    "",
    "Current profile entries:",
    formatJson(input.entries),
    "",
    "Current rules:",
    formatJson(input.rules),
    ...(input.snapshot === undefined
      ? []
      : ["", "Current page snapshot from the extension:", formatJson(input.snapshot), ""]),
    "",
    "Planning rules:",
    "- Use only these action kinds: navigate, focus, fill, click_non_submit, scroll, wait.",
    "- There is deliberately no submit action. Never propose submitting the application. End the plan when the allowed fields are filled.",
    "- Order actions from navigation to field filling. Give each action a confidence between 0 and 1 and a short reasoning line citing the profile entry or rule it relies on.",
    "- Prefer selectors that appear in the page snapshot fields when a snapshot is given.",
    "- If the profile lacks a value for a field, do not invent one. Skip that field and mention it in the plan reasoningTrace.",
    "",
    'Return JSON: { "postingUrl": string, "reasoningTrace": string, "actions": [{ "action": <one action object>, "confidence": 0..1, "reasoning": string }] }',
    "",
    "Action objects by kind:",
    '- { "kind": "navigate", "url": string }',
    '- { "kind": "focus", "selector": string }',
    '- { "kind": "fill", "selector": string, "value": string }',
    '- { "kind": "click_non_submit", "selector": string }',
    '- { "kind": "scroll", "selector": string, "deltaY": integer }',
    '- { "kind": "wait", "durationMs": positive integer }',
    "",
    JSON_ONLY_INSTRUCTION,
  ].join("\n");
}

export interface CorrectionPropagationPromptInput {
  priorAction: RehearsalAction;
  correctedAction: RehearsalAction;
  correctionReason: string;
  contributingRules: Rule[];
}

export function buildCorrectionPropagationPrompt(input: CorrectionPropagationPromptInput): string {
  return [
    "Task: propagate one user correction to the rules that produced the corrected decision.",
    "",
    "Proposed action that the user rejected:",
    formatJson(input.priorAction),
    "",
    "User's corrected action:",
    formatJson(input.correctedAction),
    "",
    "User's stated reason:",
    '"""',
    input.correctionReason,
    '"""',
    "",
    "Rules identified as contributing to the rejected proposal:",
    formatJson(input.contributingRules),
    "",
    "Update rules:",
    "- Return one update per contributing rule that must change so the same wrong proposal does not recur.",
    "- Keep each rule's id. Replace condition and action only where the correction demands it. A rule that already agrees with the correction can repeat its current condition and action with a changeReason saying so.",
    "- Each update needs a confidence between 0 and 1 and a changeReason pointing at the correction.",
    "",
    'Return JSON: { "reasoningTrace": string, "ruleUpdates": [{ "ruleId": string, "condition": <any JSON>, "action": <any JSON>, "confidence": 0..1, "changeReason": string }] }',
    "",
    JSON_ONLY_INSTRUCTION,
  ].join("\n");
}
