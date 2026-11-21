// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { BlockedAttempt } from "../shared/messages";
import { DIRECT_SUBMIT_EVENT, REHEARSAL_FORM_ATTRIBUTE } from "./snapshot";
import { SubmitGuard } from "./submit-guard";

/**
 * Submit guard tests. Forms under rehearsal must never submit: submit
 * events, submit-button activation and direct submit() calls are blocked
 * and recorded. The MAIN-world bridge is exercised with the real patched
 * prototype from submit-bridge.ts, so a page-world call that never fires
 * a submit event is still refused through the shared DOM.
 */

let onBlocked: Mock<(attempt: BlockedAttempt) => void>;
let guard: SubmitGuard;

function setApplicationForm(): HTMLFormElement {
  document.body.innerHTML = `
    <form id="application" method="post">
      <label for="full-name">Full name</label>
      <input id="full-name" name="full_name" type="text">
      <button id="submit-application" type="submit">Submit application</button>
      <button id="save-draft" type="button">Save draft</button>
    </form>
  `;
  return document.querySelector<HTMLFormElement>("#application")!;
}

function dispatchSubmit(form: HTMLFormElement): boolean {
  return form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function dispatchClick(element: Element): boolean {
  return element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  onBlocked = vi.fn<(attempt: BlockedAttempt) => void>();
  guard = new SubmitGuard(onBlocked);
});

