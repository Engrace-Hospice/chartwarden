// M25 milestone 2b — the pure ADR packet rules: checklist completeness, reviewer separation, and what a filing
// needs before the case may move to `submitted`.
import { describe, expect, it } from "vitest";
import {
  ADR_CHECKLIST_KEYS,
  ADR_FILING_CHANNELS,
  checkFiling,
  checkSignOff,
} from "../adr-packet-rules";

const allReady = Object.fromEntries(ADR_CHECKLIST_KEYS.map((k) => [k, "ready"] as const));
const DUE = new Date("2099-03-13T04:59:59.999Z");
const BEFORE = new Date("2026-03-10T12:00:00.000Z");
const AFTER = new Date("2099-03-20T12:00:00.000Z");
const NOW = new Date("2099-03-25T12:00:00.000Z");

describe("checkSignOff", () => {
  const ok = {
    assemblerMembershipId: "m-assembler",
    reviewerMembershipId: "m-reviewer",
    checklist: allReady,
    attachedCount: 2,
  };
  it("accepts a different reviewer with a complete checklist and at least one document", () => {
    expect(checkSignOff(ok)).toBeNull();
  });
  it("refuses the person who sent the packet to review", () => {
    expect(checkSignOff({ ...ok, reviewerMembershipId: "m-assembler" })).toBe(
      "REVIEWER_IS_ASSEMBLER",
    );
  });
  it("refuses an empty packet", () => {
    expect(checkSignOff({ ...ok, attachedCount: 0 })).toBe("PACKET_EMPTY");
  });
  it("refuses an unticked checklist item, and accepts not_applicable", () => {
    const [first] = ADR_CHECKLIST_KEYS;
    expect(checkSignOff({ ...ok, checklist: { ...allReady, [first as string]: "pending" } })).toBe(
      "CHECKLIST_INCOMPLETE",
    );
    expect(
      checkSignOff({ ...ok, checklist: { ...allReady, [first as string]: "not_applicable" } }),
    ).toBeNull();
  });
  it("treats a missing item as not done", () => {
    expect(checkSignOff({ ...ok, checklist: {} })).toBe("CHECKLIST_INCOMPLETE");
  });
});

describe("checkFiling", () => {
  const ok = {
    signedOffByMembershipId: "m-reviewer",
    channel: ADR_FILING_CHANNELS[0],
    confirmationRef: "FAX-12345",
    filedAt: BEFORE,
    dueAt: DUE,
    lateAcknowledged: false,
    now: NOW,
  };
  it("accepts a signed-off, proven, on-time filing", () => {
    expect(checkFiling(ok)).toBeNull();
  });
  it("refuses a filing with no sign-off", () => {
    expect(checkFiling({ ...ok, signedOffByMembershipId: null })).toBe("NOT_SIGNED_OFF");
  });
  it("refuses a blank confirmation reference and an unknown channel", () => {
    expect(checkFiling({ ...ok, confirmationRef: "  " })).toBe("PROOF_REQUIRED");
    expect(checkFiling({ ...ok, channel: "carrier_pigeon" })).toBe("CHANNEL_INVALID");
  });
  it("refuses a filing dated in the future", () => {
    expect(checkFiling({ ...ok, filedAt: new Date(NOW.getTime() + 86_400_000) })).toBe(
      "FILED_IN_FUTURE",
    );
  });
  it("allows a late filing only with an acknowledgement", () => {
    expect(checkFiling({ ...ok, filedAt: AFTER })).toBe("LATE_ACKNOWLEDGEMENT_REQUIRED");
    expect(checkFiling({ ...ok, filedAt: AFTER, lateAcknowledged: true })).toBeNull();
  });
});
