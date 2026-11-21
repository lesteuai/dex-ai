import { expect, test, type Page } from "@playwright/test";

/** The web suite drives the deterministic local job site served by the control plane. */

async function readSubmissionRecorder(page: Page): Promise<string> {
  const response = await page.request.get("/fixtures/job/submissions.json");
  expect(response.status()).toBe(200);
  return (await response.text()).trim();
}

test("serves the deterministic job-site pages end to end", async ({ page }) => {
  await page.goto("/fixtures/job/");
  await expect(page.getByTestId("landing-title")).toHaveText("A deterministic local job site");
  await expect(page.getByTestId("submission-guarantee")).toContainText("No application is ever submitted");

  await page.getByTestId("browse-postings").click();
  await expect(page.getByTestId("search-heading")).toBeVisible();
  await expect(page.getByTestId("filter-keywords")).toHaveValue("frontend");
  await expect(page.getByTestId("result-count")).toContainText("4 postings");
  await expect(page.getByTestId(/posting-item-/)).toHaveCount(4);

  await page.getByTestId("posting-link-frontend-engineer").click();
  await expect(page.getByTestId("posting-title")).toHaveText("Senior Frontend Engineer");
  await expect(page.getByTestId("posting-company")).toHaveText("Acme Analytics");
  await expect(page.getByTestId("posting-salary")).toHaveText("$120,000 - $150,000 per year");
  await expect(page.getByTestId("apply-link")).toBeVisible();

  await page.getByTestId("apply-link").click();
  await expect(page.getByTestId("application-heading")).toHaveText("Apply for a posting");
  await expect(page.getByTestId("field-full-name")).toBeVisible();
  await expect(page.getByTestId("field-email")).toBeVisible();
  await expect(page.getByTestId("submit-application")).toBeVisible();
  await expect(page.getByTestId("submission-note")).toContainText("the submit button never sends an application");
});

test("filling the fixture application form records no submission", async ({ page }) => {
  await page.goto("/fixtures/job/apply.html");

  await page.getByTestId("field-full-name").fill("Jordan Lee");
  await page.getByTestId("field-email").fill("jordan.lee@example.com");
  await expect(page.getByTestId("field-full-name")).toHaveValue("Jordan Lee");

  await expect(await readSubmissionRecorder(page)).toBe("[]");
});
