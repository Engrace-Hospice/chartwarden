// apps/backend/__tests__/encounter-compliance-gate.test.ts — the §2.6 Layer-3 compliance gate (#121).
//
// Two jobs. (1) The gate DECIDES: an undocumented note fails with a per-section remediation list, a
// documented one passes, an overdue care plan blocks. (2) The REGISTER stays honest — every §2.6 check
// is accounted for, what the register calls `evaluated` is what the gate actually decides, and what it
// calls deferred carries a blocker and what would lift it. The second half is why this file exists:
// the defect (#121) was not a check answering wrongly, it was twelve checks being nowhere while
// `transitionEncounter` enforced a literal `true` and looked like it was enforcing them.
import { STANDARD_VITALS_ROSTER, resolveTemplate } from "@chartwarden/hearthnote";
import type {
  CarePlanOverdueStatus,
  EncounterDiscipline,
  EncounterType,
  ScaleType,
} from "@chartwarden/types";
import { Value } from "@sinclair/typebox/value";
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
import {
  AttestationSchema,
  SignEncounterSchema,
} from "../src/modules/08-encounters/routes/encounters-typebox";

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
    const r = runAddendumComplianceGate([], 0);
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.remediation[0]?.code).toBe("ADDENDUM_EMPTY");
  });

  it("accepts one populated section — it is NOT judged against the parent's required set", () => {
    // The parent routine_visit × rn template requires four sections; an addendum documents one finding.
    expect(
      runAddendumComplianceGate([{ sectionId: "assessment", entryCount: 1, hasFreeText: false }], 0)
        .pass,
    ).toBe(true);
    expect(
      runAddendumComplianceGate([{ sectionId: "assessment", entryCount: 0, hasFreeText: true }], 0)
        .pass,
    ).toBe(true);
  });

  it("accepts an amending addendum whose only content is a confirmed amended section (VN-D30)", () => {
    expect(runAddendumComplianceGate([], 1).pass).toBe(true);
    expect(runAddendumComplianceGate([], 3).pass).toBe(true);
  });

  it("still refuses an amending addendum with no confirmed amended section and no selection or annotation (all deselected)", () => {
    const r = runAddendumComplianceGate([], 0);
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.remediation[0]?.code).toBe("ADDENDUM_EMPTY");
  });

  it("words the refusal so it also names the amended section as a way to fill the addendum", () => {
    const r = runAddendumComplianceGate([], 0);
    if (r.pass) throw new Error("expected a refusal");
    expect(r.remediation[0]?.message).toMatch(/confirmed amended section/);
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

  it("accounts for the twelve §2.6 checks and the ADR-0114 draft check, once each, at their ordinals", () => {
    expect(ids).toHaveLength(13);
    expect(ids.map((id) => GATE_CHECKS[id].ordinal).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(GATE_CHECKS.draft_sections_resolved.ordinal).toBe(13);
  });

  it("check 9 is decided by the sign route's schema, which refuses a body that does not carry attestationConfirmed: true", () => {
    const state = GATE_CHECKS.attestation_confirmed.state;
    expect(state.kind).toBe("elsewhere");
    if (state.kind !== "elsewhere") return;
    expect(state.where).toContain("SignEncounterSchema");
    expect(state.where).toContain("attestationConfirmed");
    // The pin: what the register points at really does refuse, on the primary sign and on the cosignature and addendum signatures.
    const visit = { visitModality: "in_person" };
    for (const schema of [SignEncounterSchema, AttestationSchema]) {
      expect(Value.Check(schema, { ...visit, attestationConfirmed: true })).toBe(true);
      expect(Value.Check(schema, { ...visit, attestationConfirmed: false })).toBe(false);
      expect(Value.Check(schema, { ...visit })).toBe(false);
      expect(Value.Check(schema, { ...visit, attestationConfirmed: "true" })).toBe(false);
    }
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
      "draft_sections_resolved",
      "required_scales",
      "required_sections",
      "required_vitals",
    ]);

    // recert_visit × rn: undocumented (check 1), missing a vital (check 2), missing a scale (check 3),
    // overdue (check 6) and an unresolved drafted section (check 13) — one call that trips all five at once.
    const failing = runEncounterComplianceGate({
      encounterType: "recert_visit",
      discipline: "rn",
      sections: [],
      carePlanOverdue: { ...NOT_OVERDUE, overdue: true, reviewOverdue: true },
      vitalsCaptured: NO_VITALS_CAPTURED,
      vitalsClinicallyNotIndicated: NO_CNI,
      scalesPresent: NO_SCALES_PRESENT,
      draftSectionActions: [{ sectionId: "plan", reason: "unresolved" }],
    });
    expect(failing.pass).toBe(false);
    if (failing.pass) return;
    const cited = new Set(failing.remediation.map((r) => r.check));
    expect([...cited].sort()).toEqual([...EVALUATED_CHECKS].sort());
    for (const c of cited) expect(GATE_CHECKS[c].state.kind).toBe("evaluated");
  });
});

