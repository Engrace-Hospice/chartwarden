/**
 * M14 packet-build worker — the three sections no worker used to build: `sinceLastIdg.flaggedEvents`
 * (M6/M13/M30 sources), `hopeContext` (M10) and `carryForwardActionItems` (M14's own table). Fake ports here;
 * the real seams + RLS are proven live in m14-packet-build.live.test.ts. Fail-honest throughout: an unbound /
 * throwing / malformed source contributes nothing, never a guess, never a thrown error.
 */
import { applySudRedaction, buildPacketSnapshot } from "@chartwarden/idg";
import { describe, expect, it, vi } from "vitest";
import { projectHospitalEvent } from "../src/modules/06-admission/seams/idg-hospital-events-for-org";
import { missedDoseSeverity } from "../src/modules/13-emar/seams/idg-missed-doses-for-org";
import {
  type IdgFlaggedEventSourcePort,
  resolveFlaggedEvents,
  resolveHopeContext,
} from "../src/modules/14-idg/jobs/packet-build";
import { fallSeverity } from "../src/modules/30-quality/idg-flagged-events-for-org";

const SINCE = "2026-09-01T00:00:00.000Z";
const src = (
  source: string,
  m: Map<string, { kind: string; sourceId: string; occurredAt: string; severity: string }[]>,
): IdgFlaggedEventSourcePort => ({ source, flaggedEventsForOrg: async () => m });

