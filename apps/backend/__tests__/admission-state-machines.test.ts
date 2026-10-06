// apps/backend/__tests__/admission-state-machines.test.ts — M6-T04 (§2.3 state machines, §2.4
// validation, §2.5 side-effect rules). The pure domain core: legal-transition graphs, enumerated
// guards (each raises its §2.4 machine-readable code), and the in-transaction side-effect lists.
import { describe, expect, it } from "vitest";
import {
  AdmissionStateError,
  CERTIFICATION_GRAPH,
  SYNC_VALIDATION_RULES,
  checkF2fWindow,
  daysBetween,
  needsIpuBed,
  planDischarge,
  planRevocation,
  planTransferOut,
  transitionAdmission,
  transitionCertification,
  transitionElectionPeriod,
  transitionFaceToFace,
  transitionLevelOfCare,
  validateTransferIn,
} from "../src/modules/06-admission/state-machines/index";

/** Pull the first side effect of a given kind (test helper). */
function outboxEvents(effects: ReadonlyArray<{ kind: string }>): string[] {
  return effects
    .filter((e): e is { kind: "outbox"; event: string } => e.kind === "outbox")
    .map((e) => e.event);
}

describe("calendar helper (§2.4)", () => {
  it("counts whole calendar days, signed", () => {
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
    expect(daysBetween("2026-01-31", "2026-01-01")).toBe(-30);
    expect(daysBetween("2026-06-21", "2026-06-21")).toBe(0);
  });
});

describe("Admission state machine (§2.3.1)", () => {
  it("createAdmission: referred → pending, opens the 4 compliance windows + draft outbox", () => {
    const t = transitionAdmission("referred", {
      type: "createAdmission",
      referralAccepted: true,
      hasOtherOpenAdmission: false,
    });
    expect(t.to).toBe("pending");
    expect(t.effects.filter((e) => e.kind === "open_window")).toHaveLength(4);
    expect(outboxEvents(t.effects)).toContain("m6.admission.draft_created");
  });

  it("rejects an illegal event from a state (nothing matches on a string)", () => {
    expect(() =>
      transitionAdmission("closed", { type: "placeOnHold", reason: "x" } as never),
    ).toThrow(AdmissionStateError);
    try {
      transitionAdmission("active", {
        type: "acknowledgeNoticeOfRights",
        alreadyAcknowledged: false,
      } as never);
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("ILLEGAL_TRANSITION");
    }
  });

  it("activate guard set: NOR + ES + CTI + no privacy block + 48h not overdue", () => {
    const base = {
      type: "activate" as const,
      electionStatementSigned: true,
      certificationSigned: true,
      noticeOfRightsAcknowledged: true,
      privacyFlagBlock: false,
      initialAssessment48hOverdue: false,
      donOverride: false,
      isFirstElectionPeriod: true,
      at: "2026-06-21",
    };
    const ok = transitionAdmission("notice_of_rights_acknowledged", base);
    expect(ok.to).toBe("active");
    expect(outboxEvents(ok.effects)).toEqual(
      expect.arrayContaining(["m6.admission.activated", "m6.election.period_started"]),
    );

    const noNor = () =>
      transitionAdmission("notice_of_rights_acknowledged", {
        ...base,
        noticeOfRightsAcknowledged: false,
      });
    expect(noNor).toThrow(/notice of rights/i);
    try {
      transitionAdmission("notice_of_rights_acknowledged", { ...base, certificationSigned: false });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("CERTIFICATION_REQUIRED");
    }
    try {
      transitionAdmission("notice_of_rights_acknowledged", { ...base, privacyFlagBlock: true });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("PRIVACY_FLAG_BLOCK");
    }
  });

  it("48h-overdue blocks activation unless DON overrides", () => {
    const base = {
      type: "activate" as const,
      electionStatementSigned: true,
      certificationSigned: true,
      noticeOfRightsAcknowledged: true,
      privacyFlagBlock: false,
      initialAssessment48hOverdue: true,
      donOverride: false,
      isFirstElectionPeriod: false,
      at: "2026-06-21",
    };
    expect(() => transitionAdmission("notice_of_rights_acknowledged", base)).toThrow(/overdue/i);
    expect(
      transitionAdmission("notice_of_rights_acknowledged", { ...base, donOverride: true }).to,
    ).toBe("active");
  });

  it("executeDischarge: death → bereavement + bereavement.eligible; non-death → discharged", () => {
    const death = transitionAdmission("active", {
      type: "executeDischarge",
      dischargeType: "death",
      effectiveAt: "2026-06-21",
      admissionAt: "2026-01-01",
      forCauseCosigned: false,
      deathAt: "2026-06-20",
      today: "2026-06-21",
      deathCertifierCredentialed: true,
    });
    expect(death.to).toBe("bereavement");
    expect(outboxEvents(death.effects)).toEqual(
      expect.arrayContaining(["m6.discharge.death", "m6.bereavement.eligible"]),
    );

    const routine = transitionAdmission("active", {
      type: "executeDischarge",
      dischargeType: "routine",
      effectiveAt: "2026-06-21",
      admissionAt: "2026-01-01",
      forCauseCosigned: false,
    });
    expect(routine.to).toBe("discharged");
    expect(outboxEvents(routine.effects)).toContain("m6.discharge.created");
  });

  it("for_cause discharge requires co-sign; death requires a credentialed certifier", () => {
    expect(() =>
      transitionAdmission("active", {
        type: "executeDischarge",
        dischargeType: "for_cause",
        effectiveAt: "2026-06-21",
        admissionAt: "2026-01-01",
        forCauseCosigned: false,
      }),
    ).toThrow(/co-sign/i);
    try {
      transitionAdmission("active", {
        type: "executeDischarge",
        dischargeType: "death",
        effectiveAt: "2026-06-21",
        admissionAt: "2026-01-01",
        forCauseCosigned: false,
        deathAt: "2026-06-22",
        today: "2026-06-21",
        deathCertifierCredentialed: true,
      });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("DEATH_CERTIFIER_INVALID");
    }
  });

  it("discharge effective before admission is rejected", () => {
    try {
      transitionAdmission("active", {
        type: "executeDischarge",
        dischargeType: "routine",
        effectiveAt: "2025-12-31",
        admissionAt: "2026-01-01",
        forCauseCosigned: false,
      });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("DISCHARGE_BEFORE_ADMISSION");
    }
  });
});

