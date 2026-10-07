/**
 * M26 §4.2 — the request contracts are ENFORCED at runtime, not merely published.
 *
 * REGRESSION. Every M26 mutation used to read its body with `const body = request.body as { … }` — a
 * TypeScript cast, erased at runtime — while `m26-typebox.ts` re-exported the very same contracts to
 * the OpenAPI enrichment registry. So the module published a §4.2 contract it did not apply: the spec
 * promised `graceWindowDays` was 0–90, `resolutionNotes` ≥ 20 chars, `attestation` ≥ 20, `macRegion` a
 * closed set — and the server accepted `graceWindowDays: -99999` on a Medicare cap grace window and an
 * `attestation` of `true` recorded as a legal artifact.
 *
 * Note what did NOT catch it: `arch:openapi-coverage` counted these routes as ENRICHED throughout,
 * because it measures whether a contract is PUBLISHED, not whether one is APPLIED. These cases assert
 * the schemas directly, so the two can never drift apart again.
 */
import { describe, expect, it } from "vitest";
import {
  AmendConstantRequest,
  CapYearParams,
  FinalizeSettlementRequest,
  LineIdParams,
  LockMethodologyRequest,
  OpenCapPeriodRequest,
  PeriodIdParams,
  PsrImportRequest,
  PublishConstantRequest,
  ReopenCapPeriodRequest,
  ResolveVarianceRequest,
  parse,
} from "../routes/m26-typebox";

const invalid = (schema: Parameters<typeof parse>[0], raw: unknown, field: string) => {
  try {
    parse(schema, raw);
  } catch (err) {
    expect((err as { code?: string }).code).toBe("VALIDATION_FAILED");
    expect((err as { details?: { field: string }[] }).details?.[0]?.field).toBe(field);
    return;
  }
  throw new Error(`expected ${field} to be refused, but parse() accepted the value`);
};

describe("M26 open-cap-period", () => {
  it("accepts a well-formed body", () => {
    expect(parse(OpenCapPeriodRequest, { capYear: "FY2026", graceWindowDays: 30 })).toMatchObject({
      capYear: "FY2026",
      graceWindowDays: 30,
    });
  });

  // The headline case from the audit: a negative grace window on a Medicare cap period.
  it("refuses a negative graceWindowDays", () =>
    invalid(
      OpenCapPeriodRequest,
      { capYear: "FY2026", graceWindowDays: -99999 },
      "graceWindowDays",
    ));

  it("refuses a graceWindowDays past the 90-day ceiling", () =>
    invalid(OpenCapPeriodRequest, { capYear: "FY2026", graceWindowDays: 900 }, "graceWindowDays"));

  it("refuses a cap year that is not FY####", () =>
    invalid(OpenCapPeriodRequest, { capYear: "2026" }, "capYear"));

  it("refuses a methodology outside the closed set", () =>
    invalid(OpenCapPeriodRequest, { capYear: "FY2026", methodology: "made-up" }, "methodology"));
});

describe("M26 settlement + reconciliation", () => {
  // `attestation` is a legal artifact. A boolean or a one-word string is not one.
  it("refuses a non-string attestation", () =>
    invalid(FinalizeSettlementRequest, { attestation: true }, "attestation"));

  it("refuses an attestation under the 20-char floor", () =>
    invalid(FinalizeSettlementRequest, { attestation: "too short" }, "attestation"));

  it("accepts a substantive attestation", () =>
    expect(parse(FinalizeSettlementRequest, { attestation: "a".repeat(30) })).toMatchObject({
      attestation: "a".repeat(30),
    }));

  it("refuses resolutionNotes under the 20-char floor", () =>
    invalid(
      ResolveVarianceRequest,
      { varianceReason: "timing", resolutionNotes: "brief" },
      "resolutionNotes",
    ));

  it("refuses a varianceReason outside the closed set", () =>
    invalid(
      ResolveVarianceRequest,
      { varianceReason: "whatever", resolutionNotes: "a".repeat(30) },
      "varianceReason",
    ));

  it("requires the PSR payload — an import with no file is not an import", () =>
    invalid(
      PsrImportRequest,
      { macRegion: "palmetto", psrPeriodFrom: "2026-01-01", psrPeriodTo: "2026-01-31" },
      "fileBase64",
    ));
});

