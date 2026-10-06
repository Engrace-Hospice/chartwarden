/**
 * F-217 — the F2F/CTI adequacy predicate (`06-admission/certification/adequacy.ts`), PURE unit tests.
 *
 * Window/late boundaries are pinned on exact instants in `America/Los_Angeles` (org TZ, D8) on a date well
 * before the March DST change so the offset is a constant -08:00: a period starting 2026-03-01 has its
 * F2F window [2026-01-30, 2026-02-28], a CTI is "late" from 2026-03-02T08:00:00.000Z (local midnight), and
 * its written-cert deadline is 2026-03-04T07:59:59.999Z (2026-03-03 23:59:59.999 local).
 */
import { describe, expect, it } from "vitest";
import {
  ADEQUACY_FLAG_CODES,
  ADEQUACY_REASON_CODES,
  type AdequacyCtiFact,
  type AdequacyF2fFact,
  type AdequacyInput,
  evaluatePeriodAdequacy,
  f2fRequiredForSequence,
  pickCertification,
  pickFaceToFace,
  summarizeAdequacy,
} from "../src/modules/06-admission/certification/adequacy";
import { localDateOfInstant } from "../src/modules/06-admission/certification/window-math";

const TZ = "America/Los_Angeles";
const PERIOD = "pppppppp-0000-4000-8000-000000000001";
const MD = "mmmmmmmm-0000-4000-8000-000000000001";
const OTHER = "mmmmmmmm-0000-4000-8000-000000000002";
const START = "2026-03-01";
const NARRATIVE = "n".repeat(200);
const SIGNED_ON_START = "2026-03-01T18:00:00.000Z"; // 10:00 local on the start date
const ATTESTED = "2026-02-10T18:00:00.000Z";

const cti = (o: Partial<AdequacyCtiFact> = {}): AdequacyCtiFact => ({
  electionPeriodId: PERIOD,
  status: "signed",
  hospiceMdId: MD,
  hospiceMdSignedAt: SIGNED_ON_START,
  attendingMdId: null,
  attendingMdSignedAt: null,
  narrative: NARRATIVE,
  signedLate: false,
  lateReason: null,
  ...o,
});
const f2f = (o: Partial<AdequacyF2fFact> = {}): AdequacyF2fFact => ({
  electionPeriodId: PERIOD,
  status: "attested",
  performerRole: "hospice_np",
  encounterDate: "2026-02-10",
  withinWindow: true,
  windowOverride: false,
  windowOverrideReason: null,
  windowOverrideBy: null,
  attestationSignedAt: ATTESTED,
  ...o,
});
const input = (seq: number, o: Partial<AdequacyInput> = {}): AdequacyInput => ({
  period: {
    electionPeriodId: PERIOD,
    sequenceNumber: seq,
    periodKind: seq <= 2 ? "ninety_day" : "sixty_day",
    startDate: START,
  },
  admissionHospicePhysicianId: MD,
  timeZone: TZ,
  ctis: [cti()],
  f2fs: [f2f()],
  ...o,
});

