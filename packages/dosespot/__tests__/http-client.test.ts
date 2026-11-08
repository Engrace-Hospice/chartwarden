// GAP-037 — contract tests for the live DoseSpot v2 HTTP adapter against a RECORDED FAKE TRANSPORT.
// The fake is scripted from the public v2 swagger (paths, `Result` envelope, `IdentifierResponse`, the send body,
// the `Prescription.Status` enum). It proves OUR behaviour — fail-closed config, token handling, error
// classification, backoff, breaker, idempotent NewRx — not that DoseSpot accepts our field names (that is the
// sandbox verification recorded in docs/history).
import { describe, expect, it } from "vitest";
import {
  ConfigUnavailableError,
  DegradedError,
  type DoseSpotFetch,
  type DoseSpotTenantConfig,
  type DoseSpotTenantConfigResolver,
  NotEnabledError,
  UnconfirmedOutcomeError,
  createEnvTenantConfigResolver,
  createHttpDoseSpotClient,
  createUnboundTenantConfigResolver,
  isConfigUnavailableError,
  isNotEnabledError,
  isUnconfirmedOutcomeError,
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
type Responder = (
  req: Recorded,
  n: number,
) => { status: number; body?: unknown; text?: string } | "network" | "timeout" | "refused" | "refused-bun";

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
    if (out === "timeout") throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (out === "refused")
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    // Bun's shape: the code is on the error itself, no `cause`
    if (out === "refused-bun")
      throw Object.assign(new TypeError("ECONNREFUSED: Unable to connect"), { code: "ECONNREFUSED" });
    return {
      status: out.status,
      text: async () => out.text ?? (out.body === undefined ? "" : JSON.stringify(out.body)),
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
  it("is unbound without the env var, with malformed JSON, and for http:// or incomplete entries", async () => {
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
    expect(await createUnboundTenantConfigResolver().configFor(ORG)).toBeNull();
  });

  it("knows exactly which tenants are configured and trims the base URL", async () => {
    const r = resolver();
    expect(await r.isConfiguredFor(ORG)).toBe(true);
    expect(await r.isConfiguredFor(OTHER_ORG)).toBe(false);
    expect((await r.configFor(ORG))?.baseUrl).toBe("https://my.staging.dosespot.com/webapi/v2");
  });

  it("rejects every call for an unconfigured tenant without touching the network", async () => {
    const { c, calls } = client({});
    const err = await c.transmitNewRx(OTHER_ORG, NEWRX, "k").catch((e) => e);
    expect(err).toBeInstanceOf(DegradedError);
    expect(err).toBeInstanceOf(NotEnabledError); // a worker holding queued work treats this as a pause, not a rejection
    expect(isNotEnabledError(err)).toBe(true);
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

  it("never follows a redirect on any request (the token body holds the clinic key, the headers the Subscription-Key)", async () => {
    const seen: (string | undefined)[] = [];
    const fetchImpl: DoseSpotFetch = async (url, init) => {
      seen.push(init.redirect);
      return url.endsWith("/connect/token")
        ? { status: 200, text: async () => JSON.stringify({ access_token: "t", expires_in: 3600 }) }
        : {
            status: 200,
            text: async () =>
              JSON.stringify({ Items: [{ PrescriptionId: 77, Status: "eRxSent" }] }),
          };
    };
    const c = createHttpDoseSpotClient({
      resolver: resolver(),
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    await c.getPrescriptionStatus(ORG, "501", "77");
    expect(seen).toHaveLength(2);
    expect(seen.every((r) => r === "error")).toBe(true);
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

describe("a database-backed resolver (slice 4)", () => {
  const cfg = (
    version: number,
    over: Partial<DoseSpotTenantConfig> = {},
  ): DoseSpotTenantConfig => ({
    baseUrl: "https://my.staging.dosespot.com/webapi/v2",
    subscriptionKey: "sub-key",
    clinicId: "clinic-1",
    clinicKey: `key-v${version}`,
    serviceClinicianId: "900",
    epcsCertified: false,
    version,
    ...over,
  });

  /** A resolver whose answer the test swaps, and which records the purpose each call asked for. */
  function swappable(initial: DoseSpotTenantConfig | null) {
    let current = initial;
    const purposes: string[] = [];
    const r: DoseSpotTenantConfigResolver = {
      isConfigured: () => current !== null,
      isConfiguredFor: async () => current !== null,
      configFor: async (_org, purpose = "operate") => {
        purposes.push(purpose);
        return current;
      },
      configuredOrganizationIds: () => [],
    };
    return {
      r,
      set: (c: DoseSpotTenantConfig | null) => {
        current = c;
      },
      purposes,
    };
  }

  function clientOver(r: DoseSpotTenantConfigResolver, routes: Record<string, Responder>) {
    const t = fakeTransport(routes);
    const c = createHttpDoseSpotClient({
      resolver: r,
      fetch: t.fetchImpl,
      now: () => new Date("2026-10-06T12:00:00.000Z"),
      sleep: async () => undefined,
      newCorrelationId: () => "00000000-0000-4000-8000-0000000000aa",
    });
    return { c, calls: t.calls };
  }

  const STATUS_OK: Responder = () => ({
    status: 200,
    body: { Items: [{ PrescriptionId: 77, Status: "eRxSent" }] },
  });

  it("awaits the resolver on every call, so a deactivation takes effect on the very next call", async () => {
    const s = swappable(cfg(1));
    const { c, calls } = clientOver(s.r, {
      "POST /connect/token": TOKEN_OK,
      "GET /api/patients/501/prescriptions": STATUS_OK,
    });
    await c.getPrescriptionStatus(ORG, "501", "77");
    s.set(null);
    const err = await c.getPrescriptionStatus(ORG, "501", "77").catch((e) => e);
    expect(err).toBeInstanceOf(DegradedError);
    expect(err.retryable).toBe(false);
    expect(calls.filter((x) => x.url.includes("/api/"))).toHaveLength(1);
  });

  it("a rotated credential (a new config version) never reuses the old token", async () => {
    const s = swappable(cfg(1));
    let n = 0;
    const { c, calls } = clientOver(s.r, {
      "POST /connect/token": () => ({
        status: 200,
        body: { access_token: `tok-${++n}`, expires_in: 3600 },
      }),
      "GET /api/patients/501/prescriptions": STATUS_OK,
    });
    await c.getPrescriptionStatus(ORG, "501", "77");
    await c.getPrescriptionStatus(ORG, "501", "77");
    expect(calls.filter((x) => x.url.endsWith("/connect/token"))).toHaveLength(1);
    s.set(cfg(2));
    await c.getPrescriptionStatus(ORG, "501", "77");
    const tokenCalls = calls.filter((x) => x.url.endsWith("/connect/token"));
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls[1]?.headers.Authorization).toBe(
      `Basic ${Buffer.from("clinic-1:key-v2").toString("base64")}`,
    );
    const api = calls.filter((x) => x.url.includes("/api/"));
    expect(api[api.length - 1]?.headers.Authorization).toBe("Bearer tok-2");
  });

  it("enrols a prescriber under the 'setup' purpose (a verified config), every other call under 'operate'", async () => {
    const s = swappable(cfg(1));
    const { c } = clientOver(s.r, {
      "POST /connect/token": TOKEN_OK,
      "POST /api/clinicians": () => ({ status: 200, body: { Id: 700 } }),
      "GET /api/patients/501/prescriptions": STATUS_OK,
    });
    await c.enrollPrescriber(ORG, {
      membershipId: "m1",
      firstName: "A",
      lastName: "B",
      npi: "1234567893",
      epcsRequested: false,
    });
    await c.getPrescriptionStatus(ORG, "501", "77");
    expect(s.purposes).toContain("setup");
    expect(s.purposes.filter((p) => p === "operate").length).toBeGreaterThan(0);
    expect(s.purposes[0]).toBe("setup");
  });

  it("a resolver fault (key ring, KEK, credential, database) is a retryable ConfigUnavailableError, never 'not configured' and never a bare error", async () => {
    const boom = Object.assign(new Error("credential unreadable"), {
      code: "DOSESPOT_CREDENTIAL_UNREADABLE",
    });
    const r: DoseSpotTenantConfigResolver = {
      isConfigured: () => true,
      isConfiguredFor: async () => true,
      configFor: async () => {
        throw boom;
      },
      configuredOrganizationIds: () => [],
    };
    const { c, calls } = clientOver(r, {});
    const err = await c.getPrescriptionStatus(ORG, "501", "77").catch((e) => e);
    expect(err).toBeInstanceOf(ConfigUnavailableError);
    expect(isConfigUnavailableError(err)).toBe(true);
    expect(err).toBeInstanceOf(DegradedError);
    expect(isNotEnabledError(err)).toBe(false);
    expect(err.retryable).toBe(true);
    expect(err.cause).toBe(boom); // kept for the worker's log, never put in the customer message
    expect(err.customerMessage).not.toContain("credential unreadable");
    expect(calls).toHaveLength(0);
    // the same through an operation that only asks the resolver whether the tenant is configured
    const unsupported = await c
      .lookupRxBenefit(ORG, { dosespotPatientId: "501", rxnormRxcui: "1" })
      .catch((e) => e);
    expect(isConfigUnavailableError(unsupported)).toBe(true);
  });

  it("never re-POSTs a clinician in-call: addClinician has no idempotency key, so a 5xx is ONE attempt and a retryable degraded error", async () => {
    let posts = 0;
    const { c } = clientOver(swappable(cfg(1)).r, {
      "POST /connect/token": TOKEN_OK,
      "POST /api/clinicians": () => {
        posts += 1;
        return { status: 503 };
      },
    });
    const err = await c
      .enrollPrescriber(ORG, {
        membershipId: "m1",
        firstName: "A",
        lastName: "B",
        npi: "1234567893",
        epcsRequested: false,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DegradedError);
    expect(err.retryable).toBe(true);
    expect(posts).toBe(1);
  });

  it("a 2xx the client cannot read, or that carries no clinician id, is an UNCONFIRMED outcome (the clinician may exist), never a refusal", async () => {
    const enrol = (clinicians: Responder) =>
      clientOver(swappable(cfg(1)).r, {
        "POST /connect/token": TOKEN_OK,
        "POST /api/clinicians": clinicians,
      })
        .c.enrollPrescriber(ORG, {
          membershipId: "m1",
          firstName: "A",
          lastName: "B",
          npi: "1234567893",
          epcsRequested: false,
        })
        .catch((e) => e);
    const accepted: ReadonlyArray<readonly [string, Responder]> = [
      ["an unreadable body", () => ({ status: 200, text: "<html>gateway splash</html>" })],
      ["an empty body", () => ({ status: 200 })],
      ["a body with no Id", () => ({ status: 200, body: { Result: { ResultCode: "OK" } } })],
    ];
    for (const [name, responder] of accepted) {
      const err = await enrol(responder);
      expect(isUnconfirmedOutcomeError(err), name).toBe(true);
      expect(err).toBeInstanceOf(UnconfirmedOutcomeError);
      expect(err).toBeInstanceOf(DegradedError);
      expect(err.retryable, name).toBe(false); // no in-call retry: that could create a second clinician
    }
    // a REFUSAL (a 4xx, or an error the vendor reports) is definitive and is not this class
    for (const refusal of [
      () => ({ status: 422 }),
      () => ({
        status: 200,
        body: { Result: { ResultCode: "ERROR", ResultDescription: "bad NPI" } },
      }),
    ] as Responder[]) {
      const err = await enrol(refusal);
      expect(err).toBeInstanceOf(DegradedError);
      expect(isUnconfirmedOutcomeError(err)).toBe(false);
    }
  });

  it("still retries the calls that carry an idempotency key (a 5xx on a status read is attempted three times)", async () => {
    let gets = 0;
    const { c } = clientOver(swappable(cfg(1)).r, {
      "POST /connect/token": TOKEN_OK,
      "GET /api/patients/501/prescriptions": () => {
        gets += 1;
        return { status: 503 };
      },
    });
    await c.getPrescriptionStatus(ORG, "501", "77").catch(() => undefined);
    expect(gets).toBe(3);
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

  // A send DoseSpot accepted (2xx) but that does not echo our id may have reached the pharmacy: it is HELD (unconfirmed), never retried.
  it("a 2xx send that does not echo the prescription id, an empty one included, is an UNCONFIRMED outcome, never a retry", async () => {
    for (const [name, sendBody] of [
      ["an empty list", []],
      ["another id", [{ Id: 9002 }]],
      ["an empty body", undefined],
    ] as const) {
      const { c, calls } = client(routes(sendBody));
      const err = await c.transmitNewRx(ORG, NEWRX, "idem-2").catch((e) => e);
      expect(isUnconfirmedOutcomeError(err), name).toBe(true);
      expect(err.retryable, name).toBe(false);
      expect(
        calls.filter((x) => x.url.endsWith("/prescriptions/send")),
        name,
      ).toHaveLength(1);
    }
  });

  it("a send whose answer was lost (a timeout, a dropped connection) is UNCONFIRMED and is attempted once", async () => {
    for (const lost of ["timeout", "network"] as const) {
      const r = routes([{ Id: 9001 }]);
      r["POST /api/patients/501/prescriptions/send"] = () => lost;
      const { c, calls } = client(r);
      const err = await c.transmitNewRx(ORG, NEWRX, "idem-lost").catch((e) => e);
      expect(isUnconfirmedOutcomeError(err), lost).toBe(true);
      expect(
        calls.filter((x) => x.url.endsWith("/prescriptions/send")),
        lost,
      ).toHaveLength(1);
    }
  });

  it("a send refused before anything was accepted (a 5xx, a connection never made) stays retryable, with no in-call retry", async () => {
    for (const [name, answer] of [
      ["a 503", { status: 503 }],
      ["a refused connection (undici shape)", "refused"],
      ["a refused connection (Bun shape)", "refused-bun"],
    ] as const) {
      const r = routes([{ Id: 9001 }]);
      r["POST /api/patients/501/prescriptions/send"] = () => answer;
      const { c, calls } = client(r);
      const err = await c.transmitNewRx(ORG, NEWRX, "idem-5xx").catch((e) => e);
      expect(err, name).toBeInstanceOf(DegradedError);
      expect(isUnconfirmedOutcomeError(err), name).toBe(false);
      expect(err.retryable, name).toBe(true);
      expect(
        calls.filter((x) => x.url.endsWith("/prescriptions/send")),
        name,
      ).toHaveLength(1);
    }
  });

  it("a timeout of the token re-mint before a send sent nothing: it stays retryable", async () => {
    let mints = 0;
    const r = routes([{ Id: 9001 }]);
    // the send's first answer is a 401, so the token is minted again, and that mint times out: no send was made with it
    r["POST /api/patients/501/prescriptions/send"] = () => ({ status: 401 });
    const { c, calls } = client({
      ...r,
      "POST /connect/token": (req, n) => {
        mints += 1;
        return mints === 1 ? TOKEN_OK(req, n) : "timeout";
      },
    });
    const err = await c.transmitNewRx(ORG, NEWRX, "idem-mint").catch((e) => e);
    expect(mints).toBe(2);
    expect(calls.filter((x) => x.url.endsWith("/prescriptions/send"))).toHaveLength(1);
    expect(isUnconfirmedOutcomeError(err)).toBe(false);
    expect(err.retryable).toBe(true);
  });

  it("never carries the vendor's free-text ResultDescription in the error", async () => {
    const r = routes([{ Id: 9001 }]);
    r["POST /api/patients/501/prescriptions/coded"] = () => ({
      status: 200,
      body: { Result: { ResultCode: "ERROR", ResultDescription: "Jane Synthetic oxycodone" } },
    });
    const err = await client(r)
      .c.transmitNewRx(ORG, NEWRX, "idem-text")
      .catch((e) => e);
    expect(err).toBeInstanceOf(DegradedError);
    expect(`${err.message} ${err.customerMessage}`).not.toContain("Jane");
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

  // Review of slice 4, L-e: a 2xx the adapter cannot use is AMBIGUOUS (the prescription may exist), the same class as an enrolment's.
  it("a 2xx create with no prescription id, or an unreadable create or send answer, is an UNCONFIRMED outcome, never a permanent refusal", async () => {
    const transmitWith = (override: Record<string, Responder>) =>
      client({ ...routes([{ Id: 9001 }]), ...override })
        .c.transmitNewRx(ORG, NEWRX, "idem-6")
        .catch((e) => e);
    const accepted: ReadonlyArray<readonly [string, Record<string, Responder>]> = [
      [
        "a create with no Id",
        {
          "POST /api/patients/501/prescriptions/coded": () => ({
            status: 200,
            body: { Result: { ResultCode: "OK" } },
          }),
        },
      ],
      [
        "an unreadable create",
        {
          "POST /api/patients/501/prescriptions/coded": () => ({
            status: 200,
            text: "<html>gateway</html>",
          }),
        },
      ],
      [
        "an unreadable send",
        {
          "POST /api/patients/501/prescriptions/send": () => ({
            status: 200,
            text: "<html>gateway</html>",
          }),
        },
      ],
    ];
    for (const [name, override] of accepted) {
      const err = await transmitWith(override);
      expect(isUnconfirmedOutcomeError(err), name).toBe(true);
      expect(err.retryable, name).toBe(false);
    }
    // a REFUSAL stays a plain permanent failure
    const refused = await transmitWith({
      "POST /api/patients/501/prescriptions/coded": () => ({ status: 422 }),
    });
    expect(refused).toBeInstanceOf(DegradedError);
    expect(isUnconfirmedOutcomeError(refused)).toBe(false);
  });

  // The created-but-unsent prescription id used to live only in this process's memory, so a retry on ANOTHER replica re-ran the create (a second
  // prescription). The caller can now persist it (`onCreated`) and hand it back (`createdPrescriptionId`): a retry then only re-runs the send.
  it("reports the created prescription id BEFORE sending it, so a caller can persist it", async () => {
    const order: string[] = [];
    const r = routes([{ Id: 9001 }]);
    const send = r["POST /api/patients/501/prescriptions/send"] as Responder;
    r["POST /api/patients/501/prescriptions/send"] = (...a) => {
      order.push("send");
      return send(...a);
    };
    const { c } = client(r);
    const out = await c.transmitNewRx(ORG, NEWRX, "idem-7", {
      onCreated: async (id) => {
        order.push(`created:${id}`);
      },
    });
    expect(out.dosespotPrescriptionId).toBe("9001");
    expect(order).toEqual(["created:9001", "send"]);
  });

  it("given a persisted created id (a retry on another process), it only re-runs the SEND: no second create", async () => {
    const { c, calls } = client(routes([{ Id: 9001 }]));
    const out = await c.transmitNewRx(ORG, NEWRX, "idem-8", { createdPrescriptionId: "9001" });
    expect(out.dosespotPrescriptionId).toBe("9001");
    expect(calls.filter((x) => x.url.endsWith("/prescriptions/coded"))).toHaveLength(0);
    const sent = calls.find((x) => x.url.endsWith("/prescriptions/send"));
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({ prescriptionIds: [9001] });
  });

  it("a failing onCreated stops before the send (the prescription exists but could not be remembered: the caller decides)", async () => {
    const { c, calls } = client(routes([{ Id: 9001 }]));
    const err = await c
      .transmitNewRx(ORG, NEWRX, "idem-9", {
        onCreated: async () => {
          throw new Error("could not persist");
        },
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(calls.filter((x) => x.url.endsWith("/prescriptions/send"))).toHaveLength(0);
  });

  // `onCreated` runs only when THIS call created the prescription, so a caller that re-checks it still owns the order there missed the path where
  // a persisted id is handed back: that one goes straight to the send. `beforeSend` runs just before the send on EVERY path.
  it("beforeSend runs after onCreated and just before the send when this call created the prescription", async () => {
    const order: string[] = [];
    const r = routes([{ Id: 9001 }]);
    const send = r["POST /api/patients/501/prescriptions/send"] as Responder;
    r["POST /api/patients/501/prescriptions/send"] = (...a) => {
      order.push("send");
      return send(...a);
    };
    const { c } = client(r);
    await c.transmitNewRx(ORG, NEWRX, "idem-10", {
      onCreated: async (id) => {
        order.push(`created:${id}`);
      },
      beforeSend: async () => {
        order.push("beforeSend");
      },
    });
    expect(order).toEqual(["created:9001", "beforeSend", "send"]);
  });

  it("beforeSend runs on the resumed path too (a persisted id goes straight to the send), and a throwing beforeSend stops the send", async () => {
    const seen = client(routes([{ Id: 9001 }]));
    let ran = 0;
    await seen.c.transmitNewRx(ORG, NEWRX, "idem-11", {
      createdPrescriptionId: "9001",
      beforeSend: async () => {
        ran += 1;
      },
    });
    expect(ran).toBe(1);
    expect(seen.calls.filter((x) => x.url.endsWith("/prescriptions/send"))).toHaveLength(1);

    const { c, calls } = client(routes([{ Id: 9001 }]));
    const err = await c
      .transmitNewRx(ORG, NEWRX, "idem-12", {
        createdPrescriptionId: "9001",
        beforeSend: async () => {
          throw new Error("the order is no longer ours");
        },
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(calls.filter((x) => x.url.endsWith("/prescriptions/send"))).toHaveLength(0);
    expect(calls.filter((x) => x.url.endsWith("/prescriptions/coded"))).toHaveLength(0);
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
