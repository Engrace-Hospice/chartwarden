// M25 milestone 7a-2 - the audit response rules. Pure. No contractor requirement is encoded: the checklist is typed by
// the person, the channels are labels, the due date is a recorded deadline or an explicit "none stated" attestation.
import { describe, expect, it } from "vitest";
import { auditDueState, shouldAlertNoDeadline } from "../audit-request";
import {
  AUDIT_FILING_CHANNELS,
  MAX_AUDIT_RESPONSE_ITEMS,
  canAttestNoDeadlineStated,
  checkAuditFiling,
  checkAuditSignOff,
  checkReadyForReview,
  checkResponseItems,
  signOffFingerprint,
} from "../audit-response";
import { SUBMISSION_PURPOSES, purposeSubject } from "../submission";

const NOW = new Date("2026-03-10T12:00:00Z");
const filing = {
  signedOffByMembershipId: "m-2",
  channel: "mail",
  confirmationRef: "TRK-1",
  filedAt: new Date("2026-03-09T12:00:00Z"),
  reviewedAt: new Date("2026-03-08T12:00:00Z"),
  now: NOW,
  recordedDeadlineCount: 1,
  noDeadlineStatedAttested: false,
  earliestOpenDueAt: new Date("2026-03-20T23:59:59Z") as Date | null,
  lateAcknowledged: false,
};

describe("checkResponseItems", () => {
  it("accepts an empty list (nothing is seeded) and person-typed items", () => {
    expect(checkResponseItems([])).toBeNull();
    expect(checkResponseItems([{ label: "Certification", state: "pending" }])).toBeNull();
  });
  it("refuses blank, over-long, duplicate (case-insensitive), invalid-state and too many items", () => {
    expect(checkResponseItems([{ label: "  ", state: "ready" }])).toBe("ITEM_LABEL_REQUIRED");
    expect(checkResponseItems([{ label: "x".repeat(201), state: "ready" }])).toBe(
      "ITEM_LABEL_TOO_LONG",
    );
    expect(
      checkResponseItems([
        { label: "Orders", state: "ready" },
        { label: "orders ", state: "ready" },
      ]),
    ).toBe("ITEM_LABEL_DUPLICATE");
    expect(checkResponseItems([{ label: "A", state: "done" as never }])).toBe("ITEM_STATE_INVALID");
    const many = Array.from({ length: MAX_AUDIT_RESPONSE_ITEMS + 1 }, (_, i) => ({
      label: `item ${i}`,
      state: "ready" as const,
    }));
    expect(checkResponseItems(many)).toBe("ITEMS_TOO_MANY");
  });
});

describe("checkAuditSignOff (preparer is not the approver)", () => {
  const ok = {
    assemblerMembershipId: "m-1",
    reviewerMembershipId: "m-2",
    preparerMembershipIds: ["m-1", "m-3"] as readonly string[],
    alreadySignedOff: false,
    recordedDeadlineCount: 1,
    noDeadlineStatedAttested: false,
    items: [{ label: "A", state: "ready" as const }],
    attachedCount: 1,
  };
  it("passes for a different reviewer with everything done", () => {
    expect(checkAuditSignOff(ok)).toBeNull();
    expect(
      checkAuditSignOff({ ...ok, items: [{ label: "A", state: "not_applicable" }] }),
    ).toBeNull();
  });
  it("refuses the assembler, an empty packet and an unticked item", () => {
    expect(checkAuditSignOff({ ...ok, reviewerMembershipId: "m-1" })).toBe("REVIEWER_IS_ASSEMBLER");
    expect(checkAuditSignOff({ ...ok, attachedCount: 0 })).toBe("PACKET_EMPTY");
    // Anyone who attached a document or typed the checklist is a preparer too, and a packet is signed off once.
    expect(checkAuditSignOff({ ...ok, reviewerMembershipId: "m-3" })).toBe("REVIEWER_IS_PREPARER");
    expect(checkAuditSignOff({ ...ok, alreadySignedOff: true })).toBe("ALREADY_SIGNED_OFF");
    // Deadlines freeze at sign-off, so it needs a recorded deadline or the attestation first.
    const none = { ...ok, recordedDeadlineCount: 0 };
    expect(checkAuditSignOff(none)).toBe("DEADLINE_OR_ATTESTATION_REQUIRED");
    expect(checkAuditSignOff({ ...none, noDeadlineStatedAttested: true })).toBeNull();
    expect(checkAuditSignOff({ ...ok, items: [{ label: "A", state: "pending" }] })).toBe(
      "CHECKLIST_INCOMPLETE",
    );
  });
});

