// GAP-020 — the order-context safety gates the production administration write composes from the pure
// @wardenx/emar deciders. Pure (no database); the live proof is in m13-emar-write.live.test.ts.
import { evaluateBarcodeScan } from "@wardenx/emar";
import { describe, expect, it } from "vitest";
import {
  type EmarAbacResolver,
  buildEmarAbacPredicates,
} from "../src/modules/13-emar/abac-predicates";
import {
  assertOrderFiveRights,
  barcodeContextsOf,
} from "../src/modules/13-emar/administration-safety-gates";

const NOW = "2026-10-08T12:00:00.000Z";
const order = {
  patientId: "pat-1",
  route: "oral",
  allowAdministration: true,
  doseAmount: 5,
  doseUnit: "mg",
  rxnormRxcui: "rx-morphine",
  ndc: "ndc-morphine",
  patientWristbandPayloadDigest: "digest-pat-1",
};
const run = (over: Record<string, unknown> = {}, orderOver: Record<string, unknown> = {}) =>
  assertOrderFiveRights({
    order: { ...order, ...orderOver },
    medicationOrderId: "ord-1",
    patientId: "pat-1",
    given: { route: "oral", doseAmount: 5, doseUnit: "mg" },
    administeredAt: NOW,
    nowIso: NOW,
    discreteDose: true,
    ...over,
  });

describe("assertOrderFiveRights", () => {
  it("passes an on-order administration, a partial dose and a past (late-entry) instant", () => {
    expect(() => run()).not.toThrow();
    expect(() => run({ given: { route: "oral", doseAmount: 2.5, doseUnit: "mg" } })).not.toThrow();
    expect(() => run({ administeredAt: "2026-10-07T12:00:00.000Z" })).not.toThrow();
  });

  it("refuses a wrong route, an over-dose, a wrong unit and a future instant with FIVE_RIGHTS_VIOLATION", () => {
    const violation = expect.objectContaining({ code: "FIVE_RIGHTS_VIOLATION", statusCode: 422 });
    expect(() => run({ given: { route: "IM", doseAmount: 5, doseUnit: "mg" } })).toThrow(violation);
    expect(() => run({ given: { route: "oral", doseAmount: 50, doseUnit: "mg" } })).toThrow(
      violation,
    );
    expect(() => run({ given: { route: "oral", doseAmount: 5, doseUnit: "mcg" } })).toThrow(
      violation,
    );
    expect(() => run({ administeredAt: "2026-10-08T13:00:00.000Z" })).toThrow(violation);
  });

  it("an absent route is not a wrong route", () => {
    expect(() => run({ given: { doseAmount: 5, doseUnit: "mg" } })).not.toThrow();
  });

  it("refuses an administration that omits the dose or unit when the order states a discrete dose", () => {
    const violation = expect.objectContaining({ code: "FIVE_RIGHTS_VIOLATION", statusCode: 422 });
    expect(() => run({ given: {} })).toThrow(violation);
    expect(() => run({ given: { route: "oral", doseUnit: "mg" } })).toThrow(violation);
    expect(() => run({ given: { route: "oral", doseAmount: 5 } })).toThrow(violation);
  });

  it("a continuous infusion has no per-administration dose to compare", () => {
    expect(() =>
      run(
        { discreteDose: false, given: { route: "iv", doseAmount: 999, doseUnit: "mg" } },
        { route: "iv" },
      ),
    ).not.toThrow();
  });

  it("does not check the dose when the order states none (unknown is not zero)", () => {
    expect(() =>
      run(
        { given: { route: "oral", doseAmount: 999, doseUnit: "mg" } },
        { doseAmount: null, doseUnit: null },
      ),
    ).not.toThrow();
  });
});

describe("barcodeContextsOf — wrong_drug is reachable now that the scan meets the real order", () => {
  const asOf = "2026-10-08";

  it("a scan of a different RxCUI is wrong_drug; the order's own is a match", () => {
    const ctx = barcodeContextsOf(order);
    expect(
      evaluateBarcodeScan({ scannedRxnormRxcui: "rx-other" }, ctx.order, ctx.patient, asOf),
    ).toBe("wrong_drug");
    expect(
      evaluateBarcodeScan({ scannedRxnormRxcui: "rx-morphine" }, ctx.order, ctx.patient, asOf),
    ).toBe("match");
  });

  it("a wristband that disagrees with the one on file is wrong_patient; a blocked order has no active order", () => {
    const ctx = barcodeContextsOf(order);
    expect(
      evaluateBarcodeScan(
        { patientWristbandPayloadDigest: "someone-else" },
        ctx.order,
        ctx.patient,
        asOf,
      ),
    ).toBe("wrong_patient");
    const noDigest = barcodeContextsOf({ ...order, patientWristbandPayloadDigest: null });
    expect(
      evaluateBarcodeScan(
        { patientWristbandPayloadDigest: "digest-pat-1" },
        noDigest.order,
        noDigest.patient,
        asOf,
      ),
    ).toBe("wrong_patient");
    const blocked = barcodeContextsOf({ ...order, allowAdministration: false });
    expect(evaluateBarcodeScan({}, blocked.order, blocked.patient, asOf)).toBe("no_order_active");
  });
});

describe("administering_clinician_eligible on the dose-keyed intentional-hold route (GAP-024)", () => {
  const resolver = (over: Partial<EmarAbacResolver> = {}): EmarAbacResolver => ({
    loadWitnessFacts: async () => null,
    loadCaregiverReviewFacts: async () => null,
    loadWorksheetTriggerKind: async () => null,
    loadScopePatientId: async () => null,
    loadOrderMedClass: async (_org, orderId) => (orderId === "ord-1" ? "standard" : null),
    loadScheduledDoseOrderId: async (_org, doseId) => (doseId === "dose-1" ? "ord-1" : null),
    ...over,
  });
  const ctx = (roles: string[]) =>
    ({ organizationId: "org", userId: "u", roles, attributes: {} }) as never;
  const predicate = (r: EmarAbacResolver) =>
    buildEmarAbacPredicates({ resolver: r, isInCaseload: async () => true })
      .administering_clinician_eligible!;

  it("resolves the order's class through the scheduled dose and applies the discipline matrix", async () => {
    const p = predicate(resolver());
    expect(await p(ctx(["rn"]), { scheduledDoseId: "dose-1" })).toBe(true);
    expect(await p(ctx(["office_admin"]), { scheduledDoseId: "dose-1" })).toBe(false);
  });

  it("denies (fail-closed) when the dose or its order does not resolve, or no resolver arm exists", async () => {
    const p = predicate(resolver());
    expect(await p(ctx(["rn"]), { scheduledDoseId: "unknown" })).toBe(false);
    expect(await p(ctx(["rn"]), {})).toBe(false);
    const legacy = predicate(resolver({ loadScheduledDoseOrderId: undefined }));
    expect(await legacy(ctx(["rn"]), { scheduledDoseId: "dose-1" })).toBe(false);
  });
});
