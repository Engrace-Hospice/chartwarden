// @wardenx/quality — M30 measure-REGISTRATIONS unit tests (§3.1 / §4.8 / V-8).
//
// Proves the gap between "workers boot" and "workers compute" is closed: `buildMeasureRegistry()` binds
// EVERY catalog descriptor to its concrete pure calculator, the per-registration period rule cannot drift
// from `MEASURE_CATALOG`, and the `m30.measure_recompute` worker — handed the real registry instead of the
// old empty map — resolves a calculator by measure code and computes a real value rather than failing
// closed with `MeasureRegistrationMissing`. PURE: no DB / Valkey / BullMQ (the M33 `refresh.test.ts` idiom).
import type { schema } from "@wardenx/db";
import {
  type ComputeHvldlInput,
  M30_MEASURE_REGISTRATIONS,
  MEASURE_CATALOG,
  type MeasureRecomputePorts,
  buildMeasureRegistry,
  computeHvldl,
  handleMeasureRecompute,
} from "@wardenx/quality";
import { describe, expect, it } from "vitest";

describe("M30 measure registrations", () => {
  const registry = buildMeasureRegistry();

  it("registers EVERY catalog entry (no descriptor left without a calculator)", () => {
    expect(M30_MEASURE_REGISTRATIONS.length).toBe(MEASURE_CATALOG.length);
    for (const entry of MEASURE_CATALOG) {
      expect(registry.has(entry.code)).toBe(true);
    }
    // The by-code lookup has exactly one registration per catalog code (no dupes / no extras).
    expect(registry.size).toBe(MEASURE_CATALOG.length);
  });

  it("derives each registration's period rule from the catalog descriptor (no drift)", () => {
    for (const entry of MEASURE_CATALOG) {
      const registration = registry.get(entry.code);
      expect(registration).toBeDefined();
      expect(registration?.periodKind).toBe(entry.periodKind);
      expect(registration?.family).toBe(entry.family);
      expect(registration?.activatesFy).toBe(entry.activatesFy);
      expect(registration?.calculatorVersion).toBe(entry.calculatorVersion);
    }
  });

  it("binds the CONCRETE calculator — the registered hvldl reduces an input identically to a direct call", () => {
    const input: ComputeHvldlInput = {
      organizationId: "org-1",
      providerEntityId: "pe-1",
      periodStart: "2025-04-01",
      periodEnd: "2026-04-01",
      nationalAvg: 0.6,
      decedents: [
        {
          patientId: "p1",
          source: "internal_clinician_recorded",
          qualifyingDisciplineVisitsInLastDays: 3,
        },
        {
          patientId: "p2",
          source: "internal_clinician_recorded",
          qualifyingDisciplineVisitsInLastDays: 2,
        },
        {
          patientId: "p3",
          source: "internal_clinician_recorded",
          qualifyingDisciplineVisitsInLastDays: 2,
        },
        {
          patientId: "p4",
          source: "internal_clinician_recorded",
          qualifyingDisciplineVisitsInLastDays: 0,
        },
      ],
    };
    const direct = computeHvldl(input);
    const viaRegistry = registry.get("hvldl")?.calculator(input as never);
    expect(viaRegistry).toEqual(direct);
    // sanity: 3/4 qualifying, ≥ national avg 0.6 ⇒ threshold met ⇒ green
    expect(direct.numerator).toBe(3);
    expect(direct.denominator).toBe(4);
    expect(direct.bandColor).toBe("green");
  });

  it("activation FY is honored: the FY2028 HOPE-derived measures are registered with activatesFy 2028", () => {
    expect(registry.get("tfp_pi")?.activatesFy).toBe(2028);
    expect(registry.get("tfp_npsi")?.activatesFy).toBe(2028);
    expect(registry.get("hci_composite")?.activatesFy).toBe(2025);
  });
});

