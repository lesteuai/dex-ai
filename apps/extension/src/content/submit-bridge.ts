import { DIRECT_SUBMIT_EVENT, REHEARSAL_FORM_ATTRIBUTE } from "./snapshot";

/**
 * MAIN-world submit bridge, declared in the manifest with world "MAIN" and
 * run_at "document_start". Page code can call HTMLFormElement.submit()
 * directly, which fires no submit event, so the isolated-world guard
 * cannot see it. This bridge patches the page-world prototype before page
 * scripts run: on a form the guard marked with the rehearsal attribute it
 * refuses the call and reports it through a bubbling custom event whose
 * target is the form element both worlds share. Calls on any other form
 * pass through unchanged, so the page keeps working while no rehearsal is
 * active.
 */

const originalSubmit = HTMLFormElement.prototype.submit;

HTMLFormElement.prototype.submit = function patchedSubmit(this: HTMLFormElement): void {
  if (this.hasAttribute(REHEARSAL_FORM_ATTRIBUTE)) {
    this.dispatchEvent(new CustomEvent(DIRECT_SUBMIT_EVENT, { bubbles: true }));
    return;
  }
  originalSubmit.call(this);
};
