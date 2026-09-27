// apps/backend/__tests__/encounter-compliance-gate.test.ts — the §2.6 Layer-3 compliance gate (#121).
//
// Two jobs. (1) The gate DECIDES: an undocumented note fails with a per-section remediation list, a
// documented one passes, an overdue care plan blocks. (2) The REGISTER stays honest — every §2.6 check
// is accounted for, what the register calls `evaluated` is what the gate actually decides, and what it
// calls deferred carries a blocker and what would lift it. The second half is why this file exists:
// the defect (#121) was not a check answering wrongly, it was twelve checks being nowhere while
// `transitionEncounter` enforced a literal `true` and looked like it was enforcing them.
import { STANDARD_VITALS_ROSTER, resolveTemplate } from "@wardenx/hearthnote";
import type {
  CarePlanOverdueStatus,
  EncounterDiscipline,
  EncounterType,
  ScaleType,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  EVALUATED_CHECKS,
  GATE_CHECKS,
  type GateCheckId,
  type GateSectionSelection,
  assertGatePassed,
  runAddendumComplianceGate,
  runEncounterComplianceGate,
} from "../src/modules/08-encounters/gate/index";

const CODE = "nv.cv.stable";

/** One selection per required section of a template — the smallest tree that passes check 1. */
function documented(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
): GateSectionSelection[] {
  const template = resolveTemplate(encounterType, discipline);
  if (!template) throw new Error("no template");
  return template.sections
    .filter((s) => s.required)
    .map((s) => ({ sectionId: s.id, entryCount: 1, hasFreeText: false }));
}

/** Every §2.6 check-2 vital field captured — the smallest fact set that passes check 2 for a type
 *  whose template requires the standard roster (routine_visit, admission_visit, recert_visit,
 *  face_to_face, lpn_visit, and an rn/lpn/md/np-authored idg_followup — see `requiredVitalsFor`). */
const ALL_VITALS_CAPTURED = new Set(STANDARD_VITALS_ROSTER);
const NO_VITALS_CAPTURED = new Set<(typeof STANDARD_VITALS_ROSTER)[number]>();
const NO_CNI = new Set<(typeof STANDARD_VITALS_ROSTER)[number]>();
const NO_SCALES_PRESENT = new Set<ScaleType>();

const NOT_OVERDUE: CarePlanOverdueStatus = {
  planId: "cp_1" as CarePlanOverdueStatus["planId"],
  patientId: "p_1" as CarePlanOverdueStatus["patientId"],
  overdue: false,
  initialOverdue: false,
  reviewOverdue: false,
  initialDueAt: "2026-01-06T00:00:00.000Z" as CarePlanOverdueStatus["initialDueAt"],
  nextReviewDueAt: "2026-01-20T00:00:00.000Z" as CarePlanOverdueStatus["nextReviewDueAt"],
};

