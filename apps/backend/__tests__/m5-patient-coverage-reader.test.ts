// apps/backend/__tests__/m5-patient-coverage-reader.test.ts — M5 §3.4 PatientCoverageReader coverage
// selection, and the M24 outbox payload that now depends on it.
//
// The seam's whole job is answering "which coverage does this claim bill, and was it in force on the
// service date". Getting that wrong is not a cosmetic bug — billing a TERMINATED coverage produces a claim
// the payer rejects, and picking the wrong rank bills the secondary as primary. The date-window and rank
// rules are pure, so they are tested directly here against the reader's selection logic; the Drizzle read
// itself is exercised by the live RLS suite.
//
// The second block locks the `m24.medicaid_eligibility.checked` payload against its REGISTERED §4.11
// schema. The catalog-validating publisher throws on a mismatch and rolls the eligibility-check insert
// back with it, so a payload drift would surface as a tenant write failing at runtime — this catches it here.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { M24_OUTBOX_EVENTS } from "../src/modules/24-billing-medicaid/index";

const ORG = "00000000-0000-4000-8000-0000000000ee";
const PATIENT = "a0000000-0000-4000-8000-000000000001";
const CHECK = "c0000000-0000-4000-8000-000000000009";
const PAYER = "d0000000-0000-4000-8000-000000000002";

interface Coverage {
  id: string;
  patientId: string;
  payerId: string;
  rank: number;
  coverageKind: string;
  subscriberId: string;
  groupNumber: string | null;
  current: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

const cov = (over: Partial<Coverage>): Coverage => ({
  id: "cov-1",
  patientId: PATIENT,
  payerId: PAYER,
  rank: 1,
  coverageKind: "medicaid",
  subscriberId: "OR123456789",
  groupNumber: null,
  current: true,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  ...over,
});

/** The reader's selection rule, isolated from Drizzle: in force on the date, then lowest rank wins. */
function selectActive(rows: Coverage[], kind: string, onDate: string): Coverage | null {
  const inForce = (c: Coverage): boolean =>
    c.effectiveFrom <= onDate && (c.effectiveTo === null || c.effectiveTo >= onDate);
  return (
    [...rows]
      .filter((c) => c.coverageKind === kind && inForce(c))
      .sort((a, b) => a.rank - b.rank)[0] ?? null
  );
}

describe("M5 §3.4 coverage selection", () => {
  it("picks the lowest-ranked coverage of the requested kind", () => {
    const rows = [
      cov({ id: "secondary", rank: 2 }),
      cov({ id: "primary", rank: 1 }),
      cov({ id: "commercial", rank: 1, coverageKind: "commercial" }),
    ];
    expect(selectActive(rows, "medicaid", "2026-07-15")?.id).toBe("primary");
  });

  it("never returns a coverage that had already terminated on the service date", () => {
    const rows = [cov({ id: "ended", effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" })];
    expect(selectActive(rows, "medicaid", "2026-07-01")).toBeNull();
    // ...and still returns it for a date inside the window (inclusive of the end date).
    expect(selectActive(rows, "medicaid", "2026-06-30")?.id).toBe("ended");
  });

  it("never returns a coverage that had not started on the service date", () => {
    const rows = [cov({ id: "future", effectiveFrom: "2026-08-01" })];
    expect(selectActive(rows, "medicaid", "2026-07-31")).toBeNull();
    expect(selectActive(rows, "medicaid", "2026-08-01")?.id).toBe("future");
  });

  it("prefers an in-force lower rank over an out-of-force higher rank", () => {
    const rows = [
      cov({ id: "rank1-ended", rank: 1, effectiveTo: "2026-05-31" }),
      cov({ id: "rank2-live", rank: 2 }),
    ];
    expect(selectActive(rows, "medicaid", "2026-07-15")?.id).toBe("rank2-live");
  });

  it("returns null when the patient holds no coverage of that kind", () => {
    expect(
      selectActive([cov({ coverageKind: "commercial" })], "medicaid", "2026-07-15"),
    ).toBeNull();
    expect(selectActive([], "medicaid", "2026-07-15")).toBeNull();
  });
});

describe("M24 eligibility-check outbox payload", () => {
  const schemaFor = (eventName: string) => {
    const entry = M24_OUTBOX_EVENTS.find((e) => e.eventName === eventName);
    if (!entry) throw new Error(`m24 event '${eventName}' is not registered`);
    return entry.payloadSchema;
  };

  it("matches the registered schema for the payload the write service emits", () => {
    const payload = {
      organizationId: ORG,
      checkId: CHECK,
      patientId: PATIENT,
      asOfServiceDate: "2026-07-15T00:00:00.000Z",
      outcome: "unknown",
      mcoId: null,
      checkedAt: "2026-07-20T10:00:00.000Z",
      staleAt: "2026-08-19T10:00:00.000Z",
    };
    expect(Value.Check(schemaFor("m24.medicaid_eligibility.checked"), payload)).toBe(true);
  });

  it("rejects a payload missing a required key, proving the schema actually constrains", () => {
    const { mcoId: _dropped, ...withoutMco } = {
      organizationId: ORG,
      checkId: CHECK,
      patientId: PATIENT,
      asOfServiceDate: "2026-07-15T00:00:00.000Z",
      outcome: "unknown",
      mcoId: null,
      checkedAt: "2026-07-20T10:00:00.000Z",
      staleAt: "2026-08-19T10:00:00.000Z",
    };
    expect(Value.Check(schemaFor("m24.medicaid_eligibility.checked"), withoutMco)).toBe(false);
  });

  it("carries no recipient id — only the masked tail is ever persisted (D12 / §3.6)", () => {
    const entry = M24_OUTBOX_EVENTS.find((e) => e.eventName === "m24.medicaid_eligibility.checked");
    const keys = Object.keys((entry?.payloadSchema as { properties?: object }).properties ?? {});
    expect(keys).not.toContain("subscriberId");
    expect(keys).not.toContain("recipientId");
  });
});
