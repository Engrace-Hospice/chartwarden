import { ValidationError } from "@chartwarden/types";
// apps/backend/__tests__/m24-route-validation.test.ts — M24 (§4.2) request-validation conformance.
//
// The M24 routes bind the `m24-typebox` schemas through `parse(...)` at the route boundary, so a malformed
// body or query is rejected with M1's VALIDATION_FAILED envelope BEFORE it reaches a service. This test
// locks that contract per schema: the shape a route actually accepts, and — the part that matters — the
// shapes it must REFUSE. Without the negative cases a schema that silently accepts anything would still
// pass a "does it parse a good request" test.
//
// It also locks the invariants a permissive schema would quietly break:
//   - reason fields on the destructive commands (replace / void / terminate) enforce the ≥40-char rationale
//     the server CHECK constraint also enforces, so the UI's counter and the API agree;
//   - `parseQuery` CONVERTS its scalars (`?limit=25` arrives as the string "25" and must land as a number),
//     which is why the read paths no longer hand-roll string coercion;
//   - `parse` (bodies) deliberately does NOT convert, so a wrong-typed money field is REJECTED rather than
//     rounded — coercion there would turn a client bug into a silent money bug.
import { describe, expect, it } from "vitest";
import {
  ApplyOverrideBody,
  AssembleClaimBody,
  ClaimListQuery,
  CreateRbArrangementBody,
  OverrideRbDayBody,
  ReplaceClaimBody,
  SubmitClaimBody,
  TerminateRbArrangementBody,
  UpsertCredentialBody,
  ValidationWorklistQuery,
  parse,
  parseQuery,
} from "../src/modules/24-billing-medicaid/routes/m24-typebox";

const UUID_A = "a0000000-0000-4000-8000-000000000001";
const UUID_B = "b0000000-0000-4000-8000-000000000002";
const UUID_C = "c0000000-0000-4000-8000-000000000003";
const REASON = "The payer reprocessed this period under a corrected rate schedule.";

/** Assert a payload is rejected, and that it fails as M1's VALIDATION_FAILED (not some other throw). */
const expectRejected = (schema: Parameters<typeof parse>[0], raw: unknown): void => {
  expect(() => parse(schema, raw)).toThrow(ValidationError);
};
const expectQueryRejected = (schema: Parameters<typeof parseQuery>[0], raw: unknown): void => {
  expect(() => parseQuery(schema, raw)).toThrow(ValidationError);
};

