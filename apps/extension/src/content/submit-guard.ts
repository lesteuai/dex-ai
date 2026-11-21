import type { RehearsalAction } from "@dex-ai/shared";
import type { BlockedAttempt } from "../shared/messages";
import { DIRECT_SUBMIT_EVENT, REHEARSAL_FORM_ATTRIBUTE, buildSelector, isSubmitControl } from "./snapshot";

const SUBMIT_IDENTIFIER_PATTERN = /submit/i;

/**
 * Classify a rehearsal action that would submit the application. The
 * shared action vocabulary has no submit kind, so this catches the
 * submit-shaped navigation and controls a plan or correction can still
 * reach for. Mirrors classifySubmitAttempt in the control-plane planner.
 */
export function classifySubmitAttempt(action: RehearsalAction, doc: Document): BlockedAttempt | null {
  if (action.kind === "navigate") {
    return SUBMIT_IDENTIFIER_PATTERN.test(action.url)
      ? { reason: "submit_navigation", url: action.url }
      : null;
  }
  if (action.kind === "scroll" || action.kind === "wait") return null;
  if (SUBMIT_IDENTIFIER_PATTERN.test(action.selector)) {
    return action.kind === "click_non_submit"
      ? { reason: "submit_activation", selector: action.selector }
      : { reason: "submit_control", selector: action.selector };
  }
  const element = doc.querySelector(action.selector);
  if (element !== null && isSubmitControl(element)) {
    return action.kind === "click_non_submit"
      ? { reason: "submit_activation", selector: action.selector }
      : { reason: "submit_control", selector: action.selector };
  }
  return null;
}

function formSelector(form: HTMLFormElement): string {
  return buildSelector(form) ?? "form";
}

/**
 * Guard for forms under rehearsal. It blocks submit events, submit-button
 * activation and same-world direct submit() calls, records every refused
 * attempt and reports it to the background coordinator through onBlocked.
 * The MAIN-world bridge marks the armed form with a DOM attribute and
 * reports page-world direct submit() calls through the direct-submit event.
 */
export class SubmitGuard {
  private readonly armedForms = new Set<HTMLFormElement>();
  private readonly blocked: BlockedAttempt[] = [];

  constructor(private readonly onBlocked: (attempt: BlockedAttempt) => void) {}

  arm(form: HTMLFormElement): void {
    if (this.armedForms.has(form)) return;
    this.armedForms.add(form);
    form.setAttribute(REHEARSAL_FORM_ATTRIBUTE, "true");
    form.addEventListener("submit", this.handleArmedSubmit, true);
    form.addEventListener("click", this.handleArmedClick, true);
    form.addEventListener(DIRECT_SUBMIT_EVENT, this.handleDirectSubmit, true);
    // Own-property override intercepts same-world direct submit() calls;
    // page-world calls arrive through the MAIN-world bridge event.
    form.submit = () => {
      this.recordBlocked({ reason: "submit_control", selector: formSelector(form) });
    };
  }

  isArmed(form: HTMLFormElement): boolean {
    return this.armedForms.has(form);
  }

  get blockedAttempts(): readonly BlockedAttempt[] {
    return this.blocked;
  }

  recordBlocked(attempt: BlockedAttempt): void {
    this.blocked.push(attempt);
    this.onBlocked(attempt);
  }

  stop(): void {
    for (const form of this.armedForms) {
      form.removeAttribute(REHEARSAL_FORM_ATTRIBUTE);
      form.removeEventListener("submit", this.handleArmedSubmit, true);
      form.removeEventListener("click", this.handleArmedClick, true);
      form.removeEventListener(DIRECT_SUBMIT_EVENT, this.handleDirectSubmit, true);
      delete (form as { submit?: HTMLFormElement["submit"] }).submit;
    }
    this.armedForms.clear();
  }

  private handleDirectSubmit = (event: Event): void => {
    if (!(event.target instanceof HTMLFormElement)) return;
    if (!this.armedForms.has(event.target)) return;
    this.recordBlocked({ reason: "submit_control", selector: formSelector(event.target) });
  };

  private handleArmedSubmit = (event: Event): void => {
    if (!(event.target instanceof HTMLFormElement)) return;
    if (!this.armedForms.has(event.target)) return;
    if (event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    this.recordBlocked({ reason: "submit_control", selector: formSelector(event.target) });
  };

  private handleArmedClick = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest("button, input");
    if (control === null || !isSubmitControl(control)) return;
    const form = control.closest("form");
    if (form === null || !this.armedForms.has(form)) return;
    event.preventDefault();
    event.stopPropagation();
    this.recordBlocked({
      reason: "submit_activation",
      selector: buildSelector(control) ?? "button",
    });
  };
}
