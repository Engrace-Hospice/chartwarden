// apps/backend/__tests__/oncall-seams.test.ts — M19-T06 (§4.3 the five seams M19 PUBLISHES, plus the two
// ADVISORY M32 seams M19 consumes).
//
// The properties guarded here are the ones the providers exist to preserve:
//   • all five are boot-REQUIRED with a fail-closed deny-stub, and `OnCallProvider`'s deny-stub THROWS —
//     the difference between M36 taking its degraded alert path and M36 silently routing a 2 a.m.
//     escalation to an empty recipient list that looks exactly like a real coverage gap;
//   • the two M32 advisory stubs are the platform's only NON-throwing ones, and answer `unavailable` as a
//     VALUE distinct from "the model had no suggestion" (§8.6 / D11 / D12);
//   • a vendor-covered shift produces an actor with NO user id at all (the discriminated `OnCallActor`),
//     and a membership whose user id will not resolve is DROPPED rather than published unpageable;
//   • `currentOnCallActors` includes a `scheduled` shift whose window has already begun (§2.2.2's open
//     transition is a cron tick), while `activeShiftsAt` — M36's channel re-sync read — does not;
//   • the metrics rate methods are literally their `*Counts` siblings divided, so a M33 tile and a
//     CMS-reportable measure can never disagree about the population;
//   • coverage gap is PER ProviderEntity and SUMMED, so one covered PE cannot mask another's dark night;
//   • the portal projection renders lay prose, never the disposition enum, and carries no risk band /
//     escalation tier / vendor detail at all;
//   • the `orgId` seam argument is an ASSERTION against the caller's scope, never a row selector.
import type {
  IsoInstant,
  OnCallShiftDto,
  OrgId,
  PatientId,
  ProviderEntityId,
  TriageCallId,
  TriageMetricsWindow,
} from "@wardenx/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  REQUIRED_SEAMS,
  __resetSeamsForTest,
  getSeam,
  validateSeams,
} from "../src/bootstrap/index";
import {
  PORTAL_DISPOSITION_LAY_SUMMARY,
  PORTAL_IN_PROGRESS_LAY_SUMMARY,
  coverageGapMinutesOf,
  createInMemoryOncallSeamStore,
  createOnCallProvider,
  createPortalTriageReader,
  createTriageCallMetricsProvider,
  createTriageCallProvider,
  createTriageCallReader,
  getHospitalizationRiskProvider,
  getOnCallProvider,
  getPortalTriageReader,
  getProtocolSuggestionProvider,
  getTriageCallMetricsProvider,
  getTriageCallProvider,
  getTriageCallReader,
  percentileOf,
  portalSummaryOf,
  registerOncallSeams,
} from "../src/modules/19-oncall/index";

const ORG = "org-1" as OrgId;
const PE = "pe-1" as ProviderEntityId;
const PE2 = "pe-2" as ProviderEntityId;
const PATIENT = "pat-1" as PatientId;
const NOW = "2026-07-31T23:00:00.000Z" as IsoInstant;
const orgOf = () => ORG;

const shift = (over: Partial<OnCallShiftDto> = {}): OnCallShiftDto => ({
  shiftId: "shift-1",
  providerEntityId: PE,
  discipline: "clinical_rn",
  status: "active",
  shiftStartsAt: "2026-07-31T22:00:00.000Z" as IsoInstant,
  shiftEndsAt: "2026-08-01T06:00:00.000Z" as IsoInstant,
  primaryOnCallMembershipId: "mem-1",
  backupMembershipId: null,
  externalActorId: null,
  externalActorLabel: null,
  openedAt: "2026-07-31T22:00:00.000Z" as IsoInstant,
  closedAt: null,
  ...over,
});

const window: TriageMetricsWindow = {
  from: "2026-07-01T00:00:00.000Z" as IsoInstant,
  to: "2026-08-01T00:00:00.000Z" as IsoInstant,
};

afterEach(() => {
  __resetSeamsForTest();
});

