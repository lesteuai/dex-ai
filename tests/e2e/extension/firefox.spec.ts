import { test } from "@playwright/test";
import { defineExtensionSuite } from "./public-posting.smoke";

test.skip(
  ({ browserName }) => browserName !== "firefox",
  "The Firefox extension suite runs only under the Firefox project",
);

defineExtensionSuite("firefox");