describe("F-217 adequacy — sequencing (90/90/60) and F2F requirement", () => {
  it.each([
    [1, false],
    [2, false],
    [3, true],
    [4, true],
    [13, true],
  ])("sequence %i: f2fRequired=%s", (seq, required) => {
    expect(f2fRequiredForSequence(seq)).toBe(required);
    expect(evaluatePeriodAdequacy(input(seq)).f2fRequired).toBe(required);
  });

  it("periods 1 and 2 are adequate with a signed CTI and NO F2F at all", () => {
    for (const seq of [1, 2]) {
      const r = evaluatePeriodAdequacy(input(seq, { f2fs: [] }));
      expect(r.verdict).toBe("adequate");
      expect(r.f2f).toEqual({ required: false, adequate: true, reasonCodes: [] });
    }
  });

  it("a period-2 F2F that is garbage is ignored — F2F is not evaluated below sequence 3", () => {
    const r = evaluatePeriodAdequacy(input(2, { f2fs: [f2f({ status: "scheduled" })] }));
    expect(r.verdict).toBe("adequate");
  });

  it("period 3 (first 60-day period) with no F2F is inadequate: F2F_MISSING", () => {
    const r = evaluatePeriodAdequacy(input(3, { f2fs: [] }));
    expect(r.verdict).toBe("inadequate");
    expect(r.reasonCodes).toEqual(["F2F_MISSING"]);
    expect(r.cti.adequate).toBe(true);
    expect(r.f2f).toEqual({ required: true, adequate: false, reasonCodes: ["F2F_MISSING"] });
  });

  it("period 3 and every later period are adequate with CTI + in-window attested F2F", () => {
    for (const seq of [3, 4, 9])
      expect(evaluatePeriodAdequacy(input(seq)).verdict).toBe("adequate");
  });

  it("refuses a period_kind that disagrees with the sequence (3 must be sixty_day, 2 ninety_day)", () => {
    const a = evaluatePeriodAdequacy({
      ...input(3),
      period: { ...input(3).period, periodKind: "ninety_day" },
    });
    expect(a.reasonCodes).toContain("PERIOD_KIND_SEQUENCE_MISMATCH");
    const b = evaluatePeriodAdequacy({
      ...input(2),
      period: { ...input(2).period, periodKind: "sixty_day" },
    });
    expect(b.reasonCodes).toEqual(["PERIOD_KIND_SEQUENCE_MISMATCH"]);
  });

  it("accepts an unknown period_kind (null/undefined is not checked) and refuses sequence < 1", () => {
    const k = evaluatePeriodAdequacy({
      ...input(3),
      period: { ...input(3).period, periodKind: null },
    });
    expect(k.verdict).toBe("adequate");
    for (const bad of [0, -1, 2.5]) {
      expect(evaluatePeriodAdequacy(input(bad)).reasonCodes).toContain("PERIOD_SEQUENCE_INVALID");
    }
  });
});

