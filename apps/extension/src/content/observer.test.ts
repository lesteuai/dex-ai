// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeRehearsalAction } from "./rehearsal-executor";
import { SubmitGuard } from "./submit-guard";
import { collectSearchFilters, startObservation, type ObservationHandle, type ObservedPayload } from "./observer";

/**
 * DOM event detection tests. A happy-dom document stands in for the job-site
 * page: user search submits, posting opens and field fills must surface as
 * captured payloads, while rehearsal-driven fills and guarded forms stay out
 * of the user's timeline.
 */

const PAGE_URL = "https://jobs.example.test/search";

let emitted: ObservedPayload[];
let handles: ObservationHandle[];

function observe(pageUrl: string = PAGE_URL, isFormUnderRehearsal: (form: HTMLFormElement) => boolean = () => false) {
  const handle = startObservation({
    doc: document,
    pageUrl,
    emit: (observation) => emitted.push(observation),
    isFormUnderRehearsal,
  });
  handles.push(handle);
  return handle;
}

function fill(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void {
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function submitForm(form: HTMLFormElement): boolean {
  return form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function setSearchPage(): HTMLFormElement {
  document.body.innerHTML = `
    <form id="search-form" method="get" action="/search">
      <input id="query" name="q" type="text">
      <select id="location" name="location">
        <option value="">Anywhere</option>
        <option value="Berlin">Berlin</option>
      </select>
      <label><input id="remote" name="remote" type="checkbox"> Remote only</label>
      <input id="search-submit" name="search-submit" type="submit" value="Search">
    </form>
  `;
  return document.querySelector<HTMLFormElement>("#search-form")!;
}

beforeEach(() => {
  document.title = "";
  document.body.innerHTML = "";
  emitted = [];
  handles = [];
});

afterEach(() => {
  for (const handle of handles) handle.stop();
});

describe("collectSearchFilters", () => {
  it("splits a submitted form into a query and named filters", () => {
    const form = setSearchPage();
    (form.querySelector<HTMLInputElement>("#query")!).value = "platform engineer";
    (form.querySelector<HTMLSelectElement>("#location")!).value = "Berlin";
    (form.querySelector<HTMLInputElement>("#remote")!).checked = true;

    expect(collectSearchFilters(form)).toEqual({
      query: "platform engineer",
      filters: { location: "Berlin", remote: "true" },
    });
  });

  it("uses the first filled text field as the query without a query-named field", () => {
    document.body.innerHTML = `
      <form id="title-search">
        <input id="title" name="title" type="text" value="rust developer">
        <input id="company" name="company" type="text" value="Acme">
      </form>
    `;
    const form = document.querySelector<HTMLFormElement>("#title-search")!;

    expect(collectSearchFilters(form)).toEqual({
      query: "rust developer",
      filters: { title: "rust developer", company: "Acme" },
    });
  });

  it("returns null when nothing is filled", () => {
    const form = setSearchPage();
    expect(collectSearchFilters(form)).toBeNull();
  });

  it("skips password, file, hidden and submit inputs", () => {
    document.body.innerHTML = `
      <form id="sensitive">
        <input name="secret" type="password" value="hunter2">
        <input name="resume" type="file">
        <input name="tracking" type="hidden" value="abc">
        <input name="go" type="submit" value="Go">
      </form>
    `;
    const form = document.querySelector<HTMLFormElement>("#sensitive")!;

    expect(collectSearchFilters(form)).toBeNull();
  });
});

describe("search filter capture", () => {
  it("emits one search_filter payload for a GET form submit", () => {
    const form = setSearchPage();
    (form.querySelector<HTMLInputElement>("#query")!).value = "backend";
    (form.querySelector<HTMLInputElement>("#remote")!).checked = true;
    observe();

    expect(submitForm(form)).toBe(true);
    expect(emitted).toEqual([
      {
        type: "search_filter",
        payload: { pageUrl: PAGE_URL, query: "backend", filters: { remote: "true" } },
      },
    ]);
  });

  it("ignores POST form submits", () => {
    document.body.innerHTML = '<form id="apply" method="post"><input name="email" type="email" value="a@b.test"></form>';
    const form = document.querySelector<HTMLFormElement>("#apply")!;
    observe();

    expect(submitForm(form)).toBe(true);
    expect(emitted).toEqual([]);
  });

  it("stops capturing submits and changes once observation stops", () => {
    const form = setSearchPage();
    const handle = observe();
    handle.stop();

    expect(submitForm(form)).toBe(true);
    expect(emitted).toEqual([]);
  });

  it("does not capture a submit on a form under rehearsal", () => {
    const form = setSearchPage();
    (form.querySelector<HTMLInputElement>("#query")!).value = "backend";
    const guard = new SubmitGuard(() => {});
    guard.arm(form);
    observe(PAGE_URL, (candidate) => guard.isArmed(candidate));

    expect(submitForm(form)).toBe(false);
    expect(emitted).toEqual([]);
    expect(guard.blockedAttempts).toEqual([{ reason: "submit_control", selector: "#search-form" }]);
  });
});

describe("posting open capture", () => {
  it("emits a posting_opened payload when the page carries an apply marker", () => {
    document.title = "Backend Engineer";
    document.body.innerHTML = '<h1>Backend Engineer</h1><a id="apply" href="/apply">Apply now</a>';
    observe("https://jobs.example.test/postings/1");

    expect(emitted).toEqual([
      { type: "posting_opened", payload: { pageUrl: "https://jobs.example.test/postings/1", title: "Backend Engineer" } },
    ]);
  });

  it("omits the title when the document has none", () => {
    document.body.innerHTML = '<a id="apply" href="/apply">Apply</a>';
    observe("https://jobs.example.test/postings/1");

    expect(emitted).toEqual([{ type: "posting_opened", payload: { pageUrl: "https://jobs.example.test/postings/1" } }]);
  });

  it("emits nothing on a search page without an apply marker", () => {
    setSearchPage();
    observe();

    expect(emitted).toEqual([]);
  });
});

describe("field fill capture", () => {
  it("emits a field_filled payload with selector, label and value", () => {
    document.body.innerHTML = `
      <form id="application" method="post">
        <label for="full-name">Full name</label>
        <input id="full-name" name="full_name" type="text">
      </form>
    `;
    observe("https://jobs.example.test/postings/1/apply");
    const input = document.querySelector<HTMLInputElement>("#full-name")!;
    input.value = "Ada Lovelace";

    fill(input);
    expect(emitted).toEqual([
      {
        type: "field_filled",
        payload: {
          pageUrl: "https://jobs.example.test/postings/1/apply",
          selector: "#full-name",
          label: "Full name",
          fieldType: "text",
          value: "Ada Lovelace",
        },
      },
    ]);
  });

  it("captures checkboxes and selects with their string value", () => {
    document.body.innerHTML = `
      <form id="application" method="post">
        <label><input id="relocate" name="relocate" type="checkbox"> Relocate</label>
        <label for="notice">Notice period</label>
        <select id="notice" name="notice"><option value="immediate">Immediate</option></select>
      </form>
    `;
    observe();
    const checkbox = document.querySelector<HTMLInputElement>("#relocate")!;
    checkbox.checked = true;
    fill(checkbox);
    fill(document.querySelector<HTMLSelectElement>("#notice")!);

    expect(emitted).toEqual([
      {
        type: "field_filled",
        payload: { pageUrl: PAGE_URL, selector: "#relocate", label: "Relocate", fieldType: "checkbox", value: "true" },
      },
      {
        type: "field_filled",
        payload: { pageUrl: PAGE_URL, selector: "#notice", label: "Notice period", fieldType: "select", value: "immediate" },
      },
    ]);
  });

  it("falls back to aria-label and placeholder for the label", () => {
    document.body.innerHTML = `
      <form id="application" method="post">
        <input id="email" name="email" type="email" aria-label="Email address">
        <input id="cover" name="cover" type="text" placeholder="Cover letter">
      </form>
    `;
    observe();
    const email = document.querySelector<HTMLInputElement>("#email")!;
    email.value = "ada@example.test";
    fill(email);
    const cover = document.querySelector<HTMLInputElement>("#cover")!;
    cover.value = "Short one";
    fill(cover);

    expect(emitted.map((entry) => entry.payload)).toEqual([
      expect.objectContaining({ selector: "#email", label: "Email address" }),
      expect.objectContaining({ selector: "#cover", label: "Cover letter" }),
    ]);
  });

  it("ignores password, file, hidden and submit controls", () => {
    document.body.innerHTML = `
      <form id="sensitive" method="post">
        <input id="pin" name="pin" type="password">
        <input id="cv" name="cv" type="file">
        <input id="track" name="track" type="hidden">
        <input id="go" name="go" type="submit">
      </form>
    `;
    observe();
    for (const id of ["pin", "cv", "track", "go"]) fill(document.querySelector<HTMLInputElement>(`#${id}`)!);

    expect(emitted).toEqual([]);
  });

  it("ignores a control without a stable selector handle", () => {
    document.body.innerHTML = '<form id="application" method="post"><input type="text"></form>';
    observe();
    const input = document.querySelector<HTMLInputElement>("input")!;
    input.value = "no handle";
    fill(input);

    expect(emitted).toEqual([]);
  });
});

describe("rehearsal fills stay out of the user timeline", () => {
  it("does not emit field_filled for a fill executed by the rehearsal executor", async () => {
    document.body.innerHTML = `
      <form id="application" method="post">
        <label for="full-name">Full name</label>
        <input id="full-name" name="full_name" type="text">
      </form>
    `;
    observe();

    const result = await executeRehearsalAction(
      { kind: "fill", selector: "#full-name", value: "Grace Hopper" },
      { doc: document, navigate: () => {} },
    );

    expect(result).toEqual({ ok: true });
    expect(emitted).toEqual([]);
    expect(document.querySelector<HTMLInputElement>("#full-name")!.value).toBe("Grace Hopper");
  });

  it("keeps observing user fills once the rehearsal fill is done", () => {
    document.body.innerHTML = `
      <form id="application" method="post">
        <label for="cover">Cover letter</label>
        <input id="cover" name="cover" type="text">
      </form>
    `;
    observe("https://jobs.example.test/postings/1/apply");

    void executeRehearsalAction(
      { kind: "fill", selector: "#cover", value: "agent draft" },
      { doc: document, navigate: () => {} },
    );
    const cover = document.querySelector<HTMLInputElement>("#cover")!;
    cover.value = "my own words";
    fill(cover);

    expect(emitted).toEqual([
      {
        type: "field_filled",
        payload: {
          pageUrl: "https://jobs.example.test/postings/1/apply",
          selector: "#cover",
          label: "Cover letter",
          fieldType: "text",
          value: "my own words",
        },
      },
    ]);
  });
});