describe("M19 §4.3 — registry wiring", () => {
  it("declares all five published seams, plus the WP 4.3 EscalationRouter, as boot-required with a deny-stub, owned by M19", () => {
    const m19 = REQUIRED_SEAMS.filter((s) => s.ownerModule === 19);
    expect(m19.map((s) => s.key).sort()).toEqual([
      "EscalationRouter",
      "OnCallProvider",
      "PortalTriageReader",
      "TriageCallMetricsProvider",
      "TriageCallProvider",
      "TriageCallReader",
    ]);
    for (const seam of m19) expect(seam.denyStub).toBeDefined();
  });

  it("classifies the patient-scoped reads as PHI and the aggregate/staffing reads as not", () => {
    const phiOf = (key: string) => REQUIRED_SEAMS.find((s) => s.key === key)?.phi;
    // A shift row is staffing evidence; a metrics window is an aggregate. Neither names a patient.
    expect(phiOf("OnCallProvider")).toBe(false);
    expect(phiOf("TriageCallMetricsProvider")).toBe(false);
    // `recentCallsForPatient` NAMES a patient — a "features only" DTO does not de-identify the REQUEST.
    expect(phiOf("TriageCallReader")).toBe(true);
    expect(phiOf("TriageCallProvider")).toBe(true);
    expect(phiOf("PortalTriageReader")).toBe(true);
  });

  it("stands throwing deny-stubs for all five when M19 does not register", () => {
    validateSeams();
    expect(() => getOnCallProvider().currentOnCallActors(ORG, PE, NOW)).toThrow(/OnCallProvider/);
    expect(() => getTriageCallReader().recentCallsForPatient(ORG, PATIENT, NOW)).toThrow(
      /TriageCallReader/,
    );
    expect(() => getTriageCallProvider().callForPacket(ORG, "call-1" as TriageCallId)).toThrow(
      /TriageCallProvider/,
    );
    expect(() => getPortalTriageReader().summaryForPatient(ORG, PATIENT, 24)).toThrow(
      /PortalTriageReader/,
    );
    expect(() => getTriageCallMetricsProvider().getCoverageGapMinutes(ORG, window)).toThrow(
      /TriageCallMetricsProvider/,
    );
  });

  it("registers nothing without a store, so a DB-less boot cannot manufacture a coverage gap", () => {
    registerOncallSeams();
    validateSeams();
    // The deny-stub is still what stands — an EMPTY actor list would read to M36 as "nobody is on call".
    expect(() => getOnCallProvider().currentOnCallActors(ORG, PE, NOW)).toThrow(/OnCallProvider/);
  });

  it("registers all five real impls over the deny-stubs when a store is injected", async () => {
    const { store } = createInMemoryOncallSeamStore({ shifts: [shift()] });
    registerOncallSeams({ store, orgOf });
    validateSeams();
    await expect(getOnCallProvider().activeShiftsAt(ORG, NOW)).resolves.toHaveLength(1);
    await expect(getTriageCallReader().recentCallsForPatient(ORG, PATIENT, NOW)).resolves.toEqual(
      [],
    );
  });
});

describe("M32 §8.6 — the two ADVISORY seams (D11 / D12)", () => {
  it("owns them at M32 and declares them PHI-bearing", () => {
    // M32-T06 published the rest of §4.2, so M32 now owns more than these two. What this test still
    // guards is the part M19 depends on: each of these names appears EXACTLY ONCE and is owned by M32.
    // A second entry under a second name is the M15/M17 `VolunteerComplianceProvider` failure — two
    // interfaces for one seam, one of them permanently unbound. The full M32-owned set is asserted in
    // `ai-platform-seams.test.ts`, which is where it belongs.
    for (const key of ["HospitalizationRiskProvider", "ProtocolSuggestionProvider"] as const) {
      const entries = REQUIRED_SEAMS.filter((s) => s.key === key);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.ownerModule).toBe(32);
      expect(entries[0]?.phi).toBe(true);
    }
  });

  it("answers `unavailable` instead of throwing — an advisory must not fail the intake path", async () => {
    validateSeams();
    await expect(
      getProtocolSuggestionProvider().suggestProtocol(ORG, {
        triageCallId: "call-1" as TriageCallId,
        patientId: PATIENT,
        chiefComplaintText: "she is restless and confused",
        candidateProtocolKeys: ["terminal_restlessness"],
      }),
    ).resolves.toEqual({ kind: "unavailable", reason: "provider_unregistered" });
    await expect(
      getHospitalizationRiskProvider().hospitalizationRiskForPatient(ORG, PATIENT, NOW),
    ).resolves.toEqual({ kind: "unavailable", reason: "provider_unregistered" });
  });
});

