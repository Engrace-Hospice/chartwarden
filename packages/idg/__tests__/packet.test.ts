// @wardenx/idg — §2.4 D1 packet builder + W-PKT-02 freeze + W-SUD-01 SUD redaction — M14-T04.
import { describe, expect, it } from "vitest";
import {
  type BuiltPacket,
  PACKET_SCHEMA_VERSION,
  type PacketBuildInput,
  applySudRedaction,
  assertPacketWritable,
  buildPacketSnapshot,
  resolveSinceCursor,
} from "../src/packet";

const CURSOR = "2026-06-01T00:00:00.000Z";
const BUILT_AT = "2026-06-16T09:00:00.000Z";
const ACTIVATED = "2026-05-01T00:00:00.000Z";

function input(overrides: Partial<PacketBuildInput> = {}): PacketBuildInput {
  return {
    context: {
      meetingId: "mtg-1",
      patientId: "pat-1",
      admissionId: "adm-1",
      locationId: "loc-1",
      builtAt: BUILT_AT,
      builderJobId: "job-1",
      priorIdgAdjournedAt: CURSOR,
      admissionActivatedAt: ACTIVATED,
      ...overrides.context,
    },
    cover: {
      firstName: "Jane",
      lastInitial: "D",
      age: 71,
      primaryDiagnosisIcd10: "C34.90",
      primaryDiagnosisLabel: "Malignant neoplasm of lung",
      levelOfCare: "routine",
      nextRecertDueAt: null,
      f2fWindowState: "not_due",
      activeDpoa: null,
      activeSudFlag: false,
      ...overrides.cover,
    },
    sinceLastIdg: {
      encounters: [],
      significantAssessmentChanges: [],
      j2051Triggers: [],
      ordersChanged: [],
      medicationsChanged: [],
      flaggedEvents: [],
      ...overrides.sinceLastIdg,
    },
    carePlanSummary: {
      activeProblemCount: 3,
      activeGoalCount: 5,
      activeInterventionCount: 8,
      lastSignedVersionId: "cpv-1",
      lastSignedAt: "2026-06-02T00:00:00.000Z",
      nextReviewDueAt: "2026-06-17T00:00:00.000Z",
      isReviewOverdue: false,
      ...overrides.carePlanSummary,
    },
    hopeContext: overrides.hopeContext ?? null,
    carryForwardActionItems: overrides.carryForwardActionItems ?? [],
  };
}

describe("§1.1 since-cursor resolution", () => {
  it("uses the prior IDG adjournment when one exists (prior_idg)", () => {
    expect(resolveSinceCursor(CURSOR, ACTIVATED)).toEqual({
      sinceCursorIso: CURSOR,
      sinceContext: "prior_idg",
    });
  });

  it("falls back to admission activated_at for the first IDG (first_idg)", () => {
    expect(resolveSinceCursor(null, ACTIVATED)).toEqual({
      sinceCursorIso: ACTIVATED,
      sinceContext: "first_idg",
    });
  });
});

describe("W-PKT-02 freeze guard", () => {
  it("permits a rebuild of a pre-meeting (unfrozen) packet", () => {
    expect(() => assertPacketWritable({ frozenAt: null })).not.toThrow();
  });

  it("refuses a rebuild of a frozen packet (422 PACKET_FROZEN)", () => {
    expect(() => assertPacketWritable({ frozenAt: BUILT_AT })).toThrowError(
      expect.objectContaining({ code: "PACKET_FROZEN", statusCode: 422 }),
    );
  });
});