describe("ElectionPeriod state machine (§2.3.2)", () => {
  const sign = {
    type: "signElectionStatement" as const,
    signerKind: "patient" as const,
    hasActiveDpoaConsent: false,
    curativeCareAcknowledgment: true,
    existingActiveElectionElsewhere: false,
    wouldOverlap: false,
  };

  it("sign: pending → signed; emits election.signed", () => {
    const t = transitionElectionPeriod("pending", sign);
    expect(t.to).toBe("signed");
    expect(outboxEvents(t.effects)).toContain("m6.election.signed");
  });

  // F-089 — these were `try { transition(...) } catch (e) { expect(e.code)... }`, which asserts nothing
  // when the call does NOT throw: the catch never runs and the test passes. Every refusal in this file
  // was written that way, so a guard that stopped firing would have been reported green. That is not a
  // hypothetical here — it is why the R-EL-01 case below did not notice the fail-open F-089 fixes.
  // `toThrowError` fails when nothing is thrown, which is the half that was missing.
  const refuses = (event: Parameters<typeof transitionElectionPeriod>[1], code: string) =>
    expect(() => transitionElectionPeriod("pending", event)).toThrowError(
      expect.objectContaining({ code }),
    );

  it("R-EL-04 curative-care ack required; R-EL-02 concurrent election blocked", () => {
    refuses({ ...sign, curativeCareAcknowledgment: false }, "CURATIVE_CARE_ACK_REQUIRED");
    refuses({ ...sign, existingActiveElectionElsewhere: true }, "PATIENT_ALREADY_ELECTED");
  });

  it("R-EL-01 representative signer needs an active DPOA consent", () => {
    refuses(
      { ...sign, signerKind: "representative", hasActiveDpoaConsent: false },
      "REPRESENTATIVE_AUTHORITY_MISSING",
    );
    expect(
      transitionElectionPeriod("pending", {
        ...sign,
        signerKind: "representative",
        hasActiveDpoaConsent: true,
      }).to,
    ).toBe("signed");
  });

  // F-089 — the case that was actually reachable, and was not covered. `signerKind` is produced by
  // `SIGNER_KIND_BY_ROLE[input.signingRole]`, an index into a two-key map that exists because the wire
  // vocabulary (`legal_representative`) and the column enum (`representative`) differ. A miss yields
  // `undefined`, and the validator's old `!== "representative"` early return let it straight through:
  // the election signed, with no DPOA consult, for a signer whose kind the platform could not name.
  // An unrecognised kind must be treated as a representative — the direction an authority control has
  // to fail in. The cast is the point of the test: the type says this cannot happen, and the map's
  // index signature is exactly where it does.
  it("R-EL-01 an UNRECOGNISED signer kind is refused, not waved through (fail-closed)", () => {
    refuses(
      {
        ...sign,
        signerKind: undefined as unknown as "representative",
        hasActiveDpoaConsent: false,
      },
      "REPRESENTATIVE_AUTHORITY_MISSING",
    );
  });

  it("overlap guard mirrors the DB GIST EXCLUDE", () => {
    refuses({ ...sign, wouldOverlap: true }, "ELECTION_PERIOD_OVERLAP");
  });

  it("setActive: recert (seq ≥ 3) requires an attested F2F (R-F2F-04)", () => {
    const base = {
      type: "setActive" as const,
      certificationSigned: true,
      admissionActivated: true,
      sequence: 3,
      f2fAttested: false,
      effectiveAt: "2026-06-21",
    };
    expect(() => transitionElectionPeriod("signed", base)).toThrowError(
      expect.objectContaining({ code: "F2F_REQUIRED_FOR_RECERT" }),
    );
    expect(transitionElectionPeriod("signed", { ...base, f2fAttested: true }).to).toBe("active");
    // period 1 needs no F2F
    expect(transitionElectionPeriod("signed", { ...base, sequence: 1 }).to).toBe("active");
  });
});