describe("M26 platform cap constants (cross-tenant reference data)", () => {
  // DOCUMENTED, not asserted-as-refused: the platform `parse()` convention is Convert-then-Check, and
  // TypeBox's Convert TRUNCATES a fractional value to satisfy Type.Integer — so 1.5 becomes 1 rather
  // than 422. Recorded here because a silent coercion on a money field is worth knowing about; changing
  // it means changing Convert-then-Check for every module, not just M26.
  it("TRUNCATES a fractional cents amount rather than refusing it (Convert-then-Check)", () => {
    expect(
      parse(PublishConstantRequest, { capYear: "FY2026", aggregateCapAmountCents: 1.5 }),
    ).toMatchObject({ aggregateCapAmountCents: 1 });
  });

  it("refuses a cents amount that is not numeric at all", () =>
    invalid(
      PublishConstantRequest,
      { capYear: "FY2026", aggregateCapAmountCents: "lots" },
      "aggregateCapAmountCents",
    ));

  it("refuses an inpatientCapPct outside 0..1", () =>
    invalid(
      PublishConstantRequest,
      { capYear: "FY2026", aggregateCapAmountCents: 100, inpatientCapPct: 5 },
      "inpatientCapPct",
    ));

  it("refuses a missing cents amount on amend", () =>
    invalid(
      AmendConstantRequest,
      { sourceUrl: "https://example.test" },
      "aggregateCapAmountCents",
    ));
});

describe("M26 path params", () => {
  // Before the params preHandler these reached Drizzle and came back as Postgres 22P02 — a 500 for a
  // malformed request. The guard runs FIRST in the chain, ahead of the ABAC owner-fact load.
  it("refuses a non-uuid periodId", () =>
    invalid(PeriodIdParams, { periodId: "not-a-uuid" }, "periodId"));

  it("refuses a non-uuid lineId while accepting a valid importId", () => {
    // Guards the `format: "uuid"` trap: TypeBox resolves `format` through a GLOBAL FormatRegistry that
    // only M21 populates, and an unregistered format FAILS — so a valid uuid was rejected here with
    // "Unknown format 'uuid'" whenever M21 was not loaded. These params use an explicit pattern, so a
    // valid importId passes and only the malformed lineId is named.
    invalid(
      LineIdParams,
      { importId: "11111111-1111-1111-1111-111111111111", lineId: "worse" },
      "lineId",
    );
    expect(
      parse(LineIdParams, {
        importId: "11111111-1111-1111-1111-111111111111",
        lineId: "22222222-2222-2222-2222-222222222222",
      }),
    ).toBeTruthy();
  });

  it("refuses a cap year path param that is not FY####", () =>
    invalid(CapYearParams, { capYear: "2026" }, "capYear"));
});

describe("M26 step-up is a SERVER fact, never a body field", () => {
  // `contracts.LockMethodologyRequest` / `FinalizeSettlementRequest` declare `stepUpAssertionId`, and
  // neither write-service input consumes it. Step-up on these routes is enforced by the STEP_UP
  // preHandler over M3's `step_up_recent`, which reads the session. Accepting a caller-supplied
  // assertion id would repeat the audit-C2 defect (`cosignRequired` in the break-glass body): the
  // caller asserting its own security fact. The route schemas omit it.
  it("omits stepUpAssertionId from the lock-methodology body", () => {
    expect(Object.keys(LockMethodologyRequest.properties)).toEqual(["methodology", "reason"]);
  });

  it("omits stepUpAssertionId from the finalize-settlement body", () => {
    expect(Object.keys(FinalizeSettlementRequest.properties)).toEqual(["attestation"]);
  });

  it("omits stepUpAssertionId from the reopen-period body (GAP-079)", () => {
    expect(Object.keys(ReopenCapPeriodRequest.properties)).toEqual(["reason"]);
    invalid(
      ReopenCapPeriodRequest,
      { reason: "correct a variance", stepUpAssertionId: "11111111-1111-1111-1111-111111111111" },
      "stepUpAssertionId",
    );
  });

  it("REFUSES a stepUpAssertionId a caller tries to smuggle back in", () => {
    // The bodies are `additionalProperties: false`, so dropping the field is enforced rather than
    // cosmetic — an open object would have accepted it and forwarded it, which is how a removed field
    // comes back. Same reason M3's InvokeBreakGlassBody is closed.
    invalid(
      LockMethodologyRequest,
      {
        methodology: "streamlined",
        reason: "annual election",
        stepUpAssertionId: "11111111-1111-1111-1111-111111111111",
      },
      "stepUpAssertionId",
    );
  });
});