describe("checkAuditFiling", () => {
  it("passes with sign-off, channel, proof and a recorded deadline not yet passed", () => {
    expect(checkAuditFiling(filing)).toBeNull();
  });
  it("refuses an unsigned packet, an unknown channel, no proof and a future filing time", () => {
    expect(checkAuditFiling({ ...filing, signedOffByMembershipId: null })).toBe("NOT_SIGNED_OFF");
    expect(checkAuditFiling({ ...filing, channel: "mac_portal" })).toBe("CHANNEL_INVALID");
    expect(checkAuditFiling({ ...filing, confirmationRef: "  " })).toBe("PROOF_REQUIRED");
    expect(checkAuditFiling({ ...filing, filedAt: new Date("2026-03-11T00:00:00Z") })).toBe(
      "FILED_IN_FUTURE",
    );
  });
  it("cannot be sent before the packet was signed off", () => {
    expect(checkAuditFiling({ ...filing, filedAt: new Date("2026-03-07T12:00:00Z") })).toBe(
      "FILED_BEFORE_REVIEW",
    );
  });
  it("needs a recorded deadline or the explicit none-stated attestation", () => {
    const none = { ...filing, recordedDeadlineCount: 0, earliestOpenDueAt: null };
    expect(checkAuditFiling(none)).toBe("DEADLINE_OR_ATTESTATION_REQUIRED");
    expect(checkAuditFiling({ ...none, noDeadlineStatedAttested: true })).toBeNull();
  });
  it("a satisfied deadline still counts as recorded and cannot make the filing late", () => {
    expect(
      checkAuditFiling({ ...filing, recordedDeadlineCount: 1, earliestOpenDueAt: null }),
    ).toBeNull();
  });
  it("a filing after an open recorded deadline needs the late acknowledgement", () => {
    const late = { ...filing, earliestOpenDueAt: new Date("2026-03-05T23:59:59Z") };
    expect(checkAuditFiling(late)).toBe("LATE_ACKNOWLEDGEMENT_REQUIRED");
    expect(checkAuditFiling({ ...late, lateAcknowledged: true })).toBeNull();
  });
  it("names no channel that implies a contractor procedure", () => {
    expect([...AUDIT_FILING_CHANNELS]).toEqual(["esmd", "fax", "mail", "other"]);
  });
});

describe("canAttestNoDeadlineStated", () => {
  it("is allowed only while nothing is recorded and not already attested", () => {
    expect(
      canAttestNoDeadlineStated({ recordedDeadlineCount: 0, alreadyAttested: false }),
    ).toBeNull();
    expect(canAttestNoDeadlineStated({ recordedDeadlineCount: 1, alreadyAttested: false })).toBe(
      "DEADLINES_EXIST",
    );
    expect(canAttestNoDeadlineStated({ recordedDeadlineCount: 0, alreadyAttested: true })).toBe(
      "ALREADY_ATTESTED",
    );
  });
});

describe("the attestation in the derived views", () => {
  it("reads none_stated instead of no_deadline_recorded, and stops the no-deadline alert", () => {
    const base = { state: "in_assembly" as const, nextDueAt: null, now: NOW };
    expect(auditDueState(base)).toBe("no_deadline_recorded");
    expect(auditDueState({ ...base, noneStatedAttested: true })).toBe("none_stated");
    const row = {
      state: "in_assembly",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      hasDeadline: false,
      alreadyAlerted: false,
    };
    expect(shouldAlertNoDeadline(row, NOW)).toBe(true);
    expect(shouldAlertNoDeadline({ ...row, noneStatedAttested: true }, NOW)).toBe(false);
  });
});

describe("the audit_response submission purpose", () => {
  it("is a purpose whose subject is the audit request", () => {
    expect(SUBMISSION_PURPOSES).toContain("audit_response");
    expect(purposeSubject("audit_response")).toBe("audit_request");
  });
});

describe("checkReadyForReview (the move to review asks what sign-off asks, minus the reviewer)", () => {
  it("needs a document and every typed item done", () => {
    const ready = { items: [{ label: "A", state: "ready" as const }], attachedCount: 1 };
    expect(checkReadyForReview(ready)).toBeNull();
    expect(checkReadyForReview({ ...ready, attachedCount: 0 })).toBe("PACKET_EMPTY");
    expect(checkReadyForReview({ ...ready, items: [{ label: "A", state: "pending" }] })).toBe(
      "CHECKLIST_INCOMPLETE",
    );
  });
});

describe("signOffFingerprint", () => {
  const base = {
    claimIds: ["c2", "c1"],
    items: [{ label: "A", state: "ready" as const }],
    documents: [{ documentId: "d1", claimId: "c1" }],
    deadlines: [{ id: "x", dueOn: "2026-03-20", satisfiedOn: null as string | null }],
    noDeadlineStatedAttested: false,
  };
  it("is stable under ordering and moves with any signed-off fact", () => {
    const h = signOffFingerprint(base);
    expect(signOffFingerprint({ ...base, claimIds: ["c1", "c2"] })).toBe(h);
    for (const changed of [
      { claimIds: ["c1"] },
      { items: [{ label: "A", state: "not_applicable" as const }] },
      { documents: [{ documentId: "d2", claimId: "c1" }] },
      { deadlines: [{ id: "x", dueOn: "2026-03-21", satisfiedOn: null }] },
      { deadlines: [{ id: "x", dueOn: "2026-03-20", satisfiedOn: "2026-03-10" }] },
      { noDeadlineStatedAttested: true },
    ]) {
      expect(signOffFingerprint({ ...base, ...changed })).not.toBe(h);
    }
  });
});
