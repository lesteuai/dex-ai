// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { executeRehearsalAction } from "./rehearsal-executor";

/**
 * Approved fill execution tests. Every action is classified before it runs:
 * allowed fills, focus, clicks, scrolls and navigation execute against a
 * happy-dom document, while submit-shaped targets are refused with a
 * blocked attempt instead of touching the page.
 */

const PAGE_URL = "https://jobs.example.test/postings/1/apply";

let navigate: Mock<(url: string) => void>;

function deps(): Parameters<typeof executeRehearsalAction>[1] {
  return { doc: document, navigate };
}

function setApplicationForm(): void {
  document.body.innerHTML = `
    <form id="application" method="post">
      <label for="full-name">Full name</label>
      <input id="full-name" name="full_name" type="text">
      <label for="relocate">Relocate</label>
      <input id="relocate" name="relocate" type="checkbox">
      <label for="notice">Notice period</label>
      <select id="notice" name="notice">
        <option value="immediate">Immediate</option>
        <option value="one-month">One month</option>
      </select>
      <label for="cover">Cover letter</label>
      <textarea id="cover" name="cover"></textarea>
      <button id="submit-application" type="submit">Submit application</button>
      <button id="save-draft" type="button">Save draft</button>
    </form>
  `;
}

beforeEach(() => {
  setApplicationForm();
  navigate = vi.fn<(url: string) => void>();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("approved fill execution", () => {
  it("fills a text input and fires input and change events", async () => {
    const input = document.querySelector<HTMLInputElement>("#full-name")!;
    const seenEvents: string[] = [];
    input.addEventListener("input", () => seenEvents.push("input"));
    input.addEventListener("change", () => seenEvents.push("change"));

    const result = await executeRehearsalAction({ kind: "fill", selector: "#full-name", value: "Ada Lovelace" }, deps());

    expect(result).toEqual({ ok: true });
    expect(input.value).toBe("Ada Lovelace");
    expect(seenEvents).toEqual(["input", "change"]);
  });

  it("fills a select and a textarea", async () => {
    const select = document.querySelector<HTMLSelectElement>("#notice")!;
    const textarea = document.querySelector<HTMLTextAreaElement>("#cover")!;

    await executeRehearsalAction({ kind: "fill", selector: "#notice", value: "one-month" }, deps());
    await executeRehearsalAction({ kind: "fill", selector: "#cover", value: "Short and specific" }, deps());

    expect(select.value).toBe("one-month");
    expect(textarea.value).toBe("Short and specific");
  });

  it("checks a checkbox from a truthy fill value", async () => {
    const checkbox = document.querySelector<HTMLInputElement>("#relocate")!;

    await executeRehearsalAction({ kind: "fill", selector: "#relocate", value: "true" }, deps());
    expect(checkbox.checked).toBe(true);

    await executeRehearsalAction({ kind: "fill", selector: "#relocate", value: "false" }, deps());
    expect(checkbox.checked).toBe(false);
  });

  it("refuses a fill on an element that is not a form field", async () => {
    document.body.insertAdjacentHTML("beforeend", '<p id="not-a-field">Text</p>');

    const result = await executeRehearsalAction({ kind: "fill", selector: "#not-a-field", value: "x" }, deps());

    expect(result).toEqual({ ok: false, error: 'Fill target "#not-a-field" is not a form field' });
  });

  it("reports a missing element without touching the page", async () => {
    const result = await executeRehearsalAction({ kind: "fill", selector: "#missing", value: "x" }, deps());

    expect(result).toEqual({ ok: false, error: 'No element matches selector "#missing"' });
  });
});

describe("other permitted actions", () => {
  it("navigates through the injected dependency", async () => {
    const result = await executeRehearsalAction(
      { kind: "navigate", url: "https://jobs.example.test/postings/2" },
      deps(),
    );

    expect(result).toEqual({ ok: true });
    expect(navigate).toHaveBeenCalledWith("https://jobs.example.test/postings/2");
  });

  it("focuses the target element", async () => {
    const result = await executeRehearsalAction({ kind: "focus", selector: "#full-name" }, deps());

    expect(result).toEqual({ ok: true });
    expect(document.activeElement).toBe(document.querySelector("#full-name"));
  });

  it("clicks a non-submit button", async () => {
    const clickSpy = vi.fn();
    document.querySelector("#save-draft")!.addEventListener("click", clickSpy);

    const result = await executeRehearsalAction({ kind: "click_non_submit", selector: "#save-draft" }, deps());

    expect(result).toEqual({ ok: true });
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("scrolls the page or one element", async () => {
    vi.spyOn(window, "scrollBy");
    const elementScroll = vi.fn();
    document.querySelector("#cover")!.scrollIntoView = elementScroll;

    const pageScroll = await executeRehearsalAction({ kind: "scroll", deltaY: 300 }, deps());
    const elementResult = await executeRehearsalAction({ kind: "scroll", selector: "#cover", deltaY: 0 }, deps());

    expect(pageScroll).toEqual({ ok: true });
    expect(elementResult).toEqual({ ok: true });
    expect(window.scrollBy).toHaveBeenCalledWith({ top: 300 });
    expect(elementScroll).toHaveBeenCalledWith({ block: "center" });
  });

  it("waits for the requested duration", async () => {
    vi.useFakeTimers();
    const pending = executeRehearsalAction({ kind: "wait", durationMs: 50 }, deps());
    await vi.advanceTimersByTimeAsync(49);
    const early = await Promise.race([pending, Promise.resolve("pending")]);
    expect(early).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true });
  });
});

describe("submit-shaped actions are blocked before execution", () => {
  it("blocks navigation whose url says submit", async () => {
    const result = await executeRehearsalAction(
      { kind: "navigate", url: `${PAGE_URL}/submit` },
      deps(),
    );

    expect(result).toEqual({ ok: false, blocked: true, attempt: { reason: "submit_navigation", url: `${PAGE_URL}/submit` } });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("blocks a click on a selector that says submit", async () => {
    const clickSpy = vi.fn();
    document.querySelector("#submit-application")!.addEventListener("click", clickSpy);

    const result = await executeRehearsalAction(
      { kind: "click_non_submit", selector: "#submit-application" },
      deps(),
    );

    expect(result).toEqual({
      ok: false,
      blocked: true,
      attempt: { reason: "submit_activation", selector: "#submit-application" },
    });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("blocks a fill aimed at a submit control", async () => {
    const result = await executeRehearsalAction(
      { kind: "fill", selector: '[name="submit_btn"]', value: "x" },
      deps(),
    );

    expect(result).toEqual({
      ok: false,
      blocked: true,
      attempt: { reason: "submit_control", selector: '[name="submit_btn"]' },
    });
  });

  it("blocks a click on a control the DOM reveals as a submit control", async () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<button id="confirm" type="submit">Confirm and send application</button>',
    );
    const clickSpy = vi.fn();
    document.querySelector("#confirm")!.addEventListener("click", clickSpy);

    const result = await executeRehearsalAction({ kind: "click_non_submit", selector: "#confirm" }, deps());

    expect(result).toEqual({ ok: false, blocked: true, attempt: { reason: "submit_activation", selector: "#confirm" } });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("does not block navigation or fills away from the submit path", async () => {
    const fill = await executeRehearsalAction({ kind: "fill", selector: "#full-name", value: "Ada" }, deps());
    const move = await executeRehearsalAction(
      { kind: "navigate", url: "https://jobs.example.test/postings/2" },
      deps(),
    );

    expect(fill).toEqual({ ok: true });
    expect(move).toEqual({ ok: true });
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