describe("§2.4 D1 packet build", () => {
  it("stamps the schema version, cover, cursor, and full (unredacted) build flag", () => {
    const { snapshot } = buildPacketSnapshot(input());
    expect(snapshot.schemaVersion).toBe(PACKET_SCHEMA_VERSION);
    expect(snapshot.meta.sinceContext).toBe("prior_idg");
    expect(snapshot.meta.appliedSudRedaction).toBe(false);
    expect(snapshot.patientCover.fullNameRedacted).toBe("Jane D.");
    expect(snapshot.patientCover.daysOnService).toBe(46); // 2026-05-01 → 2026-06-16
    expect(snapshot.capProjection).toBeNull(); // M26 deny-stub
  });

  it("filters every since-block strictly after the cursor", () => {
    const { snapshot } = buildPacketSnapshot(
      input({
        sinceLastIdg: {
          encounters: [
            {
              encounterId: "enc-old",
              encounterType: "rn_visit",
              signedAt: "2026-05-20T00:00:00.000Z",
              authorDiscipline: "rn",
            },
            {
              encounterId: "enc-new",
              encounterType: "rn_visit",
              signedAt: "2026-06-10T00:00:00.000Z",
              authorDiscipline: "rn",
            },
          ],
          significantAssessmentChanges: [],
          j2051Triggers: [],
          ordersChanged: [],
          medicationsChanged: [],
          flaggedEvents: [],
        },
      }),
    );
    expect(snapshot.sinceLastIdg.encounters.map((e) => e.encounterId)).toEqual(["enc-new"]);
  });

  it("derives per-discipline views filtered by DISCIPLINE_VIEW_POLICY emphasis", () => {
    const { disciplineViews } = buildPacketSnapshot(
      input({
        sinceLastIdg: {
          encounters: [
            {
              encounterId: "enc-1",
              encounterType: "rn_visit",
              signedAt: "2026-06-10T00:00:00.000Z",
              authorDiscipline: "rn",
            },
          ],
          significantAssessmentChanges: [],
          j2051Triggers: [],
          ordersChanged: [],
          medicationsChanged: [
            {
              medicationOrderId: "mo-1",
              drugLabel: "morphine",
              changeKind: "add",
              changedAt: "2026-06-11T00:00:00.000Z",
            },
          ],
          flaggedEvents: [],
        },
      }),
    );
    // RN view emphasises medication; aide view does not.
    expect(disciplineViews.rn.highlightedEntries.some((e) => e.sourceKind === "medication")).toBe(
      true,
    );
    expect(disciplineViews.aide.highlightedEntries.some((e) => e.sourceKind === "medication")).toBe(
      false,
    );
    // Encounters appear in every view (all emphases include "encounter").
    expect(disciplineViews.aide.highlightedEntries.some((e) => e.sourceKind === "encounter")).toBe(
      true,
    );
    expect(disciplineViews.rn.layer2Polished).toBeNull(); // BASIC build
  });

  it("derives the deterministic Layer-1 discussion flags", () => {
    const { snapshot } = buildPacketSnapshot(
      input({
        cover: {
          ...input().cover,
          activeSudFlag: true,
          nextRecertDueAt: "2026-06-30T00:00:00.000Z",
        },
        sinceLastIdg: {
          encounters: [],
          significantAssessmentChanges: [
            {
              assessmentId: "a-1",
              scaleKind: "PPS",
              changeKind: "decline",
              occurredAt: "2026-06-10T00:00:00.000Z",
            },
          ],
          j2051Triggers: [],
          ordersChanged: [],
          medicationsChanged: [],
          flaggedEvents: [
            {
              kind: "hospitalisation",
              sourceId: "f-1",
              occurredAt: "2026-06-09T00:00:00.000Z",
              severity: "urgent",
            },
          ],
        },
      }),
    );
    const kinds = snapshot.flagsForDiscussion.map((f) => f.kind);
    expect(kinds).toContain("recert_due"); // within 30 days
    expect(kinds).toContain("level_of_care_candidate"); // hospitalisation
    expect(kinds).toContain("complex_symptoms"); // significant change
    expect(kinds).toContain("sud_pattern_review"); // active SUD flag
  });

  // F-218 (#248) — an after-hours triage call that proposed a GIP admission is a level-of-care candidate,
  // and it shares ONE flag with a hospitalisation/ER event rather than emitting a second flag of the kind.
  it("flags a triage-proposed GIP admission as a level-of-care candidate (one flag, combined detail)", () => {
    const flaggedOnly = (kinds: string[]) =>
      buildPacketSnapshot(
        input({
          sinceLastIdg: {
            ...input().sinceLastIdg,
            flaggedEvents: kinds.map((kind, i) => ({
              kind: kind as never,
              sourceId: `f-${i}`,
              occurredAt: "2026-06-09T00:00:00.000Z",
              severity: "attention" as const,
            })),
          },
        }),
      ).snapshot.flagsForDiscussion.filter((f) => f.kind === "level_of_care_candidate");
    const triage = flaggedOnly(["triage_care_plan_change"]);
    expect(triage).toHaveLength(1);
    expect(triage[0]?.detail).toMatch(/GIP admission/);
    const both = flaggedOnly(["hospitalisation", "triage_care_plan_change"]);
    expect(both).toHaveLength(1);
    expect(both[0]?.detail).toMatch(/hospitalisation.*GIP admission/);
    expect(flaggedOnly(["fall"])).toHaveLength(0);
  });

  it("carries the M26 cap projection as null and surfaces carry-forward items", () => {
    const { snapshot, disciplineViews } = buildPacketSnapshot(
      input({
        carryForwardActionItems: [
          {
            actionItemId: "ai-1",
            assignedToMembershipId: "mem-1",
            dueDate: "2026-06-05T00:00:00.000Z",
            carryForwardCount: 3,
          },
        ],
      }),
    );
    expect(snapshot.carryForwardActionItems).toHaveLength(1);
    // MSW view emphasises action items; a 3× carry-forward is urgent.
    const mswItem = disciplineViews.msw.highlightedEntries.find(
      (e) => e.sourceKind === "action_item",
    );
    expect(mswItem?.severity).toBe("urgent");
  });
});