describe("§2.6 Layer-3 gate — check 13, every drafted section is resolved (ADR-0114)", () => {
  const base = {
    encounterType: "routine_visit",
    discipline: "rn",
    sections: documented("routine_visit", "rn"),
    carePlanOverdue: null,
    vitalsCaptured: ALL_VITALS_CAPTURED,
    vitalsClinicallyNotIndicated: NO_CNI,
    scalesPresent: NO_SCALES_PRESENT,
  } as const;

  it("does not run when the tenant has no draft: no facts, and the gate is as it was", () => {
    expect(runEncounterComplianceGate(base)).toEqual({ pass: true });
  });

  it("passes when the draft was read and nothing is left for the clinician", () => {
    expect(runEncounterComplianceGate({ ...base, draftSectionActions: [] })).toEqual({
      pass: true,
    });
  });

  it("refuses an unresolved section as DRAFT_SECTION_UNRESOLVED and a changed one as DRAFT_SECTION_STALE, naming each", () => {
    const r = runEncounterComplianceGate({
      ...base,
      draftSectionActions: [
        { sectionId: "interventions", reason: "unresolved" },
        { sectionId: "plan", reason: "stale" },
      ],
    });
    expect(r.pass).toBe(false);
    if (r.pass) return;
    expect(r.remediation.map((x) => [x.check, x.code, x.field])).toEqual([
      ["draft_sections_resolved", "DRAFT_SECTION_UNRESOLVED", "interventions"],
      ["draft_sections_resolved", "DRAFT_SECTION_STALE", "plan"],
    ]);
    expect(r.remediation.every((x) => x.message.length > 20)).toBe(true);
  });

  it("is reported beside the other failures, not instead of them", () => {
    const r = runEncounterComplianceGate({
      ...base,
      sections: [],
      draftSectionActions: [{ sectionId: "plan", reason: "unresolved" }],
    });
    expect(r.pass).toBe(false);
    if (r.pass) return;
    const checks = new Set(r.remediation.map((x) => x.check));
    expect(checks).toEqual(new Set(["required_sections", "draft_sections_resolved"]));
  });
});

describe("§2.6 Layer-3 gate — check 1 counts a confirmed drafted section as populated (ADR-0114, owner-confirmed 2026-11-19)", () => {
  const REQUIRED = ["assessment", "chief_concern", "plan", "vitals_review"] as const;
  const base = {
    encounterType: "routine_visit",
    discipline: "rn",
    sections: [],
    carePlanOverdue: null,
    vitalsCaptured: ALL_VITALS_CAPTURED,
    vitalsClinicallyNotIndicated: NO_CNI,
    scalesPresent: NO_SCALES_PRESENT,
  } as const;
  const missingOf = (r: ReturnType<typeof runEncounterComplianceGate>) =>
    r.pass ? [] : r.remediation.filter((x) => x.check === "required_sections").map((x) => x.field);

  it("is unchanged when the draft is off: the fact is absent and every required section is still demanded", () => {
    expect(missingOf(runEncounterComplianceGate(base)).sort()).toEqual([...REQUIRED].sort());
  });

  it("a section the clinician confirmed drafted text for (the care-plan goals of `plan`) satisfies its required section, with no selection of their own", () => {
    const r = runEncounterComplianceGate({
      ...base,
      sections: documented("routine_visit", "rn").filter((s) => s.sectionId !== "plan"),
      draftConfirmedSectionIds: new Set(["plan"]),
    });
    expect(r).toEqual({ pass: true });
  });

  it("only the named sections are covered: another required section with nothing in it is still missing", () => {
    const r = runEncounterComplianceGate({
      ...base,
      draftConfirmedSectionIds: new Set(["plan"]),
    });
    expect(missingOf(r).sort()).toEqual(REQUIRED.filter((id) => id !== "plan").sort());
  });

  it("an empty set changes nothing (a draft that confirmed nothing)", () => {
    const r = runEncounterComplianceGate({ ...base, draftConfirmedSectionIds: new Set() });
    expect(missingOf(r).sort()).toEqual([...REQUIRED].sort());
  });

  it("keeps the per-check result shape: the remediation entries are what they were", () => {
    const r = runEncounterComplianceGate({
      ...base,
      draftConfirmedSectionIds: new Set(["plan"]),
    });
    expect(r.pass).toBe(false);
    if (r.pass) return;
    for (const entry of r.remediation) {
      expect(Object.keys(entry).sort()).toEqual(["check", "code", "field", "message"]);
      expect(entry.code).toBe("MISSING_SECTION");
    }
  });
});
