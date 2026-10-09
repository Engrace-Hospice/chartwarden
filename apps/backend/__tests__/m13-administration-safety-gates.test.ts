// GAP-020 — the order-context safety gates the production administration write composes from the pure
// @wardenx/emar deciders. Pure (no database); the live proof is in m13-emar-write.live.test.ts.
import { evaluateBarcodeScan } from "@wardenx/emar";
import type { PatientWristbandVerifier, WristbandVerdict } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  type EmarAbacResolver,
  buildEmarAbacPredicates,
} from "../src/modules/13-emar/abac-predicates";
import {
  assertOrderFiveRights,
  barcodeContextsOf,
  verifyBedsideWristband,
  wristbandRefusalDetails,
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

const VERIFIED: WristbandVerdict = {
  status: "verified",
  generation: 2,
  scannedDigest: "d".repeat(64),
  matchedPatientId: null,
};
const verdictOf = (status: WristbandVerdict["status"]): WristbandVerdict => ({
  ...VERIFIED,
  status,
  matchedPatientId: status === "mismatch" ? "pat-other" : null,
});
const verifierReturning = (v: WristbandVerdict) => {
  const calls: Parameters<PatientWristbandVerifier["verify"]>[0][] = [];
  const verifier: PatientWristbandVerifier = {
    async verify(input) {
      calls.push(input);
      return v;
    },
  };
  return { verifier, calls };
};
const SCAN = { scannedRxnormRxcui: "rx-morphine", patientWristbandPayload: "WXB1.PAYLOAD" };

describe("barcodeContextsOf — wrong_drug is reachable now that the scan meets the real order", () => {
  const asOf = "2026-10-08";
  const verified = { required: true, status: "verified" as const };

  it("a scan of a different RxCUI is wrong_drug; the order's own is a match", () => {
    const ctx = barcodeContextsOf(order, verified);
    expect(
      evaluateBarcodeScan({ scannedRxnormRxcui: "rx-other" }, ctx.order, ctx.patient, asOf),
    ).toBe("wrong_drug");
    expect(
      evaluateBarcodeScan({ scannedRxnormRxcui: "rx-morphine" }, ctx.order, ctx.patient, asOf),
    ).toBe("match");
  });

  it("an unverified wristband is wrong_patient; a blocked order has no active order", () => {
    const ctx = barcodeContextsOf(order, { required: true, status: "mismatch" });
    expect(evaluateBarcodeScan({}, ctx.order, ctx.patient, asOf)).toBe("wrong_patient");
    const blocked = barcodeContextsOf({ ...order, allowAdministration: false }, verified);
    expect(evaluateBarcodeScan({}, blocked.order, blocked.patient, asOf)).toBe("no_order_active");
  });
});

describe("verifyBedsideWristband (GAP-020) — the one orchestration both write paths share", () => {
  const base = {
    organizationId: "org-1",
    patientId: "pat-1",
    nowIso: NOW,
    mode: "online" as const,
  };

  it("asks M5 with the RAW payload, the patient from the ORDER and SERVER time online", async () => {
    const { verifier, calls } = verifierReturning(VERIFIED);
    const r = await verifyBedsideWristband({
      ...base,
      verifier,
      scan: { ...SCAN, wristbandScannedAt: "2020-01-01T00:00:00.000Z" },
      required: true,
    });
    expect(calls).toEqual([
      {
        organizationId: "org-1",
        patientId: "pat-1",
        payload: "WXB1.PAYLOAD",
        asOf: NOW,
        mode: "online",
      },
    ]);
    expect(r.context).toEqual({ wristband: { required: true, status: "verified" } });
    expect(r.check).toBe("verified");
    expect(r.asOf).toBe(NOW);
  });

  it.each([
    "mismatch",
    "not_presented",
    "not_on_file",
    "superseded",
    "voided",
    "malformed",
  ] as const)("maps a %s verdict into the pure context", async (status) => {
    const { verifier } = verifierReturning(verdictOf(status));
    const r = await verifyBedsideWristband({ ...base, verifier, scan: SCAN, required: true });
    expect(r.context.wristband).toEqual({ required: true, status });
    expect(r.check).toBe(status);
  });

  it("offline: the device scan time is used but clamped to <= now, falling back to the capture time", async () => {
    const { verifier, calls } = verifierReturning(VERIFIED);
    const off = { ...base, verifier, required: true, mode: "offline_sync" as const };
    await verifyBedsideWristband({
      ...off,
      scan: { ...SCAN, wristbandScannedAt: "2026-10-08T09:00:00.000Z" },
    });
    await verifyBedsideWristband({
      ...off,
      scan: { ...SCAN, wristbandScannedAt: "2030-01-01T00:00:00.000Z" },
    });
    await verifyBedsideWristband({
      ...off,
      scan: SCAN,
      capturedAt: "2026-10-08T08:00:00.000Z",
    });
    expect(calls.map((c) => c.asOf)).toEqual([
      "2026-10-08T09:00:00.000Z",
      NOW,
      "2026-10-08T08:00:00.000Z",
    ]);
    expect(calls.every((c) => c.mode === "offline_sync")).toBe(true);
  });

  it("policy off + no band presented: M5 is not asked and the scan records skipped_policy_off", async () => {
    const { verifier, calls } = verifierReturning(verdictOf("mismatch"));
    const r = await verifyBedsideWristband({
      ...base,
      verifier,
      scan: { scannedRxnormRxcui: "rx-morphine" },
      required: false,
    });
    expect(calls).toEqual([]);
    expect(r.context.wristband).toEqual({ required: false, status: "not_presented" });
    expect(r.check).toBe("skipped_policy_off");
    expect(r.verdict.scannedDigest).toBeNull();
  });

  it("policy off but a band WAS presented: M5 is still asked and a contradiction still counts", async () => {
    const { verifier, calls } = verifierReturning(verdictOf("mismatch"));
    const r = await verifyBedsideWristband({ ...base, verifier, scan: SCAN, required: false });
    expect(calls).toHaveLength(1);
    expect(r.context.wristband).toEqual({ required: false, status: "mismatch" });
  });

  it("a blank payload is 'no band presented', not an empty-string token", async () => {
    const { verifier, calls } = verifierReturning(verdictOf("not_presented"));
    await verifyBedsideWristband({
      ...base,
      verifier,
      scan: { ...SCAN, patientWristbandPayload: "   " },
      required: true,
    });
    expect(calls[0]?.payload).toBeNull();
  });

  it("a verifier that throws (deny-stub / outage) refuses with a 503 and never reads as verified", async () => {
    const verifier: PatientWristbandVerifier = {
      async verify() {
        throw new Error("boom: connection string postgres://secret");
      },
    };
    const err = await verifyBedsideWristband({
      ...base,
      verifier,
      scan: SCAN,
      required: true,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "WRISTBAND_VERIFIER_UNAVAILABLE", statusCode: 503 });
    expect(String((err as Error).message)).not.toContain("postgres://");
  });
});

describe("wristbandRefusalDetails", () => {
  it("names the machine reason so the UI can say what to do", () => {
    expect(wristbandRefusalDetails("not_on_file")).toEqual([
      expect.objectContaining({
        field: "barcodeScan.patientWristbandPayload",
        code: "WRISTBAND_NOT_ON_FILE",
      }),
    ]);
    expect(wristbandRefusalDetails("superseded")[0]?.code).toBe("WRISTBAND_SUPERSEDED");
    expect(wristbandRefusalDetails("mismatch")[0]?.code).toBe("WRISTBAND_MISMATCH");
    expect(wristbandRefusalDetails("verified")).toEqual([]);
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
