// GAP-037 — contract tests for the live DoseSpot v2 HTTP adapter against a RECORDED FAKE TRANSPORT.
// The fake is scripted from the public v2 swagger (paths, `Result` envelope, `IdentifierResponse`, the send body,
// the `Prescription.Status` enum). It proves OUR behaviour — fail-closed config, token handling, error
// classification, backoff, breaker, idempotent NewRx — not that DoseSpot accepts our field names (that is the
// sandbox verification recorded in docs/history).
import { describe, expect, it } from "vitest";
import {
  DegradedError,
  type DoseSpotFetch,
  type DoseSpotTenantConfigResolver,
  createEnvTenantConfigResolver,
  createHttpDoseSpotClient,
  createUnboundTenantConfigResolver,
  parseTenantConfig,
  phaseOfStatus,
  unverifiedEndpoints,
} from "../src";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const CONFIG_JSON = JSON.stringify({
  [ORG]: {
    baseUrl: "https://my.staging.dosespot.com/webapi/v2/",
    subscriptionKey: "sub-key",
    clinicId: "clinic-1",
    clinicKey: "clinic-key-secret",
    serviceClinicianId: "900",
  },
});
const resolver = (): DoseSpotTenantConfigResolver =>
  createEnvTenantConfigResolver({ DOSESPOT_TENANT_CONFIGS: CONFIG_JSON });

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}
type Responder = (req: Recorded, n: number) => { status: number; body?: unknown } | "network";

