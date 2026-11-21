import type { RehearsalAction } from "@dex-ai/shared";
import type { BlockedAttempt } from "../shared/messages";
import { classifySubmitAttempt } from "./submit-guard";

/**
 * Executes only rehearsal actions the coordinator routed into the tab.
 * Every action is classified first, so a submit-shaped target is blocked
 * and reported instead of executed, whatever the stream proposed.
 */

export interface RehearsalExecutionDeps {
  doc: Document;
  navigate: (url: string) => void;
}

export type RehearsalActionResult =
  | { ok: true }
  | { ok: false; blocked: true; attempt: BlockedAttempt }
  | { ok: false; error: string };

// The rehearsal drives the DOM with synthetic events; the observer reads
// this flag to keep agent fills out of the user's captured events.
let driving = false;

export function isRehearsalDriving(): boolean {
  return driving;
}

function driveElementEvents(element: Element, eventNames: readonly string[]): void {
  driving = true;
  try {
    for (const name of eventNames) element.dispatchEvent(new Event(name, { bubbles: true }));
  } finally {
    driving = false;
  }
}

function setElementValue(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
): void {
  if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
    element.checked = value === "true" || value === "on";
    return;
  }
  // Native setter so page frameworks tracking value changes notice the fill.
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

function executeScroll(
  action: Extract<RehearsalAction, { kind: "scroll" }>,
  doc: Document,
): RehearsalActionResult {
  if (action.selector === undefined) {
    doc.defaultView?.scrollBy({ top: action.deltaY });
    return { ok: true };
  }
  const element = doc.querySelector(action.selector);
  if (element === null) return { ok: false, error: `No element matches selector "${action.selector}"` };
  element.scrollIntoView?.({ block: "center" });
  return { ok: true };
}

function executeFill(
  action: Extract<RehearsalAction, { kind: "fill" }>,
  element: Element,
): RehearsalActionResult {
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLSelectElement) &&
    !(element instanceof HTMLTextAreaElement)
  ) {
    return { ok: false, error: `Fill target "${action.selector}" is not a form field` };
  }
  setElementValue(element, action.value);
  driveElementEvents(element, ["input", "change"]);
  return { ok: true };
}

export async function executeRehearsalAction(
  action: RehearsalAction,
  deps: RehearsalExecutionDeps,
): Promise<RehearsalActionResult> {
  const attempt = classifySubmitAttempt(action, deps.doc);
  if (attempt !== null) return { ok: false, blocked: true, attempt };

  switch (action.kind) {
    case "navigate":
      deps.navigate(action.url);
      return { ok: true };
    case "wait":
      await new Promise<void>((resolve) => {
        setTimeout(resolve, action.durationMs);
      });
      return { ok: true };
    case "scroll":
      return executeScroll(action, deps.doc);
  }

  const element = deps.doc.querySelector(action.selector);
  if (element === null) return { ok: false, error: `No element matches selector "${action.selector}"` };
  if (!(element instanceof HTMLElement)) {
    return { ok: false, error: `Target "${action.selector}" is not an interactive element` };
  }

  switch (action.kind) {
    case "focus":
      element.focus();
      return { ok: true };
    case "fill":
      return executeFill(action, element);
    case "click_non_submit":
      element.click();
      return { ok: true };
  }
}