describe("F-217 adequacy — the CTI", () => {
  it("adequate: signed, right period, admission physician, 200-char narrative", () => {
    const r = evaluatePeriodAdequacy(input(2));
    expect(r.verdict).toBe("adequate");
    expect(r.flags).toEqual([]);
  });

  it("no CTI row: CTI_MISSING", () => {
    expect(evaluatePeriodAdequacy(input(2, { ctis: [] })).reasonCodes).toEqual(["CTI_MISSING"]);
  });

  it("a CTI row on a different period: CTI_WRONG_PERIOD", () => {
    const r = evaluatePeriodAdequacy(input(2, { ctis: [cti({ electionPeriodId: "other" })] }));
    expect(r.reasonCodes).toEqual(["CTI_WRONG_PERIOD"]);
  });

  it("voided-only / superseded-only: CTI_VOIDED / CTI_SUPERSEDED (not MISSING)", () => {
    expect(
      evaluatePeriodAdequacy(input(2, { ctis: [cti({ status: "voided" })] })).reasonCodes,
    ).toEqual(["CTI_VOIDED"]);
    expect(
      evaluatePeriodAdequacy(input(2, { ctis: [cti({ status: "superseded" })] })).reasonCodes,
    ).toEqual(["CTI_SUPERSEDED"]);
  });

  it("a voided CTI followed by a live signed replacement is adequate (the live row is picked)", () => {
    const r = evaluatePeriodAdequacy(input(2, { ctis: [cti({ status: "voided" }), cti()] }));
    expect(r.verdict).toBe("adequate");
  });

  it.each(["drafted", "awaiting_hospice_md"])("unsigned (%s): CTI_NOT_SIGNED", (status) => {
    const r = evaluatePeriodAdequacy(
      input(2, { ctis: [cti({ status, hospiceMdSignedAt: null })] }),
    );
    expect(r.reasonCodes).toEqual(["CTI_NOT_SIGNED"]);
  });

  it("status=signed but no signature instant: CTI_SIGNATURE_MISSING", () => {
    const r = evaluatePeriodAdequacy(input(2, { ctis: [cti({ hospiceMdSignedAt: null })] }));
    expect(r.reasonCodes).toEqual(["CTI_SIGNATURE_MISSING"]);
  });

  it("a recert (period >= 2) stuck at awaiting_attending is NOT adequate (D3: attending is period-1 only)", () => {
    const r = evaluatePeriodAdequacy(
      input(2, { ctis: [cti({ status: "awaiting_attending", attendingMdId: MD })] }),
    );
    expect(r.reasonCodes).toEqual(["CTI_NOT_SIGNED"]);
  });

  it("period 1: hospice-MD signature alone clears it (D3); the attending co-sign is only a flag", () => {
    const r = evaluatePeriodAdequacy(
      input(1, {
        ctis: [
          cti({ status: "awaiting_attending", attendingMdId: OTHER, attendingMdSignedAt: null }),
        ],
      }),
    );
    expect(r.verdict).toBe("adequate");
    expect(r.flags).toEqual(["CTI_ATTENDING_COSIGN_PENDING"]);
  });

  it("period 1 fully signed with both signatures has no co-sign flag", () => {
    const r = evaluatePeriodAdequacy(
      input(1, {
        ctis: [cti({ attendingMdId: OTHER, attendingMdSignedAt: "2026-03-01T19:00:00.000Z" })],
      }),
    );
    expect(r.verdict).toBe("adequate");
    expect(r.flags).toEqual([]);
  });

  it("period 1 awaiting_attending with NO hospice-MD signature is still inadequate", () => {
    const r = evaluatePeriodAdequacy(
      input(1, { ctis: [cti({ status: "awaiting_attending", hospiceMdSignedAt: null })] }),
    );
    expect(r.reasonCodes).toEqual(["CTI_NOT_SIGNED"]);
  });

  it("wrong signer: CTI_SIGNER_NOT_ADMISSION_PHYSICIAN; unresolved signer/physician: CTI_SIGNER_UNRESOLVED", () => {
    expect(
      evaluatePeriodAdequacy(input(2, { ctis: [cti({ hospiceMdId: OTHER })] })).reasonCodes,
    ).toEqual(["CTI_SIGNER_NOT_ADMISSION_PHYSICIAN"]);
    expect(
      evaluatePeriodAdequacy(input(2, { admissionHospicePhysicianId: null })).reasonCodes,
    ).toEqual(["CTI_SIGNER_UNRESOLVED"]);
    expect(
      evaluatePeriodAdequacy(input(2, { ctis: [cti({ hospiceMdId: null })] })).reasonCodes,
    ).toEqual(["CTI_SIGNER_UNRESOLVED"]);
  });

  it("narrative: null/blank is MISSING; 199 chars is TOO_SHORT; exactly 200 passes; whitespace is trimmed", () => {
    const reasons = (narrative: string | null) =>
      evaluatePeriodAdequacy(input(2, { ctis: [cti({ narrative })] })).reasonCodes;
    expect(reasons(null)).toEqual(["CTI_NARRATIVE_MISSING"]);
    expect(reasons("   \n ")).toEqual(["CTI_NARRATIVE_MISSING"]);
    expect(reasons("n".repeat(199))).toEqual(["CTI_NARRATIVE_TOO_SHORT"]);
    expect(reasons("n".repeat(200))).toEqual([]);
    expect(reasons(`  ${"n".repeat(199)}  `)).toEqual(["CTI_NARRATIVE_TOO_SHORT"]);
  });

  it("several defects are all reported, in a stable order", () => {
    const r = evaluatePeriodAdequacy(
      input(2, { ctis: [cti({ hospiceMdId: OTHER, narrative: null })] }),
    );
    expect(r.reasonCodes).toEqual(["CTI_SIGNER_NOT_ADMISSION_PHYSICIAN", "CTI_NARRATIVE_MISSING"]);
  });
});