function fakeTransport(routes: Record<string, Responder>) {
  const calls: Recorded[] = [];
  const counts = new Map<string, number>();
  const fetchImpl: DoseSpotFetch = async (url, init) => {
    const u = new URL(url);
    const req: Recorded = {
      url,
      method: init.method,
      headers: { ...init.headers },
      body: init.body,
    };
    calls.push(req);
    const key = `${init.method} ${u.pathname.replace("/webapi/v2", "")}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const route = routes[key];
    if (!route) return { status: 404, text: async () => "" };
    const out = route(req, n);
    if (out === "network") throw new Error("ECONNRESET");
    return {
      status: out.status,
      text: async () => (out.body === undefined ? "" : JSON.stringify(out.body)),
    };
  };
  return { fetchImpl, calls };
}

const TOKEN_OK: Responder = () => ({
  status: 200,
  body: { access_token: "tok-1", expires_in: 3600 },
});
const NEWRX = {
  medicationOrderId: "mo-1",
  dosespotPatientId: "501",
  dosespotPrescriberId: "700",
  rxnormRxcui: "197361",
  strength: "5 mg",
  sigStructured: {
    doseQuantity: 1,
    doseUnit: "tablet",
    route: "oral",
    frequencyCode: "BID",
    asNeeded: false,
  },
  quantity: 30,
  daysSupply: 15,
  refillsAuthorized: 0,
};

function client(routes: Record<string, Responder>, extra: { sleeps?: number[] } = {}) {
  const t = fakeTransport(routes);
  const edges: string[] = [];
  const c = createHttpDoseSpotClient({
    resolver: resolver(),
    fetch: t.fetchImpl,
    now: () => new Date("2026-10-06T12:00:00.000Z"),
    sleep: async (ms) => {
      extra.sleeps?.push(ms);
    },
    newCorrelationId: () => "00000000-0000-4000-8000-0000000000aa",
    onBreakerEdge: (e) => edges.push(e.edge),
  });
  return { c, calls: t.calls, edges };
}

describe("tenant configuration is fail-closed", () => {
  it("is unbound without the env var, with malformed JSON, and for http:// or incomplete entries", () => {
    expect(createEnvTenantConfigResolver({}).isConfigured()).toBe(false);
    expect(createEnvTenantConfigResolver({ DOSESPOT_TENANT_CONFIGS: "{nope" }).isConfigured()).toBe(
      false,
    );
    expect(
      parseTenantConfig({
        baseUrl: "http://x",
        subscriptionKey: "a",
        clinicId: "b",
        clinicKey: "c",
        serviceClinicianId: "d",
      }),
    ).toBeNull();
    expect(
      parseTenantConfig({
        baseUrl: "https://x",
        subscriptionKey: "a",
        clinicId: "b",
        clinicKey: "c",
      }),
    ).toBeNull();
    expect(createUnboundTenantConfigResolver().configFor(ORG)).toBeNull();
  });

  it("knows exactly which tenants are configured and trims the base URL", () => {
    const r = resolver();
    expect(r.isConfiguredFor(ORG)).toBe(true);
    expect(r.isConfiguredFor(OTHER_ORG)).toBe(false);
    expect(r.configFor(ORG)?.baseUrl).toBe("https://my.staging.dosespot.com/webapi/v2");
  });

  it("rejects every call for an unconfigured tenant without touching the network", async () => {
    const { c, calls } = client({});
    const err = await c.transmitNewRx(OTHER_ORG, NEWRX, "k").catch((e) => e);
    expect(err).toBeInstanceOf(DegradedError);
    expect(err.retryable).toBe(false);
    await expect(c.upsertPatient(OTHER_ORG, {} as never, "k")).rejects.toBeInstanceOf(
      DegradedError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("token handling", () => {
  it("mints with Basic clinicId:clinicKey + Subscription-Key, caches, and sends Bearer", async () => {
    const { c, calls } = client({
      "POST /connect/token": TOKEN_OK,
      "GET /api/patients/501/prescriptions": () => ({
        status: 200,
        body: { Items: [{ PrescriptionId: 77, Status: "eRxSent" }], Result: { ResultCode: "OK" } },
      }),
    });
    await c.getPrescriptionStatus(ORG, "501", "77");
    await c.getPrescriptionStatus(ORG, "501", "77");
    const tokenCalls = calls.filter((x) => x.url.endsWith("/connect/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.headers.Authorization).toBe(
      `Basic ${Buffer.from("clinic-1:clinic-key-secret").toString("base64")}`,
    );
    expect(tokenCalls[0]?.headers["Subscription-Key"]).toBe("sub-key");
    const form = new URLSearchParams(tokenCalls[0]?.body);
    expect(form.get("grant_type")).toBe("password");
    expect(form.get("Username")).toBe("900");
    const api = calls.filter((x) => x.url.includes("/api/"));
    expect(api[0]?.headers.Authorization).toBe("Bearer tok-1");
    expect(api[0]?.headers["Subscription-Key"]).toBe("sub-key");
  });

  it("re-mints once on a 401 and then succeeds", async () => {
    let n = 0;
    const { c, calls } = client({
      "POST /connect/token": () => ({
        status: 200,
        body: { access_token: `tok-${++n}`, expires_in: 3600 },
      }),
      "GET /api/patients/501/prescriptions": (_r, i) =>
        i === 1
          ? { status: 401 }
          : { status: 200, body: { Items: [{ PrescriptionId: 77, Status: "Sending" }] } },
    });
    const out = await c.getPrescriptionStatus(ORG, "501", "77");
    expect(out.phase).toBe("pending");
    expect(calls.filter((x) => x.url.endsWith("/connect/token"))).toHaveLength(2);
  });

  it("treats a token-endpoint rejection as a permanent, credential-class failure", async () => {
    const { c } = client({ "POST /connect/token": () => ({ status: 401 }) });
    const err = await c.getPrescriptionStatus(ORG, "501", "77").catch((e) => e);
    expect(err).toBeInstanceOf(DegradedError);
    expect(err.retryable).toBe(false);
    expect(err.customerMessage).toContain("clinic credentials");
  });
});

describe("transmitNewRx", () => {
  const routes = (sendBody: unknown): Record<string, Responder> => ({
    "POST /connect/token": TOKEN_OK,
    "POST /api/patients/501/prescriptions/coded": () => ({ status: 200, body: { Id: 9001 } }),
    "POST /api/patients/501/prescriptions/send": () => ({ status: 200, body: sendBody }),
  });

  it("creates then sends, as the prescriber's own clinician, and returns the vendor prescription id", async () => {
    const { c, calls } = client(routes([{ Id: 9001 }]));
    const out = await c.transmitNewRx(ORG, NEWRX, "idem-1");
    expect(out.dosespotPrescriptionId).toBe("9001");
    const send = calls.find((x) => x.url.endsWith("/prescriptions/send"));
    expect(JSON.parse(send?.body ?? "{}")).toEqual({ prescriptionIds: [9001] });
    expect(send?.headers["Idempotency-Key"]).toBe("idem-1");
    const token = calls.find((x) => x.url.endsWith("/connect/token"));
    expect(new URLSearchParams(token?.body).get("Username")).toBe("700");
    const coded = calls.find((x) => x.url.endsWith("/prescriptions/coded"));
    expect(JSON.parse(coded?.body ?? "{}")).toMatchObject({
      Rxcui: "197361",
      DaysSupply: 15,
      Directions: "Take 1 tablet oral BID",
    });
  });

  it("never reports success when the send response does not confirm the prescription", async () => {
    const { c } = client(routes([]));
    const err = await c.transmitNewRx(ORG, NEWRX, "idem-2").catch((e) => e);
    expect(err).toBeInstanceOf(DegradedError);
    expect(err.retryable).toBe(true);
  });

  it("retries the SEND (not a second create) after a failed send with the same idempotency key", async () => {
    let sends = 0;
    const r = routes([{ Id: 9001 }]);
    r["POST /api/patients/501/prescriptions/send"] = () => {
      sends += 1;
      return sends === 1 ? { status: 400 } : { status: 200, body: [{ Id: 9001 }] };
    };
    const { c, calls } = client(r);
    await expect(c.transmitNewRx(ORG, NEWRX, "idem-3")).rejects.toBeInstanceOf(DegradedError);
    const out = await c.transmitNewRx(ORG, NEWRX, "idem-3");
    expect(out.dosespotPrescriptionId).toBe("9001");
    expect(calls.filter((x) => x.url.endsWith("/prescriptions/coded"))).toHaveLength(1);
  });

  it("refuses a controlled substance for a tenant that is not EPCS-certified, before any request", async () => {
    const { c, calls } = client(routes([{ Id: 9001 }]));
    const err = await c
      .transmitNewRx(ORG, { ...NEWRX, deaSchedule: "II" }, "idem-4")
      .catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.customerMessage).toContain("EPCS_NOT_CERTIFIED");
    expect(calls).toHaveLength(0);
  });

  it("surfaces a Result.ResultCode=ERROR body as a permanent failure", async () => {
    const r = routes([{ Id: 9001 }]);
    r["POST /api/patients/501/prescriptions/coded"] = () => ({
      status: 200,
      body: { Result: { ResultCode: "ERROR", ResultDescription: "bad rxcui" } },
    });
    const { c } = client(r);
    const err = await c.transmitNewRx(ORG, NEWRX, "idem-5").catch((e) => e);
    expect(err.retryable).toBe(false);
  });
});

describe("error classification, backoff and the breaker", () => {
  it("retries 5xx with 250/500 ms backoff, then degrades as retryable", async () => {
    const sleeps: number[] = [];
    const { c, calls } = client(
      {
        "POST /connect/token": TOKEN_OK,
        "GET /api/patients/501/prescriptions": () => ({ status: 503 }),
      },
      { sleeps },
    );
    const err = await c.getPrescriptionStatus(ORG, "501", "77").catch((e) => e);
    expect(err.retryable).toBe(true);
    expect(sleeps).toEqual([250, 500]);
    expect(calls.filter((x) => x.url.includes("/api/"))).toHaveLength(3);
  });

  it("classifies a network failure as retryable and a 4xx (not 429) as permanent without retrying", async () => {
    const net = client({
      "POST /connect/token": TOKEN_OK,
      "GET /api/patients/501/prescriptions": () => "network",
    });
    expect((await net.c.getPrescriptionStatus(ORG, "501", "77").catch((e) => e)).retryable).toBe(
      true,
    );
    const bad = client({
      "POST /connect/token": TOKEN_OK,
      "GET /api/patients/501/prescriptions": () => ({ status: 422 }),
    });
    expect((await bad.c.getPrescriptionStatus(ORG, "501", "77").catch((e) => e)).retryable).toBe(
      false,
    );
    expect(bad.calls.filter((x) => x.url.includes("/api/"))).toHaveLength(1);
  });

  it("opens the breaker after repeated exhausted calls, fails fast, and reports the opened edge", async () => {
    const { c, calls, edges } = client({
      "POST /connect/token": TOKEN_OK,
      "GET /api/patients/501/prescriptions": () => ({ status: 500 }),
    });
    for (let i = 0; i < 5; i += 1)
      await c.getPrescriptionStatus(ORG, "501", "77").catch(() => undefined);
    expect(edges).toEqual(["opened"]);
    const before = calls.length;
    const err = await c.getPrescriptionStatus(ORG, "501", "77").catch((e) => e);
    expect(err.retryable).toBe(true);
    expect(calls.length).toBe(before); // fast-fail: no wire traffic while open
  });
});

describe("other operations", () => {
  it("creates a patient, or edits when the DoseSpot id is already known", async () => {
    const { c, calls } = client({
      "POST /connect/token": TOKEN_OK,
      "POST /api/patients": () => ({ status: 200, body: { Id: 501 } }),
      "PUT /api/patients/501": () => ({ status: 200, body: { Id: 501 } }),
    });
    const base = {
      chartwardenPatientId: "p1",
      firstName: "A",
      lastName: "B",
      dateOfBirth: "1940-01-01",
      gender: "female",
      address: { line1: "1 Main", city: "X", state: "OR", postalCode: "97201" },
      active: true,
    };
    expect((await c.upsertPatient(ORG, base, "k1")).dosespotPatientId).toBe("501");
    expect(
      (await c.upsertPatient(ORG, { ...base, existingDosespotPatientId: "501" }, "k2"))
        .dosespotPatientId,
    ).toBe("501");
    expect(calls.some((x) => x.method === "PUT")).toBe(true);
  });

  it("maps medication history tolerantly and invents nothing", async () => {
    const { c } = client({
      "POST /connect/token": TOKEN_OK,
      "GET /api/patients/501/medications/history": () => ({
        status: 200,
        body: { Items: [{ DisplayName: "Morphine 5 mg", Rxcui: "197361" }, { Junk: 1 }] },
      }),
    });
    const out = await c.pullMedicationHistory(ORG, { dosespotPatientId: "501" });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      drugName: "Morphine 5 mg",
      rxnormRxcui: "197361",
      lastFillDate: null,
    });
  });

  it("fails closed (non-retryable) on operations with no verified endpoint", async () => {
    const { c, calls } = client({ "POST /connect/token": TOKEN_OK });
    for (const op of [
      () => c.lookupRxBenefit(ORG, { dosespotPatientId: "1", rxnormRxcui: "2" }),
      () => c.respondToRefillRequest(ORG, "r", { decision: "denied" }),
      () => c.revokePrescriber(ORG, "700"),
      () => c.initiateEpcsSigningSession(ORG, "700", "mo"),
    ]) {
      const err = await op().catch((e) => e);
      expect(err).toBeInstanceOf(DegradedError);
      expect(err.retryable).toBe(false);
      expect(err.customerMessage).toContain("sandbox verification");
    }
    expect(calls).toHaveLength(0);
  });

  it("normalises the swagger status enum and lists the unverified endpoints", () => {
    expect(phaseOfStatus("eRxSent")).toBe("sent");
    expect(phaseOfStatus("PharmacyVerified")).toBe("sent");
    expect(phaseOfStatus("Error")).toBe("failed");
    expect(phaseOfStatus("PharmacySelect")).toBe("needs_pharmacy");
    expect(phaseOfStatus("Sending")).toBe("pending");
    expect(unverifiedEndpoints()).toContain("token:sandbox");
    expect(unverifiedEndpoints()).toContain("lookupRxBenefit:none");
  });
});