describe("measure-recompute worker over the REAL registry (gap closed)", () => {
  function portsOverRegistry(input: ComputeHvldlInput): {
    ports: MeasureRecomputePorts;
    inserted: schema.NewQualityMeasureValue[];
  } {
    const inserted: schema.NewQualityMeasureValue[] = [];
    const ports: MeasureRecomputePorts = {
      processingLog: { isProcessed: async () => false, markProcessed: async () => {} },
      // ★ the real registry — not the old empty map.
      registrations: buildMeasureRegistry(),
      hope: {
        timepointCompletionRollup: async () => ({ onTime: 0, late: 0 }),
        submissionPostureRollup: async () => ({
          submissions: 0,
          acceptedSubmissions: 0,
          queuedSubmissions: 0,
        }),
        sfvTimelinessRollup: async () => ({ sfvDue: 0, sfvOnTime: 0 }),
        j2051FollowUpRollup: async () => ({
          painTriggers: 0,
          painFollowUpsInWindow: 0,
          nonPainTriggers: 0,
          nonPainFollowUpsInWindow: 0,
        }),
        openSfvObligationCount: async () => 0,
      },
      data: { resolveInput: async () => input },
      values: {
        findCurrent: async () => null,
        insertValue: async (values) => {
          inserted.push(values);
          return values as schema.QualityMeasureValue;
        },
        supersede: async () => {},
      },
      outbox: {
        emitValueEmitted: async () => {},
        emitThresholdBreached: async () => {},
      },
      hashSnapshot: () => "hash-hvldl",
      newValueId: () => "value-NEW",
      now: () => new Date("2026-04-02T03:15:00Z"),
    };
    return { ports, inserted };
  }

  it("resolves the hvldl calculator by code and persists its computed numerator/denominator/ratio", async () => {
    const input: ComputeHvldlInput = {
      organizationId: "org-1",
      providerEntityId: "pe-1",
      periodStart: "2025-04-01",
      periodEnd: "2026-04-01",
      nationalAvg: 0.6,
      decedents: [
        {
          patientId: "p1",
          source: "internal_clinician_recorded",
          qualifyingDisciplineVisitsInLastDays: 3,
        },
        {
          patientId: "p2",
          source: "internal_clinician_recorded",
          qualifyingDisciplineVisitsInLastDays: 2,
        },
        {
          patientId: "p3",
          source: "internal_clinician_recorded",
          qualifyingDisciplineVisitsInLastDays: 2,
        },
        {
          patientId: "p4",
          source: "internal_clinician_recorded",
          qualifyingDisciplineVisitsInLastDays: 0,
        },
      ],
    };
    const { ports, inserted } = portsOverRegistry(input);
    const result = await handleMeasureRecompute(
      {
        jobId: "job-1",
        organizationId: "org-1",
        providerEntityId: "pe-1",
        measureCode: "hvldl",
        periodStart: "2025-04-01",
        periodEnd: "2026-04-01",
        reason: "nightly_cron",
        computeVersion: "0.3.0",
      },
      ports,
    );
    expect(result).toMatchObject({
      outcome: "recomputed",
      measureCode: "hvldl",
      valueId: "value-NEW",
    });
    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row?.numerator).toBe(3);
    expect(row?.denominator).toBe(4);
    expect(row?.ratio).toBe("0.7500"); // numeric(6,4) string; the worker stamps calculator output
    expect(row?.measureCode).toBe("hvldl");
    expect(row?.calculatorVersion).toBe("0.3.0"); // sourced from the registration's catalog descriptor
  });

  it("still fails closed loudly for a measure code with NO registration (registry is not a silent catch-all)", async () => {
    const input = {} as ComputeHvldlInput;
    const { ports } = portsOverRegistry(input);
    await expect(
      handleMeasureRecompute(
        {
          jobId: "job-2",
          organizationId: "org-1",
          providerEntityId: "pe-1",
          measureCode: "not_a_real_measure",
          periodStart: "2025-04-01",
          periodEnd: "2026-04-01",
          reason: "adhoc",
          computeVersion: "0.1.0",
        },
        ports,
      ),
    ).rejects.toThrow(/no registered calculator/);
  });
});