describe("OnCallProvider — §4.3 / §4.5", () => {
  it("projects a vendor shift onto an actor that carries NO user id, by construction", async () => {
    const { store } = createInMemoryOncallSeamStore({
      shifts: [
        shift({
          shiftId: "shift-vendor",
          discipline: "external",
          primaryOnCallMembershipId: null,
          externalActorId: "vendor-9",
          externalActorLabel: "TouchPoint night desk",
        }),
      ],
    });
    const [actor] = await createOnCallProvider(store, orgOf).currentOnCallActors(ORG, PE, NOW);
    expect(actor).toEqual({
      kind: "external_vendor",
      shiftId: "shift-vendor",
      externalActorId: "vendor-9",
      externalActorLabel: "TouchPoint night desk",
      discipline: "external",
      shiftStartsAt: "2026-07-31T22:00:00.000Z",
      shiftEndsAt: "2026-08-01T06:00:00.000Z",
    });
    expect(actor && "userId" in actor).toBe(false);
  });

  it("marks the backup as backup, so M36 pages the primary first rather than both as equals", async () => {
    const { store } = createInMemoryOncallSeamStore({
      shifts: [shift({ backupMembershipId: "mem-2" })],
      membershipUserIds: { "mem-1": "user-1", "mem-2": "user-2" },
    });
    const actors = await createOnCallProvider(store, orgOf).currentOnCallActors(ORG, PE, NOW);
    expect(actors.map((a) => (a.kind === "membership" ? [a.userId, a.isBackup] : null))).toEqual([
      ["user-1", false],
      ["user-2", true],
    ]);
  });

  it("DROPS a membership whose user id will not resolve rather than publishing an unpageable actor", async () => {
    const { store } = createInMemoryOncallSeamStore({
      shifts: [shift({ backupMembershipId: "mem-ghost" })],
      membershipUserIds: { "mem-1": "user-1" },
    });
    const actors = await createOnCallProvider(store, orgOf).currentOnCallActors(ORG, PE, NOW);
    // The shift then shows as partially uncovered — the truth — instead of naming somebody M36 cannot reach.
    expect(actors).toHaveLength(1);
    expect(actors[0]?.kind === "membership" && actors[0].userId).toBe("user-1");
  });

  it("includes a `scheduled` shift already in its window, but `activeShiftsAt` does not", async () => {
    const { store } = createInMemoryOncallSeamStore({
      shifts: [shift({ status: "scheduled", openedAt: null })],
      membershipUserIds: { "mem-1": "user-1" },
    });
    const provider = createOnCallProvider(store, orgOf);
    // §2.2.2's open transition is a cron tick; filtering to `active` would make every shift start a gap.
    await expect(provider.currentOnCallActors(ORG, PE, NOW)).resolves.toHaveLength(1);
    // M36's channel membership must follow the transition it is reacting to, so this one DOES filter.
    await expect(provider.activeShiftsAt(ORG, NOW)).resolves.toEqual([]);
  });

  it("refuses a call whose orgId disagrees with the caller's scope (the arg asserts, never selects)", async () => {
    const { store } = createInMemoryOncallSeamStore({ shifts: [shift()] });
    await expect(
      createOnCallProvider(store, orgOf).currentOnCallActors("org-other" as OrgId, PE, NOW),
    ).rejects.toMatchObject({ code: "TRIAGE_SEAM_ORG_MISMATCH" });
  });
});

describe("TriageCallReader / TriageCallProvider — §4.3", () => {
  it("answers null for an id that does not resolve in the caller's org (no cross-tenant probe)", async () => {
    const { store } = createInMemoryOncallSeamStore({});
    await expect(
      createTriageCallProvider(store, orgOf).callForPacket(ORG, "call-nope" as TriageCallId),
    ).resolves.toBeNull();
  });

  it("resolves M11's verbal order back to the call + shift it was taken on", async () => {
    const { store } = createInMemoryOncallSeamStore({
      verbalOrderContexts: {
        "order-7": { triageCallId: "call-1" as TriageCallId, onCallShiftId: "shift-1" },
      },
    });
    const provider = createTriageCallProvider(store, orgOf);
    await expect(provider.triageContextForVerbalOrder(ORG, "order-7")).resolves.toEqual({
      triageCallId: "call-1",
      onCallShiftId: "shift-1",
    });
    // An order NOT taken during a call is a real answer, not an error — M11 has plenty of those.
    await expect(provider.triageContextForVerbalOrder(ORG, "order-day-shift")).resolves.toBeNull();
  });

  it("asserts the caller's org on the feature read too", async () => {
    const { store } = createInMemoryOncallSeamStore({});
    await expect(
      createTriageCallReader(store, orgOf).recentCallsForPatient(
        "org-other" as OrgId,
        PATIENT,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "TRIAGE_SEAM_ORG_MISMATCH" });
  });
});