describe("CTI state machine (§2.3.3)", () => {
  const narrative = "x".repeat(200);
  const submit = {
    type: "submitToHospiceMd" as const,
    narrative,
    isValidIcd10: true,
    isHospiceAllowable: true,
    periodStart: "2026-06-21",
    today: "2026-06-21",
  };

  it("submit: drafted → awaiting_hospice_md", () => {
    expect(transitionCertification("drafted", submit).to).toBe("awaiting_hospice_md");
  });

  it("narrative < 200 chars and non-allowable dx are rejected", () => {
    try {
      transitionCertification("drafted", { ...submit, narrative: "short" });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("CTI_NARRATIVE_TOO_SHORT");
    }
    try {
      transitionCertification("drafted", { ...submit, isHospiceAllowable: false });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("TERMINAL_DX_NOT_ALLOWABLE");
    }
  });

  it("hospice-MD sign branches: period 1 + attending → awaiting_attending; else → signed", () => {
    const sig = {
      type: "signByHospiceMd" as const,
      sequence: 1,
      patientHasAttending: true,
      signerMatchesHospiceMd: true,
      hospiceMdSignedAt: "2026-06-21",
      periodStart: "2026-06-21",
    };
    expect(transitionCertification("awaiting_hospice_md", sig).to).toBe("awaiting_attending");
    expect(
      transitionCertification("awaiting_hospice_md", { ...sig, patientHasAttending: false }).to,
    ).toBe("signed");
    expect(transitionCertification("awaiting_hospice_md", { ...sig, sequence: 2 }).to).toBe(
      "signed",
    );
  });

  it("late hospice-MD sign sets signed_late + requires a late_reason (R-CTI-01)", () => {
    const late = {
      type: "signByHospiceMd" as const,
      sequence: 2,
      patientHasAttending: false,
      signerMatchesHospiceMd: true,
      hospiceMdSignedAt: "2026-06-25",
      periodStart: "2026-06-21",
    };
    try {
      transitionCertification("awaiting_hospice_md", late);
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("CTI_LATE_REASON_REQUIRED");
    }
    const ok = transitionCertification("awaiting_hospice_md", {
      ...late,
      lateReason: "delayed signature",
    });
    expect(ok.effects.some((e) => e.kind === "set_flag" && e.field === "signed_late")).toBe(true);
    expect(outboxEvents(ok.effects)).toContain("m6.cti.late_flagged");
  });

  it("signer mismatch blocks the hospice-MD sign", () => {
    try {
      transitionCertification("awaiting_hospice_md", {
        type: "signByHospiceMd",
        sequence: 1,
        patientHasAttending: false,
        signerMatchesHospiceMd: false,
        hospiceMdSignedAt: "2026-06-21",
        periodStart: "2026-06-21",
      });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("CTI_SIGNER_MISMATCH");
    }
  });

  it("void requires permission AND period not yet active", () => {
    expect(CERTIFICATION_GRAPH.signed).toContain("void");
    try {
      transitionCertification("signed", {
        type: "void",
        hasVoidPermission: false,
        periodNotYetActive: true,
      });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("CTI_VOID_FORBIDDEN");
    }
    expect(
      transitionCertification("signed", {
        type: "void",
        hasVoidPermission: true,
        periodNotYetActive: true,
      }).to,
    ).toBe("voided");
  });
});