describe("W-SUD-01 SUD redaction at read", () => {
  function builtWithSud(): BuiltPacket {
    return buildPacketSnapshot(
      input({
        cover: { ...input().cover, activeSudFlag: true },
        sinceLastIdg: {
          encounters: [
            {
              encounterId: "enc-sud",
              encounterType: "sud_counsel",
              signedAt: "2026-06-10T00:00:00.000Z",
              authorDiscipline: "msw",
            },
            {
              encounterId: "enc-ok",
              encounterType: "rn_visit",
              signedAt: "2026-06-11T00:00:00.000Z",
              authorDiscipline: "rn",
            },
          ],
          significantAssessmentChanges: [],
          j2051Triggers: [],
          ordersChanged: [],
          medicationsChanged: [],
          flaggedEvents: [],
        },
      }),
    );
  }

  it("returns the full packet unchanged for a caller WITH a Part 2 release", () => {
    const built = builtWithSud();
    const out = applySudRedaction(built, {
      hasPart2Release: true,
      sudFlaggedSourceIds: new Set(["enc-sud"]),
    });
    expect(out).toBe(built); // identity — no redaction
    expect(out.snapshot.meta.appliedSudRedaction).toBe(false);
  });

  it("elides SUD-flagged encounters + highlights for a caller WITHOUT a release and sets the banner flag", () => {
    const out = applySudRedaction(builtWithSud(), {
      hasPart2Release: false,
      sudFlaggedSourceIds: new Set(["enc-sud"]),
    });
    expect(out.snapshot.meta.appliedSudRedaction).toBe(true);
    expect(out.snapshot.sinceLastIdg.encounters.map((e) => e.encounterId)).toEqual(["enc-ok"]);
    expect(out.disciplineViews.rn.highlightedEntries.some((e) => e.sourceId === "enc-sud")).toBe(
      false,
    );
    // The cover banner signal (activeSudFlag) is preserved — it is non-PHI.
    expect(out.snapshot.patientCover.activeSudFlag).toBe(true);
  });

  it("elides a SUD-flagged source from EVERY since-block, not only encounters + highlights", () => {
    const built = buildPacketSnapshot(
      input({
        cover: { ...input().cover, activeSudFlag: true },
        sinceLastIdg: {
          encounters: [],
          significantAssessmentChanges: [
            {
              assessmentId: "a-sud",
              scaleKind: "pain",
              changeKind: "worsened",
              occurredAt: "2026-06-10T00:00:00.000Z",
            },
            {
              assessmentId: "a-ok",
              scaleKind: "pain",
              changeKind: "improved",
              occurredAt: "2026-06-11T00:00:00.000Z",
            },
          ],
          j2051Triggers: [
            {
              hopeAssessmentId: "h-sud",
              triggerKind: "symptom_impact",
              firedAt: "2026-06-10T00:00:00.000Z",
            },
          ],
          ordersChanged: [
            {
              orderId: "o-sud",
              orderKind: "lab",
              changeKind: "signed",
              changedAt: "2026-06-10T00:00:00.000Z",
            },
          ],
          medicationsChanged: [
            {
              medicationOrderId: "m-sud",
              drugLabel: "x",
              changeKind: "started",
              changedAt: "2026-06-10T00:00:00.000Z",
            },
          ],
          flaggedEvents: [
            {
              kind: "fall",
              sourceId: "f-sud",
              occurredAt: "2026-06-10T00:00:00.000Z",
              severity: "attention",
            },
          ],
        },
      }),
    );
    const out = applySudRedaction(built, {
      hasPart2Release: false,
      sudFlaggedSourceIds: new Set(["a-sud", "h-sud", "o-sud", "m-sud", "f-sud"]),
    });
    const s = out.snapshot.sinceLastIdg;
    expect(s.significantAssessmentChanges.map((a) => a.assessmentId)).toEqual(["a-ok"]);
    expect(s.j2051Triggers).toEqual([]);
    expect(s.ordersChanged).toEqual([]);
    expect(s.medicationsChanged).toEqual([]);
    expect(s.flaggedEvents).toEqual([]);
  });
});