describe("M24 §4.2 request validation — bodies", () => {
  it("accepts a well-formed assemble body and rejects a bad claim kind", () => {
    const ok = parse(AssembleClaimBody, {
      patientId: UUID_A,
      admissionId: UUID_B,
      providerEntityId: UUID_C,
      serviceFrom: "2026-07-01",
      serviceTo: "2026-07-31",
      kind: "combined_hospice_rb",
      rbArrangementId: UUID_A,
    });
    expect(ok.kind).toBe("combined_hospice_rb");
    expect(ok.serviceFrom).toBe("2026-07-01");

    expectRejected(AssembleClaimBody, {
      patientId: UUID_A,
      admissionId: UUID_B,
      providerEntityId: UUID_C,
      serviceFrom: "2026-07-01",
      serviceTo: "2026-07-31",
      kind: "combined", // not an m24_claim_kind value
    });
  });

  it("rejects an assemble body with a non-uuid patient or a malformed service date", () => {
    const base = {
      patientId: UUID_A,
      admissionId: UUID_B,
      providerEntityId: UUID_C,
      serviceFrom: "2026-07-01",
      serviceTo: "2026-07-31",
      kind: "hospice_only",
    };
    expectRejected(AssembleClaimBody, { ...base, patientId: "not-a-uuid" });
    expectRejected(AssembleClaimBody, { ...base, serviceFrom: "07/01/2026" });
    expectRejected(AssembleClaimBody, { ...base, patientId: undefined });
  });

  it("rejects unknown properties rather than passing them through to a service", () => {
    expectRejected(AssembleClaimBody, {
      patientId: UUID_A,
      admissionId: UUID_B,
      providerEntityId: UUID_C,
      serviceFrom: "2026-07-01",
      serviceTo: "2026-07-31",
      kind: "hospice_only",
      organizationId: UUID_A, // org binding is SERVER-side — a body must never carry one
    });
  });

  it("enforces the ≥40-character rationale on replace, void and terminate", () => {
    expect(parse(ReplaceClaimBody, { reason: REASON }).reason).toBe(REASON);
    expect(parse(TerminateRbArrangementBody, { reason: REASON }).reason).toBe(REASON);
    expectRejected(ReplaceClaimBody, { reason: "typo" });
    expectRejected(TerminateRbArrangementBody, { reason: "ended" });
    expectRejected(ReplaceClaimBody, {});
  });

  it("constrains the override body to an eligible role and a ≥40-character rationale", () => {
    const ok = parse(ApplyOverrideBody, {
      reason: REASON,
      overrideRoleClaimed: "compliance_officer",
    });
    expect(ok.overrideRoleClaimed).toBe("compliance_officer");
    expectRejected(ApplyOverrideBody, { reason: REASON, overrideRoleClaimed: "biller" });
    expectRejected(ApplyOverrideBody, { reason: "too short", overrideRoleClaimed: "org_admin" });
  });

  it("constrains the submit channel hint to a real m24_channel value", () => {
    expect(parse(SubmitClaimBody, {}).channelHint).toBeUndefined();
    expect(parse(SubmitClaimBody, { channelHint: "cco_clearinghouse" }).channelHint).toBe(
      "cco_clearinghouse",
    );
    expectRejected(SubmitClaimBody, { channelHint: "carrier_pigeon" });
  });

  it("refuses `billed` as a manual rb_day override — that status is system-set by claim assembly", () => {
    expect(
      parse(OverrideRbDayBody, { status: "excluded", exclusionReason: "NF discharge" }).status,
    ).toBe("excluded");
    expectRejected(OverrideRbDayBody, { status: "billed" });
  });

  it("keeps R&B percentages inside 0..100 and money as integer cents", () => {
    const base = {
      patientId: UUID_A,
      providerEntityId: UUID_B,
      nfFacilityMdmId: UUID_C,
      effectiveFrom: "2026-07-01",
      nfPerDiemRoutineCents: 21050,
      nfPerDiemRespCents: 24000,
      nfPerDiemGipCents: 80000,
      passThroughPct: 95,
      retentionPct: 5,
    };
    expect(parse(CreateRbArrangementBody, base).nfPerDiemRoutineCents).toBe(21050);
    expectRejected(CreateRbArrangementBody, { ...base, passThroughPct: 140 });
    // Fractional cents must be REFUSED, never coerced: `parse` deliberately skips Value.Convert so a
    // client bug cannot be silently rounded into a money bug (210.5 → 210).
    expectRejected(CreateRbArrangementBody, { ...base, nfPerDiemRoutineCents: 210.5 });
    expectRejected(CreateRbArrangementBody, { ...base, nfPerDiemRoutineCents: "21050" });
  });

  it("requires a two-letter service state on a trading-partner credential", () => {
    const base = {
      providerEntityId: UUID_A,
      serviceState: "OR",
      channel: "direct_mmis",
      tradingPartnerId: "TP-000123",
      activeFrom: "2026-07-01",
    };
    expect(parse(UpsertCredentialBody, base).serviceState).toBe("OR");
    expectRejected(UpsertCredentialBody, { ...base, serviceState: "Oregon" });
    expectRejected(UpsertCredentialBody, { ...base, serviceState: "or" });
  });
});

describe("M24 §4.2 request validation — queries", () => {
  it("converts query scalars, so a read path never hand-coerces a string again", () => {
    const q = parseQuery(ClaimListQuery, { state: "FAILED_VALIDATION", limit: "25" });
    expect(q.limit).toBe(25);
    expect(typeof q.limit).toBe("number");
    expect(q.state).toBe("FAILED_VALIDATION");
  });

  it("rejects an out-of-range limit and an unknown claim state filter", () => {
    expectQueryRejected(ClaimListQuery, { limit: "0" });
    expectQueryRejected(ClaimListQuery, { limit: "5000" });
    expectQueryRejected(ClaimListQuery, { state: "PENDING_SOMETHING" });
  });

  it("treats an absent worklist limit as optional and caps an explicit one", () => {
    expect(parseQuery(ValidationWorklistQuery, {}).limit).toBeUndefined();
    expect(parseQuery(ValidationWorklistQuery, { limit: "250" }).limit).toBe(250);
    expectQueryRejected(ValidationWorklistQuery, { limit: "9999" });
  });
});