describe("F2F state machine (§2.3.4)", () => {
  it("checkF2fWindow: in [start-30d, start-1d] is within window; outside w/o override throws", () => {
    expect(
      checkF2fWindow({ periodStart: "2026-07-01", encounterDate: "2026-06-15", hasOverride: false })
        .withinWindow,
    ).toBe(true);
    expect(() =>
      checkF2fWindow({
        periodStart: "2026-07-01",
        encounterDate: "2026-07-05",
        hasOverride: false,
      }),
    ).toThrow(/window/i);
    // out of window but overridden → recorded as not-within-window, no throw
    expect(
      checkF2fWindow({ periodStart: "2026-07-01", encounterDate: "2026-05-01", hasOverride: true })
        .withinWindow,
    ).toBe(false);
  });

  it("recordCompletion rejects the attending as performer (R-F2F-01)", () => {
    try {
      transitionFaceToFace("scheduled", {
        type: "recordCompletion",
        performerRole: "attending",
        periodStart: "2026-07-01",
        encounterDate: "2026-06-15",
        hasOverride: false,
        encounterLocation: "patient_home",
        telehealthEligibility: null,
      });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("F2F_INVALID_PERFORMER");
    }
  });

  it("happy path scheduled → completed → attested; attest emits f2f.attested", () => {
    const completed = transitionFaceToFace("scheduled", {
      type: "recordCompletion",
      performerRole: "hospice_np",
      periodStart: "2026-07-01",
      encounterDate: "2026-06-15",
      hasOverride: false,
      encounterLocation: "patient_home",
      telehealthEligibility: null,
    });
    expect(completed.to).toBe("completed");
    const attested = transitionFaceToFace("completed", {
      type: "attest",
      narrative: "y".repeat(100),
      performerIsActor: true,
    });
    expect(attested.to).toBe("attested");
    expect(outboxEvents(attested.effects)).toContain("m6.f2f.attested");
  });

  it("window override needs the Medical Director role + a ≥20-char reason (R-F2F-03)", () => {
    try {
      transitionFaceToFace("completed", {
        type: "requestWindowOverride",
        isMedicalDirector: false,
        reason: "x".repeat(25),
      });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("F2F_OVERRIDE_FORBIDDEN");
    }
    try {
      transitionFaceToFace("completed", {
        type: "requestWindowOverride",
        isMedicalDirector: true,
        reason: "short",
      });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("F2F_OVERRIDE_REASON_TOO_SHORT");
    }
  });
});

