/**
 * DOM to descriptor mapping for the posting under observation or rehearsal.
 * The snapshot shape mirrors pageSnapshotSchema in the control-plane
 * rehearsal planner: it is the ground truth for which controls exist and
 * which of them would submit the managed form.
 */

const SUBMIT_IDENTIFIER_PATTERN = /submit/i;
const POSTING_MARKER_PATTERN = /apply/i;
const SNAPSHOT_MAX_ENTRIES = 200;

/**
 * MAIN-world submit bridge vocabulary. The bridge dispatches the event and
 * reads the attribute; the isolated-world guard sets the attribute and
 * listens for the event. Both worlds share the DOM, so no message cloning
 * is involved.
 */
export const DIRECT_SUBMIT_EVENT = "dex-ai:direct-submit";
export const REHEARSAL_FORM_ATTRIBUTE = "data-dex-ai-rehearsal";

export interface SnapshotField {
  selector: string;
  label?: string;
  fieldType?: string;
  // The extension marks controls that would submit the managed form.
  submits?: boolean;
}

export interface SnapshotLink {
  selector: string;
  url: string;
}

export interface PostingSnapshot {
  url: string;
  title?: string;
  fields: SnapshotField[];
  links?: SnapshotLink[];
}

function escapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** Stable selector for one element, or null when the element has no handle. */
export function buildSelector(element: Element): string | null {
  if (element.id !== "") return `#${element.id}`;
  const testId = element.getAttribute("data-testid");
  if (testId !== null && testId !== "") return `[data-testid="${escapeAttributeValue(testId)}"]`;
  const name = element.getAttribute("name");
  if (name !== null && name !== "") return `[name="${escapeAttributeValue(name)}"]`;
  return null;
}

/**
 * A control that would submit the managed form. The submit word can sit in
 * the id, name, test id or button label, matching the control-plane
 * classifier that refuses submit-shaped rehearsal actions.
 */
export function isSubmitControl(element: Element): boolean {
  if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
    if (element.type === "submit" || element.type === "image") return true;
  }
  const identifier = [
    element.id,
    element.getAttribute("name"),
    element.getAttribute("data-testid"),
    element instanceof HTMLButtonElement ? element.textContent : null,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" ");
  return SUBMIT_IDENTIFIER_PATTERN.test(identifier);
}

export function describeFieldType(element: Element): string {
  return element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase();
}

/** Human label for a form control, from any of the common label sources. */
export function findFieldLabel(doc: Document, element: Element): string | undefined {
  const id = element.getAttribute("id");
  if (id !== null && id !== "") {
    const label = doc.querySelector(`label[for="${escapeAttributeValue(id)}"]`);
    const text = label?.textContent?.trim();
    if (text) return text;
  }
  const wrapping = element.closest("label");
  const wrappingText = wrapping?.textContent?.trim();
  if (wrappingText) return wrappingText;
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel !== null && ariaLabel !== "") return ariaLabel;
  const placeholder = element.getAttribute("placeholder");
  if (placeholder !== null && placeholder !== "") return placeholder;
  return undefined;
}

/**
 * Posting detection heuristic: job detail and application pages carry an
 * apply marker in a link, button or heading. Search and index pages carry
 * none, so they stay capture-only pages.
 */
export function looksLikePostingPage(doc: Document): boolean {
  for (const marker of doc.querySelectorAll("a[href], button, h1")) {
    if (POSTING_MARKER_PATTERN.test(marker.textContent ?? "")) return true;
    if (POSTING_MARKER_PATTERN.test(marker.getAttribute("href") ?? "")) return true;
  }
  return false;
}

function absoluteUrl(href: string, baseUri: string): string | null {
  try {
    const url = new URL(href, baseUri);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Build the posting snapshot the rehearsal planner replans from. */
export function buildPageSnapshot(doc: Document, pageUrl: string): PostingSnapshot {
  const fields: SnapshotField[] = [];
  for (const element of Array.from(doc.querySelectorAll("input, select, textarea, button"))) {
    if (fields.length >= SNAPSHOT_MAX_ENTRIES) break;
    const selector = buildSelector(element);
    if (selector === null) continue;
    const label = findFieldLabel(doc, element);
    fields.push({
      selector,
      ...(label === undefined ? {} : { label }),
      fieldType: describeFieldType(element),
      ...(isSubmitControl(element) ? { submits: true } : {}),
    });
  }

  const links: SnapshotLink[] = [];
  for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
    if (links.length >= SNAPSHOT_MAX_ENTRIES) break;
    const selector = buildSelector(anchor);
    if (selector === null) continue;
    const url = absoluteUrl(anchor.getAttribute("href") ?? "", doc.baseURI);
    if (url === null) continue;
    links.push({ selector, url });
  }

  return {
    url: pageUrl,
    ...(doc.title === "" ? {} : { title: doc.title }),
    fields,
    ...(links.length === 0 ? {} : { links }),
  };
}
