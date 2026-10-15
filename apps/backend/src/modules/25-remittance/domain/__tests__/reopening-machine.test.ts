// M25 milestone 3 — the MAC reopening aggregate: its state machine and what a recorded filing needs.
import { describe, expect, it } from "vitest";
import {
  REOPENING_FILING_CHANNELS,
  canTransitionReopening,
  checkReopeningFiling,
  isReopeningTerminal,
} from "../reopening-machine";

describe("reopening state machine", () => {
  it("allows the forward path draft -> submitted -> decided -> closed", () => {
    expect(canTransitionReopening("draft", "submitted")).toBe(true);
    expect(canTransitionReopening("submitted", "decided")).toBe(true);
    expect(canTransitionReopening("decided", "closed")).toBe(true);
  });
  it("lets a draft or a submitted request be withdrawn, but not a decided one", () => {
    expect(canTransitionReopening("draft", "withdrawn")).toBe(true);
    expect(canTransitionReopening("submitted", "withdrawn")).toBe(true);
    expect(canTransitionReopening("decided", "withdrawn")).toBe(false);
  });
  it("refuses to skip filing or to go back", () => {
    expect(canTransitionReopening("draft", "decided")).toBe(false);
    expect(canTransitionReopening("submitted", "draft")).toBe(false);
  });
  it("treats withdrawn and closed as terminal", () => {
    expect(isReopeningTerminal("withdrawn")).toBe(true);
    expect(isReopeningTerminal("closed")).toBe(true);
    expect(isReopeningTerminal("draft")).toBe(false);
  });
});

describe("checkReopeningFiling", () => {
  const NOW = new Date("2026-06-10T12:00:00.000Z");
  const ok = {
    formName: "CGS 56900 reopening request",
    channel: "mac_portal",
    confirmationRef: "PRT-1234",
    filedAt: new Date("2026-06-09T12:00:00.000Z"),
    now: NOW,
  };
  it("accepts a named form, a known channel, a confirmation and a past filing time", () => {
    expect(checkReopeningFiling(ok)).toBeNull();
  });
  it("offers no electronic-submission channel (that is milestone 6)", () => {
    expect(REOPENING_FILING_CHANNELS).not.toContain("esmd");
  });
  it("refuses a missing form name, an unknown channel, a blank confirmation and a future time", () => {
    expect(checkReopeningFiling({ ...ok, formName: "  " })).toBe("FORM_REQUIRED");
    expect(checkReopeningFiling({ ...ok, channel: "esmd" })).toBe("CHANNEL_INVALID");
    expect(checkReopeningFiling({ ...ok, confirmationRef: " " })).toBe("PROOF_REQUIRED");
    expect(checkReopeningFiling({ ...ok, filedAt: new Date("2026-06-11T00:00:00Z") })).toBe(
      "FILED_IN_FUTURE",
    );
  });
});
