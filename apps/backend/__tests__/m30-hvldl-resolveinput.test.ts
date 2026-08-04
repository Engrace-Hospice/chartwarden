// apps/backend/__tests__/m30-hvldl-resolveinput.test.ts — M30 measure-recompute HVLDL input binding (§4.11).
//
// The `m30.measure_recompute` worker reaches ONE seam — `measureRecompute.data.resolveInput` — to shape each
// measure's calculator input. The backend resolver `resolveHvldlMeasureInput`
// (apps/backend/src/modules/30-quality/jobs/m30-jobs.ts) builds the HVLDL decedent census from TWO seams:
//   • the M6 `DeathDischargeReader` — the death-discharge denominator for the reporting period;
//   • the M8 `SignedEncountersReader` — the qualifying-discipline visit count in the last days of life.
// This test feeds a fake of each (2 decedents: one with ≥2 EVV-verified qualifying visits, one with none)
// through the resolver, then runs the REAL registered `computeHvldl` over the shaped input and asserts the
// numerator/denominator/rate. It pins the predicate: ONLY `evv_present` + qualifying-discipline + in-window
// (service date at-or-before the death date) visits count — EVV-missing, non-qualifying-discipline, and
// post-death visits are excluded.
import { buildMeasureRegistry } from "@wardenx/quality";
import type {
  DeathDischargeReader,
  DeathDischargeRow,
  EncounterDiscipline,
  EvvBracketState,
  SignedEncounterDigest,
  SignedEncountersReader,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { resolveHvldlMeasureInput } from "../src/modules/30-quality/jobs/m30-jobs";

const ORG = "00000000-0000-4000-8000-0000000000ee";
const PROVIDER = "a0000000-0000-4000-8000-000000000001";
// A reporting period whose `periodEnd` lands in FY2025 (Jul → month 6 < Oct) ⇒ qualifying disciplines rn + msw.
const PERIOD_START = "2024-07-01T00:00:00.000Z";
const PERIOD_END = "2025-07-01T00:00:00.000Z";

const PATIENT_A = "p0000000-0000-4000-8000-00000000000a";
const PATIENT_B = "p0000000-0000-4000-8000-00000000000b";
const ADMISSION_A = "ad000000-0000-4000-8000-00000000000a";
const ADMISSION_B = "ad000000-0000-4000-8000-00000000000b";

const REGISTRY = buildMeasureRegistry();

function registrationFor(code: string) {
  const registration = REGISTRY.get(code);
  if (registration === undefined) throw new Error(`no registration for '${code}'`);
  return registration;
}

function request(code: string) {
  return {
    registration: registrationFor(code),
    organizationId: ORG,
    providerEntityId: PROVIDER,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
  };
}

/** A signed-encounter digest with the fields the HVLDL predicate reads (the rest are filler). */
function digest(
  patientId: string,
  admissionId: string,
  discipline: EncounterDiscipline,
  serviceDate: string,
  evvBracketState: EvvBracketState,
): SignedEncounterDigest {
  return {
    encounterId: `${patientId}:${serviceDate}:${discipline}`,
    patientId,
    admissionId,
    encounterType: "routine_visit",
    discipline,
    serviceDate,
    signedAt: `${serviceDate}T12:00:00.000Z`,
    signedByMembershipId: "mem-0000",
    lateEntryTier: "normal",
    status: "signed",
    evvBracketState,
  };
}

/** A recording fake M6 death-census reader returning a fixed decedent list + capturing the call args. */
function fakeDeathReader(rows: ReadonlyArray<DeathDischargeRow>): {
  reader: DeathDischargeReader;
  calls: { org?: string; period?: { from: string; to: string } };
} {
  const calls: { org?: string; period?: { from: string; to: string } } = {};
  const reader: DeathDischargeReader = {
    async listDeathDischargesInPeriod(organizationId, period) {
      calls.org = organizationId;
      calls.period = period;
      return rows;
    },
  };
  return { reader, calls };
}

/** A fake M8 signed-encounter reader keyed by patient id + capturing the `since` lower bound per patient. */
function fakeEncounters(byPatient: Record<string, ReadonlyArray<SignedEncounterDigest>>): {
  encounters: SignedEncountersReader;
  sinceByPatient: Record<string, string>;
} {
  const sinceByPatient: Record<string, string> = {};
  const encounters: SignedEncountersReader = {
    async signedEncountersForPatientSince(_organizationId, patientId, since) {
      sinceByPatient[patientId] = since;
      return byPatient[patientId] ?? [];
    },
    async renderPayloadFor() {
      throw new Error("renderPayloadFor is not used on the HVLDL path");
    },
  };
  return { encounters, sinceByPatient };
}

describe("resolveHvldlMeasureInput — HVLDL measure-input binding (§4.11)", () => {
  // Decedent A dies 2025-03-15; qualifying = rn|msw; window = last 3 calendar days.
  const DEATH_A = "2025-03-15T10:00:00.000Z";
  const DEATH_B = "2025-04-10T08:00:00.000Z";

  const decedents: ReadonlyArray<DeathDischargeRow> = [
    {
      patientId: PATIENT_A,
      admissionId: ADMISSION_A,
      deathAt: DEATH_A,
      source: "internal_clinician_recorded",
    },
    {
      patientId: PATIENT_B,
      admissionId: ADMISSION_B,
      deathAt: DEATH_B,
      source: "internal_clinician_recorded",
    },
  ];

  // Patient A: exactly two visits qualify (rn + msw, EVV-present, in-window). The other three are excluded —
  // one for EVV-missing, one for a non-qualifying discipline (chha), one for a post-death service date.
  const patientAVisits: ReadonlyArray<SignedEncounterDigest> = [
    digest(PATIENT_A, ADMISSION_A, "rn", "2025-03-14", "evv_present"), // ✓ counts
    digest(PATIENT_A, ADMISSION_A, "msw", "2025-03-15", "evv_present"), // ✓ counts (death day)
    digest(PATIENT_A, ADMISSION_A, "rn", "2025-03-13", "evv_missing_documented"), // ✗ not EVV-verified
    digest(PATIENT_A, ADMISSION_A, "chha", "2025-03-14", "evv_present"), // ✗ non-qualifying discipline
    digest(PATIENT_A, ADMISSION_A, "rn", "2025-03-20", "evv_present"), // ✗ service date after death
  ];

  it("builds the census from the two seams and the real computeHvldl yields 1/2 below national average", async () => {
    const { reader, calls } = fakeDeathReader(decedents);
    const { encounters, sinceByPatient } = fakeEncounters({
      [PATIENT_A]: patientAVisits,
      [PATIENT_B]: [], // no visits ⇒ count 0 ⇒ denominator member, not numerator
    });

    const input = (await resolveHvldlMeasureInput(request("hvldl"), {
      deathDischargeReader: reader,
      encounters,
    })) as {
      organizationId: string;
      providerEntityId: string;
      periodStart: string;
      periodEnd: string;
      nationalAvg: number;
      minQualifyingVisits: number;
      decedents: ReadonlyArray<{
        patientId: string;
        source: string;
        qualifyingDisciplineVisitsInLastDays: number;
      }>;
    };

    // The death reader was scoped to the org + the reporting window.
    expect(calls.org).toBe(ORG);
    expect(calls.period).toEqual({ from: PERIOD_START, to: PERIOD_END });

    // The encounter scan opened at deathAt − 3 calendar days for each decedent.
    expect(sinceByPatient[PATIENT_A]).toBe("2025-03-12T10:00:00.000Z");
    expect(sinceByPatient[PATIENT_B]).toBe("2025-04-07T08:00:00.000Z");

    // The base ComputeMeasureInput rides through + the per-FY tuning constants are set.
    expect(input.organizationId).toBe(ORG);
    expect(input.providerEntityId).toBe(PROVIDER);
    expect(input.nationalAvg).toBe(0.62); // HCI_THRESHOLDS_v2025.hvldlNationalAvg
    expect(input.minQualifyingVisits).toBe(2);

    // ONLY the EVV-present + qualifying-discipline + in-window visits count toward the predicate.
    expect(input.decedents).toHaveLength(2);
    const a = input.decedents.find((d) => d.patientId === PATIENT_A);
    const b = input.decedents.find((d) => d.patientId === PATIENT_B);
    expect(a?.qualifyingDisciplineVisitsInLastDays).toBe(2);
    expect(b?.qualifyingDisciplineVisitsInLastDays).toBe(0);

    // The real registered calculator: numerator = decedents with ≥2 qualifying visits (A only); denom = all.
    const result = registrationFor("hvldl").calculator(input as never);
    expect(result.numerator).toBe(1);
    expect(result.denominator).toBe(2);
    expect(result.rate).toBeCloseTo(0.5, 10);
    expect(result.thresholdMet).toBe(false); // 0.5 < 0.62 national average
    expect(result.bandColor).toBe("red");
  });

  it("all-internal-source census fires no §4.11 Risk-Register flag (external subset empty)", async () => {
    const { reader } = fakeDeathReader(decedents);
    const { encounters } = fakeEncounters({ [PATIENT_A]: patientAVisits, [PATIENT_B]: [] });

    const input = await resolveHvldlMeasureInput(request("hvldl"), {
      deathDischargeReader: reader,
      encounters,
    });
    const result = registrationFor("hvldl").calculator(input as never);
    const snapshot = result.computationSnapshot as {
      externalSourceBreakdown: { hl7External: number };
      riskRegisterFlag: unknown | null;
    };
    expect(snapshot.externalSourceBreakdown.hl7External).toBe(0);
    expect(snapshot.riskRegisterFlag).toBeNull();
  });
});
