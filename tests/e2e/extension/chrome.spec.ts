import { test } from "@playwright/test";
import { defineExtensionSuite } from "./public-posting.smoke";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "The Chrome extension suite runs only under the Chromium project",
);

defineExtensionSuite("chrome");