describe("§2.6 Layer-3 gate — check 1, required HearthNote sections", () => {
  it("refuses an encounter with no selections, naming every required section", () => {
    const r = runEncounterComplianceGate({
      encounterType: "routine_visit",
      discipline: "rn",
      sections: [],
      carePlanOverdue: null,
      // Checks 2/3 held satisfied so this case isolates check 1's own remediation list.
      vitalsCaptured: ALL_VITALS_CAPTURED,
      vitalsClinicallyNotIndicated: NO_CNI,
      scalesPresent: NO_SCALES_PRESENT,
    });
    expect(r.pass).toBe(false);
    if (r.pass) return;
    expect(r.remediation.map((x) => x.field).sort()).toEqual([
      "assessment",
      "chief_concern",
      "plan",
      "vitals_review",
    ]);
    expect(new Set(r.remediation.map((x) => x.code))).toEqual(new Set(["MISSING_SECTION"]));
  });

  it("passes when every required section carries a selection", () => {
    expect(
      runEncounterComplianceGate({
        encounterType: "routine_visit",
        discipline: "rn",
        sections: documented("routine_visit", "rn"),
        carePlanOverdue: NOT_OVERDUE,
        vitalsCaptured: ALL_VITALS_CAPTURED,
        vitalsClinicallyNotIndicated: NO_CNI,
        scalesPresent: NO_SCALES_PRESENT,
      }).pass,
    ).toBe(true);
  });

  it("counts a section populated by free text alone — prose IS documentation (§2.6)", () => {
    const sections = documented("routine_visit", "rn").map((s) =>
      s.sectionId === "plan" ? { ...s, entryCount: 0, hasFreeText: true } : s,
    );
    expect(
      runEncounterComplianceGate({
        encounterType: "routine_visit",
        discipline: "rn",
        sections,
        carePlanOverdue: null,
        vitalsCaptured: ALL_VITALS_CAPTURED,
        vitalsClinicallyNotIndicated: NO_CNI,
        scalesPresent: NO_SCALES_PRESENT,
      }).pass,
    ).toBe(true);
  });

  it("does not count an OPTIONAL section towards a required one, or a required one twice", () => {
    // Only `symptom_management` (optional) is populated: all four required sections are still missing.
    const r = runEncounterComplianceGate({
      encounterType: "routine_visit",
      discipline: "rn",
      sections: [{ sectionId: "symptom_management", entryCount: 3, hasFreeText: true }],
      carePlanOverdue: null,
      vitalsCaptured: ALL_VITALS_CAPTURED,
      vitalsClinicallyNotIndicated: NO_CNI,
      scalesPresent: NO_SCALES_PRESENT,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.remediation).toHaveLength(4);
  });

  it("refuses rather than passes when the pair has no template at all", () => {
    const r = runEncounterComplianceGate({
      // `volunteer` may not author a face_to_face note — a §2.7 guard catches this long before the
      // gate, and if it ever does not, the gate must not wave through a note it cannot judge.
      encounterType: "face_to_face",
      discipline: "volunteer",
      sections: [{ sectionId: "chief_concern", entryCount: 1, hasFreeText: false }],
      carePlanOverdue: null,
      vitalsCaptured: NO_VITALS_CAPTURED,
      vitalsClinicallyNotIndicated: NO_CNI,
      scalesPresent: NO_SCALES_PRESENT,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.remediation[0]?.code).toBe("NO_TEMPLATE_FOR_PAIR");
  });
});

describe("§2.6 Layer-3 gate — check 2, required vitals (#125)", () => {
  it("refuses a routine_visit missing a required vital, naming the field and the standard remediation copy", () => {
    const r = runEncounterComplianceGate({
      encounterType: "routine_visit",
      discipline: "rn",
      sections: documented("routine_visit", "rn"),
      carePlanOverdue: null,
      vitalsCaptured: new Set(["heartRate", "respiratoryRate", "temperature", "spo2", "pain"]),
      vitalsClinicallyNotIndicated: NO_CNI,
      scalesPresent: NO_SCALES_PRESENT,
    });
    expect(r.pass).toBe(false);
    if (r.pass) return;
    expect(r.remediation).toContainEqual(
      expect.objectContaining({
        check: "required_vitals",
        code: "MISSING_VITAL",
        field: "bp",
        message: "BP not captured — required for routine_visit",
      }),
    );
  });

  it("the `clinically_not_indicated` escape hatch satisfies check 2 for the field it names", () => {
    expect(
      runEncounterComplianceGate({
        encounterType: "routine_visit",
        discipline: "rn",
        sections: documented("routine_visit", "rn"),
        carePlanOverdue: null,
        vitalsCaptured: new Set(["heartRate", "respiratoryRate", "temperature", "spo2", "pain"]),
        vitalsClinicallyNotIndicated: new Set(["bp"]),
        scalesPresent: NO_SCALES_PRESENT,
      }).pass,
    ).toBe(true);
  });

  it("requires nothing for telephonic — the template strips vitals_review for that type", () => {
    expect(
      runEncounterComplianceGate({
        encounterType: "telephonic",
        discipline: "rn",
        sections: documented("telephonic", "rn"),
        carePlanOverdue: null,
        vitalsCaptured: NO_VITALS_CAPTURED,
        vitalsClinicallyNotIndicated: NO_CNI,
        scalesPresent: NO_SCALES_PRESENT,
      }).pass,
    ).toBe(true);
  });

  it("requires nothing for chha_visit — the CHHA base template carries no vitals_review section", () => {
    expect(
      runEncounterComplianceGate({
        encounterType: "chha_visit",
        discipline: "chha",
        sections: documented("chha_visit", "chha"),
        carePlanOverdue: null,
        vitalsCaptured: NO_VITALS_CAPTURED,
        vitalsClinicallyNotIndicated: NO_CNI,
        scalesPresent: NO_SCALES_PRESENT,
      }).pass,
    ).toBe(true);
  });

  it("is discipline-dependent for idg_followup — RN requires vitals, MSW does not", () => {
    const rn = runEncounterComplianceGate({
      encounterType: "idg_followup",
      discipline: "rn",
      sections: documented("idg_followup", "rn"),
      carePlanOverdue: null,
      vitalsCaptured: NO_VITALS_CAPTURED,
      vitalsClinicallyNotIndicated: NO_CNI,
      scalesPresent: NO_SCALES_PRESENT,
    });
    expect(rn.pass).toBe(false);
    if (!rn.pass) expect(rn.remediation.some((x) => x.check === "required_vitals")).toBe(true);

    expect(
      runEncounterComplianceGate({
        encounterType: "idg_followup",
        discipline: "msw",
        sections: documented("idg_followup", "msw"),
        carePlanOverdue: null,
        vitalsCaptured: NO_VITALS_CAPTURED,
        vitalsClinicallyNotIndicated: NO_CNI,
        scalesPresent: NO_SCALES_PRESENT,
      }).pass,
    ).toBe(true);
  });
});

describe("§2.6 Layer-3 gate — check 3, required clinical scales (#125)", () => {
  it("refuses a recert_visit missing a required scale, naming the scale", () => {
    const r = runEncounterComplianceGate({
      encounterType: "recert_visit",
      discipline: "rn",
      sections: documented("recert_visit", "rn"),
      carePlanOverdue: null,
      vitalsCaptured: ALL_VITALS_CAPTURED,
      vitalsClinicallyNotIndicated: NO_CNI,
      scalesPresent: new Set(["pps"]),
    });
    expect(r.pass).toBe(false);
    if (r.pass) return;
    expect(r.remediation).toContainEqual(
      expect.objectContaining({ check: "required_scales", code: "MISSING_SCALE", field: "esas_r" }),
    );
  });

  it("passes once every required scale is present", () => {
    expect(
      runEncounterComplianceGate({
        encounterType: "recert_visit",
        discipline: "rn",
        sections: documented("recert_visit", "rn"),
        carePlanOverdue: null,
        vitalsCaptured: ALL_VITALS_CAPTURED,
        vitalsClinicallyNotIndicated: NO_CNI,
        scalesPresent: new Set(["pps", "esas_r"]),
      }).pass,
    ).toBe(true);
  });

  it("requires nothing for routine_visit — no scale roster is declared for it", () => {
    expect(
      runEncounterComplianceGate({
        encounterType: "routine_visit",
        discipline: "rn",
        sections: documented("routine_visit", "rn"),
        carePlanOverdue: null,
        vitalsCaptured: ALL_VITALS_CAPTURED,
        vitalsClinicallyNotIndicated: NO_CNI,
        scalesPresent: NO_SCALES_PRESENT,
      }).pass,
    ).toBe(true);
  });
});

describe("§2.6 Layer-3 gate — check 6, the M7 care-plan review window", () => {
  it("blocks when the plan is past its 15-day review", () => {
    const r = runEncounterComplianceGate({
      encounterType: "routine_visit",
      discipline: "rn",
      sections: documented("routine_visit", "rn"),
      carePlanOverdue: { ...NOT_OVERDUE, overdue: true, reviewOverdue: true },
      vitalsCaptured: ALL_VITALS_CAPTURED,
      vitalsClinicallyNotIndicated: NO_CNI,
      scalesPresent: NO_SCALES_PRESENT,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.remediation[0]?.code).toBe("CARE_PLAN_REVIEW_OVERDUE");
  });

  it("blocks on the 5-day INITIAL gate with its own message", () => {
    const r = runEncounterComplianceGate({
      encounterType: "routine_visit",
      discipline: "rn",
      sections: documented("routine_visit", "rn"),
      carePlanOverdue: { ...NOT_OVERDUE, overdue: true, initialOverdue: true },
      vitalsCaptured: ALL_VITALS_CAPTURED,
      vitalsClinicallyNotIndicated: NO_CNI,
      scalesPresent: NO_SCALES_PRESENT,
    });
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.remediation[0]?.message).toContain("5-day initial review");
  });

  it("does NOT block when the patient has no active care plan (null is not a failure)", () => {
    expect(
      runEncounterComplianceGate({
        encounterType: "routine_visit",
        discipline: "rn",
        sections: documented("routine_visit", "rn"),
        carePlanOverdue: null,
        vitalsCaptured: ALL_VITALS_CAPTURED,
        vitalsClinicallyNotIndicated: NO_CNI,
        scalesPresent: NO_SCALES_PRESENT,
      }).pass,
    ).toBe(true);
  });
});

describe("§2.6 Layer-3 gate — addenda", () => {
  it("refuses an addendum with nothing in it", () => {
    const r = runAddendumComplianceGate([]);
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.remediation[0]?.code).toBe("ADDENDUM_EMPTY");
  });

  it("accepts one populated section — it is NOT judged against the parent's required set", () => {
    // The parent routine_visit × rn template requires four sections; an addendum documents one finding.
    expect(
      runAddendumComplianceGate([{ sectionId: "assessment", entryCount: 1, hasFreeText: false }])
        .pass,
    ).toBe(true);
    expect(
      runAddendumComplianceGate([{ sectionId: "assessment", entryCount: 0, hasFreeText: true }])
        .pass,
    ).toBe(true);
  });
});

describe("assertGatePassed — the §2.6 '422 with remediation' contract", () => {
  it("raises COMPLIANCE_GATE_FAILED carrying the remediation as envelope details", () => {
    const r = runEncounterComplianceGate({
      encounterType: "routine_visit",
      discipline: "rn",
      sections: [],
      carePlanOverdue: null,
      vitalsCaptured: ALL_VITALS_CAPTURED,
      vitalsClinicallyNotIndicated: NO_CNI,
      scalesPresent: NO_SCALES_PRESENT,
    });
    try {
      assertGatePassed(r, "sign");
      throw new Error("expected a throw");
    } catch (e) {
      const err = e as { code: string; statusCode: number; details?: unknown[] };
      expect(err.code).toBe("COMPLIANCE_GATE_FAILED");
      expect(err.statusCode).toBe(422);
      expect(err.details).toHaveLength(4);
      expect(err.details?.[0]).toMatchObject({ code: "MISSING_SECTION" });
    }
  });

  it("says nothing and raises nothing on a pass", () => {
    expect(() => assertGatePassed({ pass: true }, "finalize")).not.toThrow();
  });
});

describe("the §2.6 check register", () => {
  const ids = Object.keys(GATE_CHECKS) as GateCheckId[];

  it("accounts for all twelve checks, once each, at their spec ordinals", () => {
    expect(ids).toHaveLength(12);
    expect(ids.map((id) => GATE_CHECKS[id].ordinal).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it("every deferral carries a blocker AND what would lift it — never a bare absence", () => {
    for (const id of ids) {
      const state = GATE_CHECKS[id].state;
      if (state.kind !== "deferred") continue;
      expect(state.blocker.length, `${id} blocker`).toBeGreaterThan(40);
      expect(state.needs.length, `${id} needs`).toBeGreaterThan(20);
    }
    for (const id of ids) {
      const state = GATE_CHECKS[id].state;
      if (state.kind !== "elsewhere") continue;
      expect(state.where.length, `${id} where`).toBeGreaterThan(20);
    }
  });

  it("what the register calls `evaluated` is exactly what the gate decides", () => {
    // Forward: every evaluated check can produce a remediation. Reverse: no remediation cites a check
    // the register does not call evaluated. Together these are why a check cannot quietly stop being
    // run (it would produce no remediation) and a deferral cannot quietly start being run.
    expect([...EVALUATED_CHECKS].sort()).toEqual([
      "care_plan_review",
      "required_scales",
      "required_sections",
      "required_vitals",
    ]);

    // recert_visit × rn: undocumented (check 1), missing a vital (check 2), missing a scale (check 3),
    // and overdue (check 6) — one call that trips all four evaluated checks at once.
    const failing = runEncounterComplianceGate({
      encounterType: "recert_visit",
      discipline: "rn",
      sections: [],
      carePlanOverdue: { ...NOT_OVERDUE, overdue: true, reviewOverdue: true },
      vitalsCaptured: NO_VITALS_CAPTURED,
      vitalsClinicallyNotIndicated: NO_CNI,
      scalesPresent: NO_SCALES_PRESENT,
    });
    expect(failing.pass).toBe(false);
    if (failing.pass) return;
    const cited = new Set(failing.remediation.map((r) => r.check));
    expect([...cited].sort()).toEqual([...EVALUATED_CHECKS].sort());
    for (const c of cited) expect(GATE_CHECKS[c].state.kind).toBe("evaluated");
  });
});
