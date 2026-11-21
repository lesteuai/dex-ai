// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DIRECT_SUBMIT_EVENT,
  REHEARSAL_FORM_ATTRIBUTE,
  buildPageSnapshot,
  buildSelector,
  describeFieldType,
  findFieldLabel,
  isSubmitControl,
  looksLikePostingPage,
} from "./snapshot";

/**
 * Page snapshot shape tests. The snapshot is the rehearsal planner's ground
 * truth: every captured field needs a stable selector, and every control
 * that would submit the managed form is marked as such.
 */

beforeEach(() => {
  document.title = "";
  document.body.innerHTML = "";
});

describe("buildSelector", () => {
  it("prefers the id, then the test id, then the name", () => {
    document.body.innerHTML = `
      <input id="email" name="address" data-testid="contact-email">
      <input name="phone" data-testid="contact-phone">
      <input data-testid="contact-fax">
    `;
    const [byId, byTestId, byName] = Array.from(document.querySelectorAll("input"));

    expect(buildSelector(byId)).toBe("#email");
    expect(buildSelector(byTestId)).toBe('[data-testid="contact-phone"]');
    expect(buildSelector(byName)).toBe('[data-testid="contact-fax"]');
  });

  it("escapes double quotes and backslashes in attribute selectors", () => {
    document.body.innerHTML = '<input data-testid=\'contact "work" \\ line\'>';
    expect(buildSelector(document.querySelector("input")!)).toBe('[data-testid="contact \\"work\\" \\\\ line"]');
  });

  it("returns null for an element without any handle", () => {
    document.body.innerHTML = "<input>";
    expect(buildSelector(document.querySelector("input")!)).toBeNull();
  });
});

describe("isSubmitControl", () => {
  it("marks submit and image inputs", () => {
    document.body.innerHTML = `
      <input id="send" type="submit">
      <input id="badge" type="image" alt="Send">
      <input id="name" type="text">
    `;
    const [submitInput, imageInput, textInput] = Array.from(document.querySelectorAll("input"));

    expect(isSubmitControl(submitInput)).toBe(true);
    expect(isSubmitControl(imageInput)).toBe(true);
    expect(isSubmitControl(textInput)).toBe(false);
  });

  it("marks buttons whose type, name, test id or label says submit", () => {
    document.body.innerHTML = `
      <button id="by-type" type="submit">Send application</button>
      <button id="by-name" name="submit_application">Confirm</button>
      <button id="by-test-id" data-testid="submit-app">Confirm</button>
      <button id="by-label">Submit application</button>
      <button id="plain" type="button">Next step</button>
    `;

    expect(isSubmitControl(document.querySelector("#by-type")!)).toBe(true);
    expect(isSubmitControl(document.querySelector("#by-name")!)).toBe(true);
    expect(isSubmitControl(document.querySelector("#by-test-id")!)).toBe(true);
    expect(isSubmitControl(document.querySelector("#by-label")!)).toBe(true);
    expect(isSubmitControl(document.querySelector("#plain")!)).toBe(false);
  });

  it("never treats a plain text field as a submit control", () => {
    document.body.innerHTML = '<input id="resume-link" name="resume_link" type="url">';
    expect(isSubmitControl(document.querySelector("#resume-link")!)).toBe(false);
  });
});

describe("findFieldLabel", () => {
  it("prefers the explicit label, then the wrapping label, aria-label and placeholder", () => {
    document.body.innerHTML = `
      <label for="a">Explicit label</label>
      <input id="a" aria-label="Aria label" placeholder="Placeholder">
      <label>Wrapping label<input id="b" aria-label="Aria label"></label>
      <input id="c" aria-label="Aria label" placeholder="Placeholder">
      <input id="d" placeholder="Placeholder">
      <input id="e">
    `;

    expect(findFieldLabel(document, document.querySelector<HTMLInputElement>("#a")!)).toBe("Explicit label");
    expect(findFieldLabel(document, document.querySelector<HTMLInputElement>("#b")!)).toBe("Wrapping label");
    expect(findFieldLabel(document, document.querySelector<HTMLInputElement>("#c")!)).toBe("Aria label");
    expect(findFieldLabel(document, document.querySelector<HTMLInputElement>("#d")!)).toBe("Placeholder");
    expect(findFieldLabel(document, document.querySelector<HTMLInputElement>("#e")!)).toBeUndefined();
  });
});