describe("F-217 adequacy — late CTI is a FLAG, never a block (R-CTI-01, D4, D8)", () => {
  const signedAt = (iso: string, o: Partial<AdequacyCtiFact> = {}) =>
    evaluatePeriodAdequacy(input(2, { ctis: [cti({ hospiceMdSignedAt: iso, ...o })] }));

  it("signed at 23:59:59.999 local on the start date is NOT late; one ms later (local midnight) is", () => {
    expect(signedAt("2026-03-02T07:59:59.999Z").flags).toEqual([]);
    const late = signedAt("2026-03-02T08:00:00.000Z");
    expect(late.verdict).toBe("adequate"); // a flag, not a block
    expect(late.flags).toEqual(["CTI_SIGNED_LATE", "CTI_LATE_REASON_MISSING"]);
  });

  it("a late CTI with a reason drops only the LATE_REASON flag", () => {
    const r = signedAt("2026-03-02T18:00:00.000Z", {
      lateReason: "oral cert obtained, paper pending",
    });
    expect(r.flags).toEqual(["CTI_SIGNED_LATE"]);
  });

  it("written-cert deadline is period_start + 2 days 23:59:59.999 local: on it is fine, 1 ms after is missed", () => {
    const onDeadline = signedAt("2026-03-04T07:59:59.999Z", { lateReason: "x" });
    expect(onDeadline.flags).toEqual(["CTI_SIGNED_LATE"]);
    const past = signedAt("2026-03-04T08:00:00.000Z", { lateReason: "x" });
    expect(past.verdict).toBe("adequate"); // D4: flagged, NOT auto-held
    expect(past.flags).toEqual(["CTI_WRITTEN_CERT_DEADLINE_MISSED", "CTI_SIGNED_LATE"]);
  });

  it("a row marked late via route 27 (signedLate=true) carries the flag even when signed on time", () => {
    const r = signedAt(SIGNED_ON_START, { signedLate: true });
    expect(r.flags).toEqual(["CTI_SIGNED_LATE", "CTI_LATE_REASON_MISSING"]);
  });

  it("a signature BEFORE the start date is never late", () => {
    expect(signedAt("2026-02-20T18:00:00.000Z").flags).toEqual([]);
  });

  it("lateness is measured in the ORG timezone, not UTC", () => {
    // 2026-03-02T03:00Z is still 2026-03-01 19:00 in Los Angeles -> on time; in UTC it would be 'late'.
    expect(signedAt("2026-03-02T03:00:00.000Z").flags).toEqual([]);
    expect(localDateOfInstant("2026-03-02T03:00:00.000Z", TZ)).toBe("2026-03-01");
    // The same instant against an org in Auckland (UTC+13 in March) is 2026-03-02 -> late.
    const nz = evaluatePeriodAdequacy(
      input(2, {
        timeZone: "Pacific/Auckland",
        ctis: [cti({ hospiceMdSignedAt: "2026-03-02T03:00:00.000Z" })],
      }),
    );
    expect(nz.flags).toContain("CTI_SIGNED_LATE");
  });

  it("DST: the deadline tracks the zone offset (PDT after 2026-03-08)", () => {
    // start 2026-03-10 (PDT, -07:00): deadline = 2026-03-12 23:59:59.999 PDT = 2026-03-13T06:59:59.999Z
    const base = input(2, {
      period: {
        electionPeriodId: PERIOD,
        sequenceNumber: 2,
        periodKind: "ninety_day",
        startDate: "2026-03-10",
      },
    });
    const at = (iso: string) =>
      evaluatePeriodAdequacy({ ...base, ctis: [cti({ hospiceMdSignedAt: iso, lateReason: "x" })] })
        .flags;
    expect(at("2026-03-13T06:59:59.999Z")).toEqual(["CTI_SIGNED_LATE"]);
    expect(at("2026-03-13T07:00:00.000Z")).toEqual([
      "CTI_WRITTEN_CERT_DEADLINE_MISSED",
      "CTI_SIGNED_LATE",
    ]);
  });
});

