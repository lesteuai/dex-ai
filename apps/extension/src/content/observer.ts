import type { FieldFilledPayload, PostingOpenedPayload, SearchFilterPayload } from "@dex-ai/shared";
import { isRehearsalDriving } from "./rehearsal-executor";
import { buildSelector, describeFieldType, findFieldLabel, looksLikePostingPage } from "./snapshot";

/**
 * Captures searches and filters, postings opened and field fills from the
 * page DOM. Rehearsal fills are excluded through the driving flag, so the
 * timeline keeps user behavior and agent actions apart.
 */

/** One captured observation, before the envelope wraps it. */
export type ObservedPayload =
  | { type: "search_filter"; payload: SearchFilterPayload }
  | { type: "posting_opened"; payload: PostingOpenedPayload }
  | { type: "field_filled"; payload: FieldFilledPayload };

export interface ObservationDeps {
  doc: Document;
  pageUrl: string;
  emit: (observation: ObservedPayload) => void;
  /** Armed rehearsal forms are guarded, not captured as searches. */
  isFormUnderRehearsal: (form: HTMLFormElement) => boolean;
}

export interface ObservationHandle {
  stop(): void;
}

// Password and file values stay out of the captured events.
const IGNORED_INPUT_TYPES = new Set(["submit", "button", "reset", "hidden", "file", "password", "image"]);
const QUERY_NAME_PATTERN = /keyword|query|search|\bq\b/i;

function isFormControl(
  element: EventTarget | null,
): element is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  );
}

function isCheckboxOrRadio(control: HTMLInputElement): boolean {
  return control.type === "checkbox" || control.type === "radio";
}

/**
 * Split a submitted form into a query and filter record. The first
 * query-named or first text field becomes the query; every other filled
 * control becomes a filter keyed by its name.
 */
export function collectSearchFilters(
  form: HTMLFormElement,
): { query?: string; filters: Record<string, string> } | null {
  const filters: Record<string, string> = {};
  let query: string | undefined;
  let firstTextValue: string | undefined;

  for (const control of Array.from(form.elements)) {
    if (!isFormControl(control)) continue;
    const name = control.getAttribute("name");
    if (name === null || name === "") continue;
    if (control instanceof HTMLInputElement && IGNORED_INPUT_TYPES.has(control.type)) continue;

    if (control instanceof HTMLInputElement && isCheckboxOrRadio(control)) {
      if (control.checked) filters[name] = "true";
      continue;
    }
    const value = control.value;
    if (value === "") continue;

    const isText = control instanceof HTMLInputElement && (control.type === "text" || control.type === "search");
    if (isText && QUERY_NAME_PATTERN.test(name)) {
      query ??= value;
      continue;
    }
    if (isText) {
      firstTextValue ??= value;
      filters[name] = value;
      continue;
    }
    filters[name] = value;
  }

  query ??= firstTextValue;
  if (query === undefined && Object.keys(filters).length === 0) return null;
  return query === undefined ? { filters } : { query, filters };
}

export function startObservation(deps: ObservationDeps): ObservationHandle {
  // A GET form submit is a search or filter use; the application form under
  // rehearsal posts and is guarded instead.
  const handleSubmit = (event: Event): void => {
    if (isRehearsalDriving()) return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.method.toLowerCase() !== "get") return;
    if (deps.isFormUnderRehearsal(form)) return;
    const captured = collectSearchFilters(form);
    if (captured === null) return;
    deps.emit({ type: "search_filter", payload: { pageUrl: deps.pageUrl, ...captured } });
  };

  const handleChange = (event: Event): void => {
    if (isRehearsalDriving()) return;
    const control = event.target;
    if (!isFormControl(control)) return;
    if (control instanceof HTMLInputElement && IGNORED_INPUT_TYPES.has(control.type)) return;
    const selector = buildSelector(control);
    if (selector === null) return;
    const value =
      control instanceof HTMLInputElement && isCheckboxOrRadio(control) ? String(control.checked) : control.value;
    const label = findFieldLabel(deps.doc, control);
    deps.emit({
      type: "field_filled",
      payload: {
        pageUrl: deps.pageUrl,
        selector,
        ...(label === undefined ? {} : { label }),
        fieldType: describeFieldType(control),
        value,
      },
    });
  };

  deps.doc.addEventListener("submit", handleSubmit, true);
  deps.doc.addEventListener("change", handleChange, true);

  if (looksLikePostingPage(deps.doc)) {
    deps.emit({
      type: "posting_opened",
      payload: {
        pageUrl: deps.pageUrl,
        ...(deps.doc.title === "" ? {} : { title: deps.doc.title }),
      },
    });
  }

  return {
    stop(): void {
      deps.doc.removeEventListener("submit", handleSubmit, true);
      deps.doc.removeEventListener("change", handleChange, true);
    },
  };
}