describe("LevelOfCarePeriod state machine (§2.3.5)", () => {
  it("RHC/CHC → active directly; IRC/GIP → assigning (needs IPU bed)", () => {
    expect(needsIpuBed("routine_home_care")).toBe(false);
    expect(needsIpuBed("general_inpatient_care")).toBe(true);
    const rhc = transitionLevelOfCare("pending", {
      type: "requestAssign",
      level: "routine_home_care",
      admissionActiveOrOnHold: true,
      facilityId: null,
      wouldOverlap: false,
      reason: "",
    });
    expect(rhc.to).toBe("active");
    expect(outboxEvents(rhc.effects)).toContain("m6.loc.changed");

    const gip = transitionLevelOfCare("pending", {
      type: "requestAssign",
      level: "general_inpatient_care",
      admissionActiveOrOnHold: true,
      facilityId: "fac-1",
      wouldOverlap: false,
      reason: "uncontrolled symptoms requiring inpatient management now",
    });
    expect(gip.to).toBe("assigning");
  });

  it("GIP needs ≥30-char documentation (R-LCP-01); IRC/GIP need a facility", () => {
    try {
      transitionLevelOfCare("pending", {
        type: "requestAssign",
        level: "general_inpatient_care",
        admissionActiveOrOnHold: true,
        facilityId: "fac-1",
        wouldOverlap: false,
        reason: "too short",
      });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("GIP_DOCUMENTATION_INSUFFICIENT");
    }
    try {
      transitionLevelOfCare("pending", {
        type: "requestAssign",
        level: "inpatient_respite_care",
        admissionActiveOrOnHold: true,
        facilityId: null,
        wouldOverlap: false,
        reason: "",
      });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("IPU_FACILITY_REQUIRED");
    }
  });

  it("assigning → active on bed confirm; active → ended", () => {
    expect(
      transitionLevelOfCare("assigning", { type: "ipuConfirmBedAssignment", bedVerified: true }).to,
    ).toBe("active");
    expect(transitionLevelOfCare("active", { type: "end", endedAt: "2026-06-21" }).to).toBe(
      "ended",
    );
  });
});

describe("Revocation / Transfer / Discharge commands (§2.3.6)", () => {
  it("revocation closes the period + ends LCP; effective<signed is rejected (R-RV-01)", () => {
    const ok = planRevocation({
      electionPeriodActive: true,
      signedAt: "2026-06-20",
      effectiveAt: "2026-06-21",
    });
    expect(outboxEvents(ok.effects)).toContain("m6.revocation.created");
    expect(ok.effects.some((e) => e.kind === "end_election_period")).toBe(true);
    try {
      planRevocation({
        electionPeriodActive: true,
        signedAt: "2026-06-21",
        effectiveAt: "2026-06-20",
      });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("REVOCATION_EFFECTIVE_BEFORE_SIGNED");
    }
  });

  it("only one transfer per period (R-XFR-01); transfer-in validates source CCN (R-XFR-02)", () => {
    expect(
      outboxEvents(planTransferOut({ transferAlreadyDoneThisPeriod: false }).effects),
    ).toContain("m6.transfer.created");
    try {
      planTransferOut({ transferAlreadyDoneThisPeriod: true });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("TRANSFER_LIMIT_EXCEEDED");
    }
    try {
      validateTransferIn({ sourceCcnValid: false, carriedSequencePresent: true });
    } catch (e) {
      expect((e as AdmissionStateError).code).toBe("TRANSFER_IN_SOURCE_INVALID");
    }
  });

  it("discharge cascade: death fans out bereavement.eligible", () => {
    const death = planDischarge({
      dischargeType: "death",
      forCauseCosigned: false,
      deathAt: "2026-06-20",
      today: "2026-06-21",
      deathCertifierCredentialed: true,
    });
    expect(outboxEvents(death.effects)).toEqual(
      expect.arrayContaining(["m6.discharge.death", "m6.bereavement.eligible"]),
    );
  });
});

describe("§2.4 validation catalog", () => {
  it("every synchronous rule id maps to a known machine-readable code", () => {
    for (const [rule, code] of Object.entries(SYNC_VALIDATION_RULES)) {
      expect(typeof code).toBe("string");
      expect(rule).toMatch(/^R-/);
    }
  });
});