describe("resolveFlaggedEvents", () => {
  // F-218 (#248) — the fourth source: M19's triage GIP-proposal read, kind `triage_care_plan_change`.
  it("accepts the M19 triage_care_plan_change kind and keeps its back-reference", async () => {
    const out = await resolveFlaggedEvents(
      [
        src(
          "m19.triage_care_plan_change",
          new Map([
            [
              "p1",
              [
                {
                  kind: "triage_care_plan_change",
                  sourceId: "call-1",
                  occurredAt: "2026-09-12T00:00:00Z",
                  severity: "attention",
                },
              ],
            ],
          ]),
        ),
      ],
      "org",
      ["p1"],
      SINCE,
      vi.fn(),
    );
    expect(out.get("p1")).toEqual([
      {
        kind: "triage_care_plan_change",
        sourceId: "call-1",
        occurredAt: "2026-09-12T00:00:00.000Z",
        severity: "attention",
      },
    ]);
  });

  it("merges every source, validates, de-duplicates and orders oldest to newest", async () => {
    const warn = vi.fn();
    const out = await resolveFlaggedEvents(
      [
        src(
          "m6",
          new Map([
            [
              "p1",
              [
                {
                  kind: "hospitalisation",
                  sourceId: "w1",
                  occurredAt: "2026-09-10T00:00:00Z",
                  severity: "urgent",
                },
                {
                  kind: "hospitalisation",
                  sourceId: "w1",
                  occurredAt: "2026-09-10T00:00:00Z",
                  severity: "urgent",
                },
              ],
            ],
          ]),
        ),
        src(
          "m13",
          new Map([
            [
              "p1",
              [
                {
                  kind: "missed_dose",
                  sourceId: "d1",
                  occurredAt: "2026-09-05T00:00:00Z",
                  severity: "attention",
                },
              ],
            ],
            // malformed rows are dropped, not passed through
            [
              "p2",
              [
                {
                  kind: "teleport",
                  sourceId: "x",
                  occurredAt: "2026-09-05T00:00:00Z",
                  severity: "info",
                },
              ],
            ],
            ["p3", [{ kind: "fall", sourceId: "f", occurredAt: "not-a-date", severity: "info" }]],
            [
              "p4",
              [
                {
                  kind: "fall",
                  sourceId: "f",
                  occurredAt: "2026-09-05T00:00:00Z",
                  severity: "dire",
                },
              ],
            ],
          ]),
        ),
      ],
      "org",
      ["p1", "p2", "p3", "p4"],
      SINCE,
      warn,
    );
    expect(out.get("p1")?.map((e) => e.sourceId)).toEqual(["d1", "w1"]);
    expect(out.get("p1")?.[1]).toEqual({
      kind: "hospitalisation",
      sourceId: "w1",
      occurredAt: "2026-09-10T00:00:00.000Z",
      severity: "urgent",
    });
    expect(out.has("p2")).toBe(false);
    expect(out.has("p3")).toBe(false);
    expect(out.has("p4")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("isolates a failing source: it is warned about and the others still contribute", async () => {
    const warn = vi.fn();
    const out = await resolveFlaggedEvents(
      [
        {
          source: "m30",
          flaggedEventsForOrg: async () => {
            throw new Error("db down");
          },
        },
        src(
          "m13",
          new Map([
            [
              "p1",
              [
                {
                  kind: "missed_dose",
                  sourceId: "d1",
                  occurredAt: "2026-09-05T00:00:00Z",
                  severity: "info",
                },
              ],
            ],
          ]),
        ),
      ],
      "org",
      ["p1"],
      SINCE,
      warn,
    );
    expect(out.get("p1")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      "m14.packet_build.flagged_events_unavailable",
      expect.objectContaining({ source: "m30", error: "db down" }),
    );
  });

  it("no sources / no patients ⇒ empty, and a source is never called with no patients", async () => {
    const spy = vi.fn(async () => new Map());
    expect((await resolveFlaggedEvents(undefined, "o", ["p"], SINCE, vi.fn())).size).toBe(0);
    expect((await resolveFlaggedEvents([], "o", ["p"], SINCE, vi.fn())).size).toBe(0);
    await resolveFlaggedEvents(
      [{ source: "s", flaggedEventsForOrg: spy }],
      "o",
      [],
      SINCE,
      vi.fn(),
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("resolveHopeContext", () => {
  it("passes a valid context through and drops malformed timepoints", async () => {
    const out = await resolveHopeContext(
      {
        hopeContextForOrg: async () =>
          new Map([
            [
              "p1",
              {
                upcomingTimepoints: [
                  { timepoint: "02_huv1", dueAt: "2026-10-01T00:00:00Z" },
                  { timepoint: "", dueAt: "2026-10-01T00:00:00Z" },
                  { timepoint: "03_huv2", dueAt: "garbage" },
                ],
                openSfvCount: 2,
              },
            ],
            ["p2", { upcomingTimepoints: [], openSfvCount: -1 }],
          ]),
      },
      "org",
      ["p1", "p2"],
      vi.fn(),
    );
    expect(out.get("p1")).toEqual({
      upcomingTimepoints: [{ timepoint: "02_huv1", dueAt: "2026-10-01T00:00:00.000Z" }],
      openSfvCount: 2,
    });
    expect(out.has("p2")).toBe(false); // an impossible count is "not captured", never coerced
  });

  it("an empty-but-successful context is kept (nothing due), an unbound port or a throw is absent (not captured)", async () => {
    const empty = await resolveHopeContext(
      {
        hopeContextForOrg: async () =>
          new Map([["p1", { upcomingTimepoints: [], openSfvCount: 0 }]]),
      },
      "org",
      ["p1"],
      vi.fn(),
    );
    expect(empty.get("p1")).toEqual({ upcomingTimepoints: [], openSfvCount: 0 });
    expect((await resolveHopeContext(undefined, "org", ["p1"], vi.fn())).size).toBe(0);
    const warn = vi.fn();
    const failed = await resolveHopeContext(
      {
        hopeContextForOrg: async () => {
          throw new Error("boom");
        },
      },
      "org",
      ["p1"],
      warn,
    );
    expect(failed.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "m14.packet_build.hope_context_unavailable",
      expect.objectContaining({ error: "boom" }),
    );
  });
});

describe("source-seam pure projections", () => {
  const win = (payload: unknown) => ({ id: "w", startsAt: "2026-09-20T00:00:00Z", payload });
  it("hospital windows: E ⇒ er_visit, I/absent ⇒ hospitalisation, other classes dropped; event time wins", () => {
    expect(
      projectHospitalEvent(win({ patientClass: "E", eventTimestamp: "2026-09-18T10:00:00Z" })),
    ).toEqual({
      kind: "er_visit",
      sourceId: "w",
      occurredAt: "2026-09-18T10:00:00.000Z",
      severity: "urgent",
    });
    expect(projectHospitalEvent(win({ patientClass: "i" }))?.kind).toBe("hospitalisation");
    expect(projectHospitalEvent(win({}))?.kind).toBe("hospitalisation");
    expect(projectHospitalEvent(win({}))?.occurredAt).toBe("2026-09-20T00:00:00.000Z"); // falls back to starts_at
    expect(projectHospitalEvent(win({ patientClass: "O" }))).toBeNull();
    expect(projectHospitalEvent(win(null))?.kind).toBe("hospitalisation");
  });
  it("missed-dose and fall severities are deterministic", () => {
    expect(missedDoseSeverity("detected_by_sweep", true)).toBe("urgent");
    expect(missedDoseSeverity("detected_by_sweep", false)).toBe("attention");
    expect(missedDoseSeverity("patient_refused", false)).toBe("attention");
    expect(missedDoseSeverity("intentionally_held", true)).toBe("info");
    expect(fallSeverity("minor")).toBe("info");
    expect(fallSeverity("moderate")).toBe("attention");
    expect(fallSeverity("severe")).toBe("urgent");
    expect(fallSeverity("critical")).toBe("urgent");
  });
});

describe("builder + W-SUD-01 with the newly populated sections", () => {
  const built = () =>
    buildPacketSnapshot({
      context: {
        meetingId: "m" as never,
        patientId: "p" as never,
        admissionId: "a" as never,
        locationId: "l" as never,
        builtAt: "2026-09-29T00:00:00.000Z",
        builderJobId: "j",
        priorIdgAdjournedAt: "2026-09-15T00:00:00.000Z",
        admissionActivatedAt: "2026-01-01T00:00:00.000Z",
      },
      cover: {
        firstName: "A",
        lastInitial: "B",
        age: 80,
        primaryDiagnosisIcd10: "C34.90",
        primaryDiagnosisLabel: "Lung",
        levelOfCare: "routine",
        nextRecertDueAt: null,
        f2fWindowState: null,
        activeDpoa: null,
        activeSudFlag: true,
      },
      sinceLastIdg: {
        encounters: [],
        significantAssessmentChanges: [],
        j2051Triggers: [],
        ordersChanged: [],
        medicationsChanged: [],
        flaggedEvents: [
          {
            kind: "er_visit",
            sourceId: "w-new",
            occurredAt: "2026-09-20T00:00:00.000Z",
            severity: "urgent",
          },
          {
            kind: "fall",
            sourceId: "f-old",
            occurredAt: "2026-09-01T00:00:00.000Z",
            severity: "info",
          }, // before cursor
        ],
      },
      carePlanSummary: {
        activeProblemCount: 1,
        activeGoalCount: 1,
        activeInterventionCount: 1,
        lastSignedVersionId: "v",
        lastSignedAt: "2026-09-01T00:00:00.000Z",
        nextReviewDueAt: "2026-10-01T00:00:00.000Z",
        isReviewOverdue: false,
      },
      hopeContext: {
        upcomingTimepoints: [{ timepoint: "02_huv1", dueAt: "2026-10-01T00:00:00.000Z" }],
        openSfvCount: 3,
      },
      carryForwardActionItems: [
        {
          actionItemId: "ai-1" as never,
          assignedToMembershipId: "mem" as never,
          dueDate: "2026-09-10T00:00:00.000Z",
          carryForwardCount: 2,
        },
      ],
    });

  it("applies the cursor to flagged events, derives the LOC-candidate flag, and highlights carry-forward", () => {
    const { snapshot, disciplineViews } = built();
    expect(snapshot.sinceLastIdg.flaggedEvents.map((f) => f.sourceId)).toEqual(["w-new"]);
    expect(snapshot.flagsForDiscussion.map((f) => f.kind)).toContain("level_of_care_candidate");
    expect(snapshot.hopeContext?.openSfvCount).toBe(3);
    expect(snapshot.carryForwardActionItems).toHaveLength(1);
    expect(disciplineViews.msw.highlightedEntries.some((e) => e.sourceKind === "action_item")).toBe(
      true,
    );
  });

  it("without a Part 2 release: flagged event, carry-forward and the derived SFV count are elided; timepoints stay", () => {
    const out = applySudRedaction(built(), {
      hasPart2Release: false,
      sudFlaggedSourceIds: new Set(["w-new", "ai-1"]),
    });
    expect(out.snapshot.sinceLastIdg.flaggedEvents).toEqual([]);
    expect(out.snapshot.carryForwardActionItems).toEqual([]);
    expect(out.snapshot.hopeContext).toEqual({
      upcomingTimepoints: [{ timepoint: "02_huv1", dueAt: "2026-10-01T00:00:00.000Z" }],
      openSfvCount: 0,
    });
  });

  it("with a release the packet is untouched", () => {
    const b = built();
    expect(
      applySudRedaction(b, { hasPart2Release: true, sudFlaggedSourceIds: new Set(["ai-1"]) }),
    ).toBe(b);
  });
});
