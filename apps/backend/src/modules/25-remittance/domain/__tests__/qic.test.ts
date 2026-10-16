// M25 milestone 4 — the QIC reconsideration rules: the decision clock, the evidence guard and escalation
// eligibility. Pure; every date is a fixed fixture.
import { describe, expect, it } from "vitest";
import { canTransitionAppeal, isAppealTerminal } from "../appeal-machine";
import {
  QIC_DECISION_DAYS,
  QIC_LATE_EVIDENCE_EXTENSION_MAX_DAYS,
  type QicClock,
  canRequestEscalation,
  checkEscalationFiling,
  checkQicEvidence,
  checkQicExtension,
  containsMbi,
  deriveQicDecisionClock,
  isQicOverdue,
  qicDaysOverdue,
} from "../qic";

const NOTICE_DOC = "11111111-1111-4111-8111-111111111111";
const EVIDENCE_DOC = "22222222-2222-4222-8222-222222222222";
const ENCLOSED = [NOTICE_DOC, EVIDENCE_DOC];

describe("QIC decision clock", () => {
  it("is receipt + 60 days, ending at the end of that day in the provider zone", () => {
    const clock = deriveQicDecisionClock({
      receivedOn: "2026-01-05",
      extensions: [],
      zones: ["America/New_York"],
    });
    expect(clock.baseDays).toBe(QIC_DECISION_DAYS);
    expect(clock.extensionDays).toBe(0);
    expect(clock.decisionDueOn).toBe("2026-03-06");
    // 2026-03-06 23:59:59.999 EST = 2026-03-07 04:59:59.999Z
    expect(clock.decisionDueAt.toISOString()).toBe("2026-03-07T04:59:59.999Z");
  });

  it("adds each recorded extension (1 and 3 extensions)", () => {
    const one = deriveQicDecisionClock({
      receivedOn: "2026-01-05",
      extensions: [{ days: 14, recordedAt: "2026-02-01T10:00:00.000Z" }],
      zones: ["America/New_York"],
    });
    expect(one.extensionDays).toBe(14);
    expect(one.decisionDueOn).toBe("2026-03-20");
    const three = deriveQicDecisionClock({
      receivedOn: "2026-01-05",
      extensions: [
        { days: 14, recordedAt: "2026-02-01T10:00:00.000Z" },
        { days: 0, recordedAt: "2026-02-02T10:00:00.000Z" },
        { days: 5, recordedAt: "2026-02-03T10:00:00.000Z" },
      ],
      zones: ["America/New_York"],
    });
    expect(three.extensionDays).toBe(19);
    expect(three.decisionDueOn).toBe("2026-03-25");
  });

  it("does not roll a weekend last day (the SME has not confirmed any roll)", () => {
    // 2026-01-03 + 60 = 2026-03-04 (Wednesday); 2026-01-10 + 60 = 2026-03-11; pick a Saturday landing:
    // 2026-01-07 + 60 = 2026-03-08 (Sunday).
    const clock = deriveQicDecisionClock({ receivedOn: "2026-01-07", extensions: [], zones: [] });
    expect(clock.decisionDueOn).toBe("2026-03-08");
  });

  it("uses the LATEST-ending zone so escalation is never offered early", () => {
    const clock = deriveQicDecisionClock({
      receivedOn: "2026-01-05",
      extensions: [],
      zones: ["America/New_York", "America/Los_Angeles"],
    });
    expect(clock.zone).toBe("America/Los_Angeles");
    expect(clock.decisionDueAt.toISOString()).toBe("2026-03-07T07:59:59.999Z");
  });

  it("is overdue only after the last millisecond of the due day", () => {
    const clock = deriveQicDecisionClock({
      receivedOn: "2026-01-05",
      extensions: [],
      zones: ["America/New_York"],
    });
    expect(isQicOverdue(clock, new Date("2026-03-07T04:59:59.999Z"))).toBe(false);
    expect(isQicOverdue(clock, new Date("2026-03-07T05:00:00.000Z"))).toBe(true);
    expect(qicDaysOverdue(clock, new Date("2026-03-07T04:59:59.999Z"))).toBe(0);
    expect(qicDaysOverdue(clock, new Date("2026-03-07T05:00:00.000Z"))).toBe(1);
    expect(qicDaysOverdue(clock, new Date("2026-03-09T04:59:59.999Z"))).toBe(2);
  });

  it("rejects a malformed receipt date", () => {
    expect(() =>
      deriveQicDecisionClock({ receivedOn: "05/01/2026", extensions: [], zones: [] }),
    ).toThrow(RangeError);
  });
});

