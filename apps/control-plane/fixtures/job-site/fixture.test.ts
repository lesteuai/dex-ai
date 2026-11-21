import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixtureDir = fileURLToPath(new URL(".", import.meta.url));

const readFixture = (name: string): string =>
  readFileSync(join(fixtureDir, name), "utf8");

const extractTestids = (html: string): string[] =>
  [...html.matchAll(/\sdata-testid="([^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );

const sharedTestids = [
  "site-header",
  "site-title",
  "site-nav",
  "nav-search",
  "nav-home",
  "site-footer",
];

const postingSlugs = [
  "frontend-engineer",
  "backend-engineer",
  "data-scientist",
  "qa-automation-engineer",
];

const postingCardTestids = (slug: string): string[] => [
  `posting-item-${slug}`,
  `posting-link-${slug}`,
  `posting-company-${slug}`,
  `posting-location-${slug}`,
  `posting-job-type-${slug}`,
  `posting-salary-${slug}`,
];

const pages: Record<string, string[]> = {
  "index.html": [
    ...sharedTestids,
    "landing-hero",
    "landing-title",
    "landing-intro",
    "browse-postings",
    "rehearsal-flow",
    "rehearsal-steps",
    "rehearsal-step-search",
    "rehearsal-step-posting",
    "rehearsal-step-apply",
    "rehearsal-step-submit",
    "submission-guarantee",
  ],
  "search.html": [
    ...sharedTestids,
    "search-heading",
    "search-form",
    "search-filters-heading",
    "search-filters",
    "filter-keywords",
    "filter-location",
    "filter-job-type",
    "filter-min-salary",
    "filter-sort",
    "filter-remote-only",
    "search-submit",
    "posting-list",
    "posting-list-heading",
    "result-count",
    ...postingSlugs.flatMap(postingCardTestids),
  ],
  "posting.html": [
    ...sharedTestids,
    "back-to-search",
    "posting-detail",
    "posting-id",
    "posting-title",
    "posting-company",
    "posting-location",
    "posting-job-type",
    "posting-salary",
    "posting-description",
    "posting-responsibilities",
    "posting-requirements",
    "posting-benefits",
    "apply-link",
    "fixture-note",
  ],
  "apply.html": [
    ...sharedTestids,
    "back-to-posting",
    "posting-summary",
    "application-heading",
    "summary-posting-id",
    "summary-posting-title",
    "summary-posting-company",
    "summary-posting-location",
    "submission-note",
    "application-form",
    "field-full-name",
    "field-email",
    "field-phone",
    "field-current-location",
    "field-portfolio-url",
    "field-years-experience",
    "field-expected-salary",
    "field-cover-letter",
    "field-consent",
    "form-actions",
    "submit-application",
    "cancel-application",
  ],
};

// A remote asset is any src or href pointing off the fixture origin.
const externalAssetPattern = /\b(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i;

describe("job-site fixture", () => {
  describe.each(Object.entries(pages))("%s", (page, requiredTestids) => {
    const html = readFixture(page);

    it("contains every required data-testid", () => {
      const present = new Set(extractTestids(html));
      const missing = requiredTestids.filter((id) => !present.has(id));
      expect(missing).toEqual([]);
    });

    it("has no duplicate data-testid within the page", () => {
      const testids = extractTestids(html);
      const duplicates = testids.filter(
        (id, index) => testids.indexOf(id) !== index,
      );
      expect(duplicates).toEqual([]);
    });

    it("contains no script tags", () => {
      expect(html).not.toMatch(/<script[\s>]/i);
    });

    it("references no external assets", () => {
      expect(html).not.toMatch(externalAssetPattern);
    });
  });

  it("submissions.json is an empty JSON array", () => {
    const parsed: unknown = JSON.parse(readFixture("submissions.json"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([]);
  });

  it("styles.css pulls in no remote stylesheet or url", () => {
    const css = readFixture("styles.css");
    expect(css).not.toMatch(/@import/i);
    expect(css).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\//i);
  });
});