describe("PortalTriageReader — §4.3 / §5.3 lay-language oracle", () => {
  it("renders lay prose and never the disposition enum", () => {
    const summary = portalSummaryOf({
      triageCallId: "call-1" as TriageCallId,
      occurredAt: NOW,
      callerKind: "caregiver",
      callerRelationshipLabel: "daughter",
      disposition: "ed_transfer_acknowledged",
    });
    expect(summary.dispositionSummaryLay).toBe(
      PORTAL_DISPOSITION_LAY_SUMMARY.ed_transfer_acknowledged,
    );
    expect(summary.dispositionSummaryLay).not.toContain("ed_transfer");
    // D11 / D13 / §5.3 — no risk band, no escalation tier, no vendor-handoff detail, no clinician text.
    expect(Object.keys(summary).sort()).toEqual([
      "callerKind",
      "callerRelationshipLabel",
      "dispositionSummaryLay",
      "occurredAt",
      "triageCallId",
      "visitDispatched",
      "visitScheduledFirstLight",
    ]);
  });

  it("keeps an undispositioned call visible rather than dropping it from the care log", () => {
    const summary = portalSummaryOf({
      triageCallId: "call-2" as TriageCallId,
      occurredAt: NOW,
      callerKind: "patient",
      callerRelationshipLabel: null,
      disposition: null,
    });
    expect(summary.dispositionSummaryLay).toBe(PORTAL_IN_PROGRESS_LAY_SUMMARY);
    expect(summary.visitDispatched).toBe(false);
  });

  it("has lay wording for every disposition the enum can hold", () => {
    for (const text of Object.values(PORTAL_DISPOSITION_LAY_SUMMARY)) {
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/_/); // an enum member leaking through would carry an underscore
    }
  });

  it("clamps an absurd look-back rather than letting a portal session widen its own window", async () => {
    const rows = {
      [PATIENT]: [
        {
          triageCallId: "call-1" as TriageCallId,
          occurredAt: "2026-07-31T22:00:00.000Z" as IsoInstant,
          callerKind: "caregiver" as const,
          callerRelationshipLabel: "daughter",
          disposition: "visit_dispatched_now" as const,
        },
      ],
    };
    const { store } = createInMemoryOncallSeamStore({ portalRowsByPatient: rows });
    const reader = createPortalTriageReader(store, orgOf, () => NOW);
    // -1000 hours would otherwise resolve to a window in the FUTURE and hide the row (or, unclamped the
    // other way, reach back forever). Clamped to 0 ⇒ the look-back is empty, and nothing before now shows.
    await expect(reader.summaryForPatient(ORG, PATIENT, -1000)).resolves.toEqual([]);
    await expect(reader.summaryForPatient(ORG, PATIENT, 24)).resolves.toHaveLength(1);
  });
});