describe("F-217 adequacy — the F2F (required from period 3)", () => {
  const p3 = (f: Partial<AdequacyF2fFact> | null, o: Partial<AdequacyInput> = {}) =>
    evaluatePeriodAdequacy(input(3, { f2fs: f === null ? [] : [f2f(f)], ...o }));

  it("missing / scheduled / completed-but-unattested: MISSING / NOT_ATTESTED", () => {
    expect(p3(null).reasonCodes).toEqual(["F2F_MISSING"]);
    expect(p3({ status: "scheduled" }).reasonCodes).toEqual(["F2F_NOT_ATTESTED"]);
    expect(p3({ status: "completed" }).reasonCodes).toEqual(["F2F_NOT_ATTESTED"]);
  });

  it("an attested row wins over an earlier scheduled one (same pick as the claim reader)", () => {
    const r = evaluatePeriodAdequacy(input(3, { f2fs: [f2f({ status: "scheduled" }), f2f()] }));
    expect(r.verdict).toBe("adequate");
    expect(pickFaceToFace([{ status: "scheduled" }, { status: "attested" }])?.status).toBe(
      "attested",
    );
    expect(pickFaceToFace([{ status: "scheduled" }, { status: "completed" }])?.status).toBe(
      "scheduled",
    );
  });

  it("an F2F on another period: F2F_WRONG_PERIOD", () => {
    expect(p3({ electionPeriodId: "other" }).reasonCodes).toEqual(["F2F_WRONG_PERIOD"]);
  });

  it("attested status but no attestation signature instant: F2F_ATTESTATION_UNSIGNED", () => {
    expect(p3({ attestationSignedAt: null }).reasonCodes).toEqual(["F2F_ATTESTATION_UNSIGNED"]);
  });

  it.each(["hospice_md", "hospice_np"])("performer %s is eligible", (performerRole) => {
    expect(p3({ performerRole }).verdict).toBe("adequate");
  });

  it.each(["attending", "rn", "", null])(
    "performer %s is ineligible (R-F2F-01)",
    (performerRole) => {
      expect(p3({ performerRole }).reasonCodes).toEqual(["F2F_PERFORMER_INELIGIBLE"]);
    },
  );

  describe("window basis 'recorded' (the activation gate's mode)", () => {
    it("within_window=true passes; false is OUTSIDE_WINDOW; null is UNVERIFIED (fail-closed)", () => {
      expect(p3({ withinWindow: true }).verdict).toBe("adequate");
      expect(p3({ withinWindow: false }).reasonCodes).toEqual(["F2F_OUTSIDE_WINDOW"]);
      expect(p3({ withinWindow: null }).reasonCodes).toEqual(["F2F_WINDOW_UNVERIFIED"]);
    });
    it("the recorded flag is trusted over a stale encounter_date", () => {
      expect(p3({ withinWindow: true, encounterDate: "2020-01-01" }).verdict).toBe("adequate");
    });
  });

  describe("window basis 'dates': [start-30, start] on exact days (R-F2F-02, MBPM ch. 9 §20.1(5)(a))", () => {
    const at = (encounterDate: string | null) =>
      p3({ encounterDate, withinWindow: null }, { windowBasis: "dates" }).reasonCodes;
    it("start-30 (2026-01-30) and start-1 (2026-02-28) are inside", () => {
      expect(at("2026-01-30")).toEqual([]);
      expect(at("2026-02-28")).toEqual([]);
    });
    it("the period's first day (2026-03-01) is timely", () => {
      expect(at("2026-03-01")).toEqual([]);
    });
    it("start-31 (2026-01-29) and start+1 and later are outside", () => {
      expect(at("2026-01-29")).toEqual(["F2F_OUTSIDE_WINDOW"]);
      expect(at("2026-03-02")).toEqual(["F2F_OUTSIDE_WINDOW"]);
      expect(at("2026-03-03")).toEqual(["F2F_OUTSIDE_WINDOW"]);
    });
    it("a missing encounter date cannot be verified: F2F_ENCOUNTER_DATE_MISSING", () => {
      expect(at(null)).toEqual(["F2F_ENCOUNTER_DATE_MISSING"]);
    });
    it("uses the period start it is given (window moves with the start)", () => {
      const r = evaluatePeriodAdequacy(
        input(3, {
          windowBasis: "dates",
          period: {
            electionPeriodId: PERIOD,
            sequenceNumber: 3,
            periodKind: "sixty_day",
            startDate: "2026-04-01",
          },
          f2fs: [f2f({ encounterDate: "2026-02-10" })],
        }),
      );
      expect(r.reasonCodes).toEqual(["F2F_OUTSIDE_WINDOW"]);
    });
  });

  describe("window override (R-F2F-03 / D5)", () => {
    const REASON = "documented hospitalisation delayed the visit";
    it("a valid override satisfies an out-of-window F2F and is FLAGGED, not blocked", () => {
      for (const basis of ["recorded", "dates"] as const) {
        const r = p3(
          {
            withinWindow: false,
            encounterDate: "2026-01-01",
            windowOverride: true,
            windowOverrideReason: REASON,
            windowOverrideBy: OTHER,
          },
          { windowBasis: basis },
        );
        expect(r.verdict).toBe("adequate");
        expect(r.flags).toEqual(["F2F_WINDOW_OVERRIDDEN"]);
      }
    });
    it("an override whose reason is < 20 chars (19 fails, 20 passes) or with no overriding user is invalid", () => {
      const base = { withinWindow: false, windowOverride: true, windowOverrideBy: OTHER } as const;
      expect(p3({ ...base, windowOverrideReason: "x".repeat(19) }).reasonCodes).toEqual([
        "F2F_OVERRIDE_INVALID",
      ]);
      expect(p3({ ...base, windowOverrideReason: "x".repeat(20) }).verdict).toBe("adequate");
      expect(
        p3({ ...base, windowOverrideReason: REASON, windowOverrideBy: null }).reasonCodes,
      ).toEqual(["F2F_OVERRIDE_INVALID"]);
      expect(p3({ ...base, windowOverrideReason: null }).reasonCodes).toEqual([
        "F2F_OVERRIDE_INVALID",
      ]);
    });
    it("an override does NOT excuse a missing attestation or an ineligible performer", () => {
      const r = p3({
        windowOverride: true,
        windowOverrideReason: REASON,
        windowOverrideBy: OTHER,
        performerRole: "attending",
        attestationSignedAt: null,
      });
      expect(r.reasonCodes).toEqual(["F2F_ATTESTATION_UNSIGNED", "F2F_PERFORMER_INELIGIBLE"]);
    });
  });
});

