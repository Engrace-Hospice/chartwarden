import { COMMERCIAL_SEND_GATE_CODES as C } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  type ClaimSendGateInput,
  evaluateClaimSendGate,
  statusForReasons,
} from "./claim-send-gate";

const PASSING: ClaimSendGateInput = {
  claimState: "ready",
  hasLiveSubmission: false,
  validation: [
    { ruleKey: "plan_in_effect", blocking: false },
    { ruleKey: "authorization_on_file", blocking: false },
  ],
  clearinghouseKey: "stedi",
  routes: [{ clearinghousePayerId: "PAYER1", effectiveFrom: "2026-01-01", effectiveTo: null }],
  enrollments: [{ status: "enrolled", effectiveFrom: "2026-01-01", effectiveTo: null }],
  serviceDate: "2026-09-30",
  claimClearinghousePayerId: "PAYER1",
};

const codes = (input: ClaimSendGateInput): string[] => {
  const r = evaluateClaimSendGate(input);
  return r.ok ? [] : r.reasons.map((x) => x.code);
};

describe("evaluateClaimSendGate", () => {
  it("passes with the clearinghouse and payer id when nothing blocks", () => {
    expect(evaluateClaimSendGate(PASSING)).toEqual({
      ok: true,
      clearinghouseKey: "stedi",
      clearinghousePayerId: "PAYER1",
    });
  });

  it.each(["draft", "submitted", "ack_pending", "accepted", "rejected", "void"])(
    "reports only CLAIM_NOT_READY for a %s claim",
    (claimState) => {
      expect(
        codes({
          ...PASSING,
          claimState,
          clearinghouseKey: null,
          validation: [{ ruleKey: "x", blocking: true }],
        }),
      ).toEqual([C.CLAIM_NOT_READY]);
    },
  );

  it("reports a submission already in flight", () => {
    expect(codes({ ...PASSING, hasLiveSubmission: true })).toEqual([C.SUBMISSION_IN_FLIGHT]);
  });

  it("splits blocking validation into validation, authorization and eligibility reasons with rule keys", () => {
    const r = evaluateClaimSendGate({
      ...PASSING,
      validation: [
        { ruleKey: "service_days_covered", blocking: true },
        { ruleKey: "plan_in_effect", blocking: true },
        { ruleKey: "authorization_on_file", blocking: true },
        { ruleKey: "eligibility_freshness", blocking: true },
        { ruleKey: "cob_secondary_declared", blocking: false },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reasons.map((x) => x.code)).toEqual([
      C.VALIDATION_BLOCKED,
      C.AUTHORIZATION_NOT_SATISFIED,
      C.ELIGIBILITY_NOT_CURRENT,
    ]);
    expect(r.reasons[0]?.ruleKeys).toEqual(["plan_in_effect", "service_days_covered"]);
  });

  it("ignores a validation result that does not block (a covered override, an info finding)", () => {
    expect(
      codes({ ...PASSING, validation: [{ ruleKey: "eligibility_freshness", blocking: false }] }),
    ).toEqual([]);
  });

  it("refuses an unbound transport with CH_NOT_WIRED and a 503", () => {
    const r = evaluateClaimSendGate({ ...PASSING, clearinghouseKey: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reasons.map((x) => x.code)).toEqual([C.NOT_WIRED]);
    expect(statusForReasons(r.reasons)).toBe(503);
  });

  it("refuses when the plan has no route in effect for the clearinghouse", () => {
    expect(codes({ ...PASSING, routes: [] })).toEqual([C.PAYER_NOT_ROUTED]);
    expect(
      codes({
        ...PASSING,
        routes: [{ clearinghousePayerId: "P", effectiveFrom: "2026-10-01", effectiveTo: null }],
      }),
    ).toEqual([C.PAYER_NOT_ROUTED]);
  });

  it("refuses when the claim was built with a different payer id than the route now carries", () => {
    expect(codes({ ...PASSING, claimClearinghousePayerId: "OLD" })).toEqual([C.ROUTE_CHANGED]);
  });

  it.each(["not_enrolled", "pending", "suspended"] as const)(
    "refuses a %s provider entity",
    (status) => {
      const r = evaluateClaimSendGate({
        ...PASSING,
        enrollments: [{ status, effectiveFrom: "2026-01-01", effectiveTo: null }],
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reasons.map((x) => x.code)).toEqual([C.PROVIDER_NOT_ENROLLED]);
      expect(statusForReasons(r.reasons)).toBe(409);
    },
  );

  it("refuses an enrollment that ended before the service date", () => {
    expect(
      codes({
        ...PASSING,
        enrollments: [
          { status: "enrolled", effectiveFrom: "2026-01-01", effectiveTo: "2026-09-01" },
        ],
      }),
    ).toEqual([C.PROVIDER_NOT_ENROLLED]);
  });

  it("lists every reason in the fixed order", () => {
    expect(
      codes({
        ...PASSING,
        hasLiveSubmission: true,
        validation: [
          { ruleKey: "eligibility_freshness", blocking: true },
          { ruleKey: "authorization_on_file", blocking: true },
          { ruleKey: "plan_in_effect", blocking: true },
        ],
        enrollments: [],
      }),
    ).toEqual([
      C.SUBMISSION_IN_FLIGHT,
      C.VALIDATION_BLOCKED,
      C.AUTHORIZATION_NOT_SATISFIED,
      C.ELIGIBILITY_NOT_CURRENT,
      C.PROVIDER_NOT_ENROLLED,
    ]);
  });

  it("uses fixed messages with no interpolated values", () => {
    const r = evaluateClaimSendGate({
      ...PASSING,
      routes: [],
      claimClearinghousePayerId: "SECRETPAYER",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    for (const reason of r.reasons) expect(reason.message).not.toContain("SECRETPAYER");
  });
});