describe("submit event blocking", () => {
  it("prevents a submit event on an armed form and records the attempt", () => {
    const form = setApplicationForm();
    guard.arm(form);

    expect(dispatchSubmit(form)).toBe(false);
    expect(guard.blockedAttempts).toEqual([{ reason: "submit_control", selector: "#application" }]);
    expect(onBlocked).toHaveBeenCalledWith({ reason: "submit_control", selector: "#application" });
  });

  it("keeps the submit from reaching page listeners", () => {
    const form = setApplicationForm();
    guard.arm(form);
    const pageSubmitSpy = vi.fn();
    form.addEventListener("submit", pageSubmitSpy);

    dispatchSubmit(form);

    expect(pageSubmitSpy).not.toHaveBeenCalled();
  });

  it("lets submits on unarmed forms pass and records nothing", () => {
    const form = setApplicationForm();
    const pageSubmitSpy = vi.fn();
    form.addEventListener("submit", pageSubmitSpy);

    expect(dispatchSubmit(form)).toBe(true);
    expect(pageSubmitSpy).toHaveBeenCalledTimes(1);
    expect(guard.blockedAttempts).toEqual([]);
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("marks the armed form for the MAIN-world bridge", () => {
    const form = setApplicationForm();
    guard.arm(form);

    expect(form.getAttribute(REHEARSAL_FORM_ATTRIBUTE)).toBe("true");
    expect(guard.isArmed(form)).toBe(true);
  });
});

describe("submit click blocking", () => {
  it("prevents a click on the submit button and records the activation", () => {
    const form = setApplicationForm();
    guard.arm(form);
    const button = document.querySelector("#submit-application")!;
    const clickSpy = vi.fn();
    button.addEventListener("click", clickSpy);

    expect(dispatchClick(button)).toBe(false);
    expect(guard.blockedAttempts).toEqual([
      { reason: "submit_activation", selector: "#submit-application" },
    ]);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("lets clicks on non-submit controls pass", () => {
    const form = setApplicationForm();
    guard.arm(form);
    const button = document.querySelector("#save-draft")!;
    const clickSpy = vi.fn();
    button.addEventListener("click", clickSpy);

    expect(dispatchClick(button)).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(guard.blockedAttempts).toEqual([]);
  });

  it("blocks a submit input click even without a submit-looking id", () => {
    const form = setApplicationForm();
    form.insertAdjacentHTML("beforeend", '<input id="finish" type="submit" value="Finish">');
    guard.arm(form);

    expect(dispatchClick(form.querySelector("#finish")!)).toBe(false);
    expect(guard.blockedAttempts).toEqual([{ reason: "submit_activation", selector: "#finish" }]);
  });

  it("ignores clicks outside any armed form", () => {
    guard.arm(setApplicationForm());
    document.body.insertAdjacentHTML(
      "beforeend",
      '<form id="other"><button id="other-send" type="submit">Send</button></form>',
    );

    expect(dispatchClick(document.querySelector("#other-send")!)).toBe(true);
    expect(guard.blockedAttempts).toEqual([]);
  });
});

describe("direct submit() blocking", () => {
  it("refuses a same-world form.submit() call on an armed form", () => {
    const form = setApplicationForm();
    guard.arm(form);

    form.submit();

    expect(guard.blockedAttempts).toEqual([{ reason: "submit_control", selector: "#application" }]);
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });
});

describe("MAIN-world bridge", () => {
  const passthroughSubmits: HTMLFormElement[] = [];

  beforeAll(async () => {
    // Stands in for the browser's real HTMLFormElement.submit so a pass
    // through the bridge is observable without a navigation.
    HTMLFormElement.prototype.submit = function recordPassthrough(this: HTMLFormElement): void {
      passthroughSubmits.push(this);
    };
    await import("./submit-bridge");
  });

  beforeEach(() => {
    passthroughSubmits.length = 0;
  });

  it("passes page-world submits through on forms outside rehearsal", () => {
    document.body.innerHTML = '<form id="newsletter"><input name="email" type="email"></form>';
    const form = document.querySelector<HTMLFormElement>("#newsletter")!;

    form.submit();

    expect(passthroughSubmits).toEqual([form]);
  });

  it("refuses a page-world submit on a form the guard marked and reports the event", () => {
    document.body.innerHTML = '<form id="application" method="post"><input name="name" type="text"></form>';
    const form = document.querySelector<HTMLFormElement>("#application")!;
    const directSubmits: Event[] = [];
    document.addEventListener(DIRECT_SUBMIT_EVENT, (event) => directSubmits.push(event));

    form.setAttribute(REHEARSAL_FORM_ATTRIBUTE, "true");
    form.submit();

    expect(passthroughSubmits).toEqual([]);
    expect(directSubmits).toHaveLength(1);
    expect(directSubmits[0]).toBeInstanceOf(Event);
    expect(directSubmits[0].target).toBe(form);
  });

  it("routes a page-world submit into the armed guard as a blocked attempt", () => {
    const form = setApplicationForm();
    guard.arm(form);

    // A page-world call resolves through the patched prototype; the
    // isolated-world own-property override never sees it.
    HTMLFormElement.prototype.submit.call(form);

    expect(guard.blockedAttempts).toEqual([{ reason: "submit_control", selector: "#application" }]);
    expect(onBlocked).toHaveBeenCalledWith({ reason: "submit_control", selector: "#application" });
    expect(passthroughSubmits).toEqual([]);
  });

  it("keeps the page working after the guard disarms the form", () => {
    const form = setApplicationForm();
    guard.arm(form);
    guard.stop();

    HTMLFormElement.prototype.submit.call(form);

    expect(passthroughSubmits).toEqual([form]);
    expect(guard.blockedAttempts).toEqual([]);
    expect(form.getAttribute(REHEARSAL_FORM_ATTRIBUTE)).toBeNull();
  });
});

describe("guard teardown", () => {
  it("stops blocking once disarmed", () => {
    const form = setApplicationForm();
    guard.arm(form);
    guard.recordBlocked({ reason: "submit_navigation", url: "https://jobs.example.test/apply/submit" });
    guard.stop();

    expect(dispatchSubmit(form)).toBe(true);
    expect(dispatchClick(document.querySelector("#submit-application")!)).toBe(true);
    // stop() disarms; the history of what was blocked stays inspectable.
    expect(guard.blockedAttempts).toEqual([
      { reason: "submit_navigation", url: "https://jobs.example.test/apply/submit" },
    ]);
    expect(guard.isArmed(form)).toBe(false);
  });

  it("notifies the coordinator on every recorded attempt", () => {
    guard.recordBlocked({ reason: "submit_activation", selector: "#submit-application" });
    guard.recordBlocked({ reason: "submit_control", selector: "#application" });

    expect(onBlocked).toHaveBeenCalledTimes(2);
    expect(guard.blockedAttempts).toHaveLength(2);
  });
});
