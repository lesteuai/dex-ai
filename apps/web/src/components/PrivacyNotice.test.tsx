// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PrivacyNotice } from "./PrivacyNotice";

afterEach(() => {
  cleanup();
});

describe("PrivacyNotice", () => {
  it("discloses that LLM prompts are sent to the selected provider", () => {
    render(<PrivacyNotice />);

    expect(
      screen.getByText(/LLM prompts are sent to the provider selected in your OpenCode config/),
    ).toBeTruthy();
  });

  it("discloses that profile data, sessions and traces persist locally", () => {
    render(<PrivacyNotice />);

    expect(
      screen.getByText(/persist in the local SQLite database on this device/),
    ).toBeTruthy();
  });

  it("discloses that voice audio is sent to no provider", () => {
    render(<PrivacyNotice />);

    expect(screen.getByText(/Voice audio never leaves this device/)).toBeTruthy();
  });

  it("discloses that prompts carry the user's observed values", () => {
    render(<PrivacyNotice />);

    expect(screen.getByText(/observed events with the values you typed/)).toBeTruthy();
  });

  it("discloses that Dex AI stores no API keys and runs no remote storage service", () => {
    render(<PrivacyNotice />);

    expect(screen.getByText(/Dex AI stores no API keys and runs no remote storage service/)).toBeTruthy();
  });
});