describe("QIC extension rule", () => {
  it("accepts 0 through 14 whole days", () => {
    expect(checkQicExtension(0)).toBeNull();
    expect(checkQicExtension(QIC_LATE_EVIDENCE_EXTENSION_MAX_DAYS)).toBeNull();
  });
  it("refuses a negative, fractional or oversized extension", () => {
    expect(checkQicExtension(-1)).toBe("EXTENSION_OUT_OF_RANGE");
    expect(checkQicExtension(1.5)).toBe("EXTENSION_OUT_OF_RANGE");
    expect(checkQicExtension(15)).toBe("EXTENSION_OUT_OF_RANGE");
  });
});

describe("QIC evidence guard", () => {
  const base = {
    items: [{ label: "Face-to-face note", documentId: EVIDENCE_DOC, notAvailableReason: null }],
    none: false,
    enclosedIds: ENCLOSED,
    preclusionAcknowledged: false,
    redeterminationNoticeDocumentId: NOTICE_DOC as string | null,
  };

  it("passes when every cited item is enclosed and the notice copy is enclosed", () => {
    expect(checkQicEvidence(base)).toBeNull();
  });
  it("requires the redetermination notice copy to be enclosed", () => {
    expect(checkQicEvidence({ ...base, redeterminationNoticeDocumentId: null })).toBe(
      "NOTICE_COPY_REQUIRED",
    );
    expect(checkQicEvidence({ ...base, enclosedIds: [EVIDENCE_DOC] })).toBe("NOTICE_COPY_REQUIRED");
  });
  it("requires either cited items or the attestation that the notice named none", () => {
    expect(checkQicEvidence({ ...base, items: [] })).toBe("EVIDENCE_LIST_REQUIRED");
    expect(checkQicEvidence({ ...base, items: [], none: true })).toBeNull();
  });
  it("refuses a list that both cites items and says none were named", () => {
    expect(checkQicEvidence({ ...base, none: true })).toBe("EVIDENCE_LIST_CONFLICT");
  });
  it("refuses an item with no label", () => {
    expect(
      checkQicEvidence({
        ...base,
        items: [{ label: "  ", documentId: EVIDENCE_DOC, notAvailableReason: null }],
      }),
    ).toBe("EVIDENCE_LABEL_REQUIRED");
  });
  it("refuses an item whose document is not among the enclosures", () => {
    expect(checkQicEvidence({ ...base, enclosedIds: [NOTICE_DOC] })).toBe("EVIDENCE_NOT_ENCLOSED");
  });
  it("refuses an item with neither an enclosure nor a reason, or with a short reason", () => {
    const none = { label: "Visit notes", documentId: null, notAvailableReason: null };
    expect(checkQicEvidence({ ...base, items: [none], preclusionAcknowledged: true })).toBe(
      "EVIDENCE_REASON_REQUIRED",
    );
    expect(
      checkQicEvidence({
        ...base,
        items: [{ ...none, notAvailableReason: "lost" }],
        preclusionAcknowledged: true,
      }),
    ).toBe("EVIDENCE_REASON_REQUIRED");
  });
  it("lets an item go unenclosed only with a reason and an acknowledged preclusion warning", () => {
    const missing = {
      label: "Visit notes",
      documentId: null,
      notAvailableReason: "The facility has not released the notes yet.",
    };
    expect(checkQicEvidence({ ...base, items: [missing] })).toBe("PRECLUSION_ACK_REQUIRED");
    expect(
      checkQicEvidence({ ...base, items: [missing], preclusionAcknowledged: true }),
    ).toBeNull();
  });
});