describe("looksLikePostingPage", () => {
  it("detects apply markers in links, buttons and headings", () => {
    document.body.innerHTML = '<a id="apply" href="/apply">Apply now</a>';
    expect(looksLikePostingPage(document)).toBe(true);

    document.body.innerHTML = "<button>Apply for this role</button>";
    expect(looksLikePostingPage(document)).toBe(true);

    document.body.innerHTML = "<h1>How to apply</h1>";
    expect(looksLikePostingPage(document)).toBe(true);
  });

  it("treats a search or index page as capture-only", () => {
    document.body.innerHTML = `
      <form id="search"><input name="q" type="text"><button type="submit">Search jobs</button></form>
      <a href="/postings/2">Backend Engineer</a>
    `;
    expect(looksLikePostingPage(document)).toBe(false);
  });
});

describe("buildPageSnapshot", () => {
  function setPostingPage(): void {
    document.title = "Backend Engineer";
    document.body.innerHTML = `
      <h1>Backend Engineer</h1>
      <a id="apply" href="/apply">Apply now</a>
      <a id="next" href="https://jobs.example.test/postings/2">Next posting</a>
      <form id="application" method="post">
        <label for="full-name">Full name</label>
        <input id="full-name" name="full_name" type="text">
        <label for="notice">Notice period</label>
        <select id="notice" name="notice"><option value="immediate">Immediate</option></select>
        <button id="submit-application" type="submit">Submit application</button>
        <button id="save-draft" type="button">Save draft</button>
        <button>Anonymous</button>
      </form>
    `;
  }

  it("captures fields with selector, label and type, and marks submit controls", () => {
    setPostingPage();

    const snapshot = buildPageSnapshot(document, "https://jobs.example.test/postings/1/apply");

    expect(snapshot.url).toBe("https://jobs.example.test/postings/1/apply");
    expect(snapshot.title).toBe("Backend Engineer");
    expect(snapshot.fields).toEqual([
      { selector: "#full-name", label: "Full name", fieldType: "text" },
      { selector: "#notice", label: "Notice period", fieldType: "select" },
      { selector: "#submit-application", fieldType: "button", submits: true },
      { selector: "#save-draft", fieldType: "button" },
    ]);
  });

  it("captures links as absolute http(s) urls resolved against the page", () => {
    setPostingPage();

    const snapshot = buildPageSnapshot(document, "https://jobs.example.test/postings/1/apply");

    expect(snapshot.links).toEqual([
      { selector: "#apply", url: new URL("/apply", document.baseURI).toString() },
      { selector: "#next", url: "https://jobs.example.test/postings/2" },
    ]);
  });

  it("omits the title and the links when there are none", () => {
    document.body.innerHTML = '<form id="application"><input id="full-name" type="text"></form>';

    const snapshot = buildPageSnapshot(document, "https://jobs.example.test/postings/1/apply");

    expect(snapshot.title).toBeUndefined();
    expect(snapshot.links).toBeUndefined();
    expect(snapshot.fields).toEqual([{ selector: "#full-name", fieldType: "text" }]);
  });

  it("keeps the bridge vocabulary exported for both worlds", () => {
    // The MAIN-world bridge and the isolated-world guard share the DOM only;
    // the event name and attribute must stay in sync between the two files.
    expect(DIRECT_SUBMIT_EVENT).toBe("dex-ai:direct-submit");
    expect(REHEARSAL_FORM_ATTRIBUTE).toBe("data-dex-ai-rehearsal");
  });

  it("describes field types from the input type or tag name", () => {
    document.body.innerHTML = '<input id="a" type="email"><textarea id="b"></textarea>';
    expect(describeFieldType(document.querySelector("#a")!)).toBe("email");
    expect(describeFieldType(document.querySelector("#b")!)).toBe("textarea");
  });
});