describe("TriageCallMetricsProvider — §4.3 / §9.7", () => {
  it("computes p95 by nearest rank, so the number is a latency some call actually had", () => {
    expect(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentileOf([5], 95)).toBe(5);
    expect(percentileOf([], 95)).toBe(0);
  });

  it("derives each rate from the SAME counts the measure input publishes", async () => {
    const { store } = createInMemoryOncallSeamStore({
      hospitalizationAvoidance: { numerator: 9, denominator: 12 },
      afterHoursVisitConversion: { numerator: 3, denominator: 12 },
    });
    const metrics = createTriageCallMetricsProvider(store, orgOf);
    const counts = await metrics.getHospitalizationAvoidanceCounts(ORG, window);
    await expect(metrics.getHospitalizationAvoidanceRate(ORG, window)).resolves.toBeCloseTo(
      counts.numerator / counts.denominator,
    );
    await expect(metrics.getAfterHoursVisitConversionRate(ORG, window)).resolves.toBeCloseTo(0.25);
  });

  it("publishes the DENOMINATOR, so M30 can suppress below the reportable floor", async () => {
    const { store } = createInMemoryOncallSeamStore({
      hospitalizationAvoidance: { numerator: 0, denominator: 0 },
    });
    const metrics = createTriageCallMetricsProvider(store, orgOf);
    // A rate of 0 over an empty population and over a hundred calls are the same number, different facts.
    await expect(metrics.getHospitalizationAvoidanceRate(ORG, window)).resolves.toBe(0);
    await expect(metrics.getHospitalizationAvoidanceCounts(ORG, window)).resolves.toEqual({
      numerator: 0,
      denominator: 0,
    });
  });

  it("orders the chief-complaint Pareto by count, keyed on the protocol catalog", async () => {
    const { store } = createInMemoryOncallSeamStore({
      chiefComplaintTallies: [
        { protocolKey: "pain_crisis", chiefComplaintLabel: "Pain Crisis", count: 4 },
        { protocolKey: "dyspnea", chiefComplaintLabel: "Dyspnea", count: 11 },
      ],
    });
    const pareto = await createTriageCallMetricsProvider(store, orgOf).getChiefComplaintPareto(
      ORG,
      window,
    );
    expect(pareto.map((b) => b.protocolKey)).toEqual(["dyspnea", "pain_crisis"]);
  });
});

describe("coverageGapMinutesOf — §2.4 / §9.7", () => {
  const oneDay: TriageMetricsWindow = {
    from: "2026-07-31T00:00:00.000Z" as IsoInstant,
    to: "2026-08-01T00:00:00.000Z" as IsoInstant,
  };

  it("counts a ProviderEntity with no shift at all as dark for the WHOLE window", () => {
    expect(coverageGapMinutesOf(oneDay, { providerEntityIds: [PE], windows: [] })).toBe(24 * 60);
  });

  it("sums PER ProviderEntity, so one covered PE cannot mask another's dark night", () => {
    const gap = coverageGapMinutesOf(oneDay, {
      providerEntityIds: [PE, PE2],
      windows: [
        {
          providerEntityId: PE,
          fromIso: oneDay.from,
          toIso: oneDay.to,
        },
      ],
    });
    // PE fully covered (0) + PE2 entirely uncovered (1440). An org-wide union would have said 0.
    expect(gap).toBe(24 * 60);
  });

  it("merges overlapping shifts so double coverage does not subtract twice", () => {
    const gap = coverageGapMinutesOf(oneDay, {
      providerEntityIds: [PE],
      windows: [
        {
          providerEntityId: PE,
          fromIso: "2026-07-31T00:00:00.000Z" as IsoInstant,
          toIso: "2026-07-31T14:00:00.000Z" as IsoInstant,
        },
        {
          providerEntityId: PE,
          fromIso: "2026-07-31T10:00:00.000Z" as IsoInstant,
          toIso: "2026-07-31T20:00:00.000Z" as IsoInstant,
        },
      ],
    });
    expect(gap).toBe(4 * 60); // 20:00 → 24:00
  });

  it("clips a shift that runs past the window edges", () => {
    const gap = coverageGapMinutesOf(oneDay, {
      providerEntityIds: [PE],
      windows: [
        {
          providerEntityId: PE,
          fromIso: "2026-07-30T12:00:00.000Z" as IsoInstant,
          toIso: "2026-08-02T12:00:00.000Z" as IsoInstant,
        },
      ],
    });
    expect(gap).toBe(0);
  });

  it("reports no gap for an org with no ProviderEntities (no coverage obligation)", () => {
    expect(coverageGapMinutesOf(oneDay, { providerEntityIds: [], windows: [] })).toBe(0);
  });
});

describe("seam resolution", () => {
  it("resolves each published seam through the M1 registry, not a direct import", async () => {
    const { store } = createInMemoryOncallSeamStore({ shifts: [shift()] });
    registerOncallSeams({ store, orgOf });
    expect(getSeam("OnCallProvider")).toBe(getOnCallProvider());
    await expect(getSeam("OnCallProvider").activeShiftsAt(ORG, NOW)).resolves.toHaveLength(1);
  });
});