describe("QIC escalation eligibility", () => {
  const due = deriveQicDecisionClock({
    receivedOn: "2026-01-05",
    extensions: [],
    zones: ["America/New_York"],
  });
  const late = new Date("2026-03-08T12:00:00.000Z");
  const ok = {
    tier: "reconsideration",
    state: "under_review",
    clock: due as QicClock | null,
    alreadyRequested: false,
    now: late,
  } as const;

  it("is eligible for an under-review reconsideration past its due date", () => {
    expect(canRequestEscalation(ok)).toBeNull();
  });
  it("refuses another tier, another state, no receipt date, not yet due, already requested", () => {
    expect(canRequestEscalation({ ...ok, tier: "redetermination" })).toBe("NOT_RECONSIDERATION");
    expect(canRequestEscalation({ ...ok, state: "submitted" })).toBe("NOT_UNDER_REVIEW");
    expect(canRequestEscalation({ ...ok, clock: null })).toBe("QIC_RECEIPT_NOT_RECORDED");
    expect(canRequestEscalation({ ...ok, now: new Date("2026-03-06T12:00:00.000Z") })).toBe(
      "QIC_NOT_YET_DUE",
    );
    expect(canRequestEscalation({ ...ok, alreadyRequested: true })).toBe("ALREADY_REQUESTED");
  });
});

describe("escalation request filing", () => {
  const now = new Date("2026-03-10T00:00:00.000Z");
  it("needs a known channel, a confirmation reference and a time that is not in the future", () => {
    const filing = {
      channel: "fax",
      confirmationRef: "FAX-1",
      requestedAt: new Date("2026-03-09T00:00:00.000Z"),
      now,
    };
    expect(checkEscalationFiling(filing)).toBeNull();
    expect(checkEscalationFiling({ ...filing, channel: "carrier pigeon" })).toBe("CHANNEL_INVALID");
    expect(checkEscalationFiling({ ...filing, confirmationRef: " " })).toBe("PROOF_REQUIRED");
    expect(
      checkEscalationFiling({ ...filing, requestedAt: new Date("2026-03-11T00:00:00.000Z") }),
    ).toBe("REQUESTED_IN_FUTURE");
  });
});

describe("appeal machine: escalated", () => {
  it("moves under_review -> escalated -> closed, and nothing else reaches escalated", () => {
    expect(canTransitionAppeal("under_review", "escalated")).toBe(true);
    expect(canTransitionAppeal("escalated", "closed")).toBe(true);
    expect(canTransitionAppeal("submitted", "escalated")).toBe(false);
    expect(canTransitionAppeal("draft", "escalated")).toBe(false);
    expect(canTransitionAppeal("escalated", "decided")).toBe(false);
    expect(isAppealTerminal("escalated")).toBe(false);
  });
});

describe("escalation request timing", () => {
  const filing = {
    channel: "fax",
    confirmationRef: "FAX-1",
    requestedAt: new Date("2026-03-09T00:00:00.000Z"),
    now: new Date("2026-03-10T00:00:00.000Z"),
  };
  it("cannot pre-date the QIC decision instant", () => {
    const notBefore = new Date("2026-03-08T00:00:00.000Z");
    expect(checkEscalationFiling({ ...filing, notBefore })).toBeNull();
    expect(
      checkEscalationFiling({ ...filing, notBefore: new Date("2026-03-09T00:00:00.001Z") }),
    ).toBe("REQUESTED_BEFORE_DUE");
  });
});

describe("Medicare number detection", () => {
  it("catches an MBI on its own, dashed, spaced, lower-case or inside a sentence", () => {
    expect(containsMbi("1EG4-TE5-MK73")).toBe(true);
    expect(containsMbi("1eg4te5mk73")).toBe(true);
    expect(containsMbi("1EG4 TE5 MK73")).toBe(true);
    expect(containsMbi("Patient 1EG4TE5MK73 visit notes")).toBe(true);
  });
  it("leaves ordinary references and labels alone", () => {
    expect(containsMbi("FAX-CONF-77")).toBe(false);
    expect(containsMbi("Face-to-face note 2026-02-20")).toBe(false);
    expect(containsMbi("The facility has not released the notes yet.")).toBe(false);
    expect(containsMbi("")).toBe(false);
  });
});