describe("F-217 adequacy — result shape", () => {
  it("combines CTI + F2F + period reasons and keeps the sections separate", () => {
    const r = evaluatePeriodAdequacy({
      ...input(3, { ctis: [], f2fs: [f2f({ performerRole: "attending" })] }),
      period: { ...input(3).period, periodKind: "ninety_day" },
    });
    expect(r.verdict).toBe("inadequate");
    expect(r.reasonCodes).toEqual([
      "PERIOD_KIND_SEQUENCE_MISMATCH",
      "CTI_MISSING",
      "F2F_PERFORMER_INELIGIBLE",
    ]);
    expect(r.cti).toEqual({ adequate: false, reasonCodes: ["CTI_MISSING"] });
    expect(r.f2f.reasonCodes).toEqual(["F2F_PERFORMER_INELIGIBLE"]);
  });

  it("every emitted code is a member of the published vocabulary, and the vocabulary is duplicate-free", () => {
    const r = evaluatePeriodAdequacy(input(3, { ctis: [], f2fs: [] }));
    for (const c of r.reasonCodes) expect(ADEQUACY_REASON_CODES).toContain(c);
    expect(new Set(ADEQUACY_REASON_CODES).size).toBe(ADEQUACY_REASON_CODES.length);
    expect(new Set(ADEQUACY_FLAG_CODES).size).toBe(ADEQUACY_FLAG_CODES.length);
  });

  it("the summary carries only codes — no ids, dates or narrative text (no PHI)", () => {
    const r = evaluatePeriodAdequacy(input(3, { ctis: [cti({ hospiceMdId: OTHER })], f2fs: [] }));
    const s = summarizeAdequacy(r);
    expect(Object.keys(s).sort()).toEqual(["f2fRequired", "flags", "reasonCodes", "verdict"]);
    const wire = JSON.stringify(s);
    expect(wire).not.toContain(MD);
    expect(wire).not.toContain(OTHER);
    expect(wire).not.toContain(PERIOD);
    expect(wire).not.toContain(NARRATIVE);
  });

  it("is deterministic and does not mutate its input", () => {
    const i = input(3);
    const snapshot = JSON.stringify(i);
    const a = evaluatePeriodAdequacy(i);
    const b = evaluatePeriodAdequacy(i);
    expect(a).toEqual(b);
    expect(JSON.stringify(i)).toBe(snapshot);
  });

  it("pickCertification: first live row, else the latest row", () => {
    expect(pickCertification([{ status: "voided" }, { status: "signed" }])?.status).toBe("signed");
    expect(pickCertification([{ status: "voided" }, { status: "superseded" }])?.status).toBe(
      "superseded",
    );
    expect(pickCertification([])).toBeUndefined();
  });
});
