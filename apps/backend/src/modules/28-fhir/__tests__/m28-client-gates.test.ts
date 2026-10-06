// GAP-083 — request-time client gates: IP allowlist, BAA, per-client token bucket (D12/D16).
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";
import {
  assertBaaInForceForClient,
  parseIpAllowlist,
  sampleFhirBaaCoverage,
  warnOnFhirBaaGap,
} from "../routes/client-baa-ops";
import { baaStatusOf, isIpAllowed } from "../routes/client-gates";
import { createInMemoryFhirClientRateLimiter } from "../routes/client-rate-limiter";
import { registerFhirR4Routes } from "../routes/fhir-r4.routes";
import { createInMemoryFhirGatewayStore } from "../routes/store";
import { mintFhirToken } from "../routes/token-mint";
import { createInMemoryFhirReplayGuard } from "../routes/token-mint";

const ORG = "11111111-1111-1111-1111-111111111111";
const CLIENT = "44444444-4444-4444-4444-444444444444";
const TOKEN = "55555555-5555-5555-5555-555555555555";
const SECRET = "s3cret";
const digest = createHash("sha256").update(SECRET, "utf8").digest("hex");
const baaOn = { isBaaActive: async () => true };

function seed(over: Record<string, unknown> = {}) {
  return createInMemoryFhirGatewayStore({
    clients: [
      {
        id: CLIENT,
        organizationId: ORG,
        type: "api_key",
        status: "active",
        allowedScopes: ["system/Patient.read"],
        secretDigests: [digest],
        ...over,
      },
    ],
    sessions: [
      {
        jti: TOKEN,
        token: TOKEN,
        clientId: CLIENT,
        organizationId: ORG,
        scopesGranted: ["system/Patient.read"],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        revokedAt: null,
      },
    ],
  });
}

async function app(store: ReturnType<typeof seed>, extra: Record<string, unknown> = {}) {
  const a = Fastify({ trustProxy: false });
  registerFhirR4Routes(a, { store, baa: baaOn, ...extra });
  await a.ready();
  return a;
}
const get = (a: Awaited<ReturnType<typeof app>>, remoteAddress: string) =>
  a.inject({
    method: "GET",
    url: "/fhir/r4/Patient/xyz",
    remoteAddress,
    headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "203.0.113.9" },
  });

describe("isIpAllowed", () => {
  it("empty list means no restriction; CIDR and exact entries match; junk never matches", () => {
    expect(isIpAllowed("9.9.9.9", [])).toBe(true);
    expect(isIpAllowed("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(isIpAllowed("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
    expect(isIpAllowed("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(isIpAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(isIpAllowed("1.2.3.4", ["garbage", "1.2.3.4/99"])).toBe(false);
    expect(isIpAllowed(undefined, ["10.0.0.0/8"])).toBe(false);
  });
});

describe("resolveBearer gates", () => {
  it("401 from an IP outside the allowlist, and a spoofed X-Forwarded-For does not help", async () => {
    const a = await app(seed({ ipAllowlist: ["10.0.0.0/8"] }));
    const res = await get(a, "198.51.100.7");
    expect(res.statusCode).toBe(401);
  });

  it("serves (not 401) from an allowlisted IP", async () => {
    const a = await app(seed({ ipAllowlist: ["10.0.0.0/8"] }));
    expect((await get(a, "10.4.4.4")).statusCode).not.toBe(401);
  });

  it("401 when the BAA is not in force, and when no BAA port is bound (fail closed)", async () => {
    const off = await app(seed(), { baa: { isBaaActive: async () => false } });
    expect((await get(off, "10.4.4.4")).statusCode).toBe(401);
    const unbound = await app(seed(), { baa: undefined });
    expect((await get(unbound, "10.4.4.4")).statusCode).toBe(401);
    const throwing = await app(seed(), {
      baa: {
        isBaaActive: async () => {
          throw new Error("down");
        },
      },
    });
    expect((await get(throwing, "10.4.4.4")).statusCode).toBe(401);
  });

  it("429 with Retry-After and a throttled OperationOutcome once the bucket is empty", async () => {
    const a = await app(seed({ rateLimitRps: 2 }), {
      rateLimiter: createInMemoryFhirClientRateLimiter(() => 1_000),
    });
    const codes: number[] = [];
    let last: Awaited<ReturnType<typeof get>> | undefined;
    for (let i = 0; i < 4; i++) {
      last = await get(a, "10.4.4.4");
      codes.push(last.statusCode);
    }
    expect(codes.slice(0, 2).every((c) => c !== 429)).toBe(true);
    expect(codes.slice(2)).toEqual([429, 429]);
    expect(Number(last?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(last?.json().issue[0].code).toBe("throttled");
  });
});

describe("token mint gates", () => {
  const base = (store: ReturnType<typeof seed>, baa: unknown = baaOn) => ({
    store,
    jwks: { fetch: async () => null },
    replay: createInMemoryFhirReplayGuard(),
    baa: baa as typeof baaOn,
  });
  const req = (ip: string | null) => ({
    scope: "system/Patient.read",
    clientId: CLIENT,
    clientSecret: SECRET,
    ip,
  });

  it("mints from an allowlisted IP with an active BAA", async () => {
    const r = await mintFhirToken(base(seed({ ipAllowlist: ["10.0.0.0/8"] })), req("10.1.1.1"));
    expect(r.ok).toBe(true);
  });
  it("refuses 401 from outside the allowlist, a null IP, and a lapsed BAA", async () => {
    const s = seed({ ipAllowlist: ["10.0.0.0/8"] });
    for (const ip of ["198.51.100.7", null]) {
      const r = await mintFhirToken(base(s), req(ip));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.status).toBe(401);
    }
    const lapsed = await mintFhirToken(
      base(seed(), { isBaaActive: async () => false }),
      req("10.1.1.1"),
    );
    expect(lapsed.ok).toBe(false);
    if (!lapsed.ok) expect(lapsed.error.status).toBe(401);
  });
});

describe("GAP-083 follow-up — BAA failures are distinguishable and operable", () => {
  const off = { isBaaActive: async () => false };
  const mintDeps = (store: ReturnType<typeof seed>, extra: Record<string, unknown> = {}) => ({
    store,
    jwks: { fetch: async () => null },
    replay: createInMemoryFhirReplayGuard(),
    baa: off,
    ...extra,
  });
  const goodReq = {
    scope: "system/Patient.read",
    clientId: CLIENT,
    clientSecret: SECRET,
    ip: null,
  };

  it("a BAA refusal on mint carries BAA_NOT_IN_FORCE + structured fields; a bad secret does not", async () => {
    const r = await mintFhirToken(mintDeps(seed()), goodReq);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.status).toBe(401);
    expect(r.error.body.wardenx_code).toBe("BAA_NOT_IN_FORCE");
    expect(r.error.baaFailure).toMatchObject({ clientId: CLIENT, organizationId: ORG });
    expect(JSON.stringify(r.error)).not.toContain(SECRET);
    const bad = await mintFhirToken(mintDeps(seed()), { ...goodReq, clientSecret: "wrong" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.body.wardenx_code).toBeUndefined();
      expect(bad.error.baaFailure).toBeUndefined();
    }
  });

  it("a BAA refusal on a read is 401 with the BAA_NOT_IN_FORCE coding; status/ip refusals keep FHIR_BAD_BEARER", async () => {
    const a = await app(seed(), { baa: off });
    const res = await get(a, "10.4.4.4");
    expect(res.statusCode).toBe(401);
    expect(res.json().issue[0].details.coding[0].code).toBe("BAA_NOT_IN_FORCE");
    const ipOut = await app(seed({ ipAllowlist: ["10.0.0.0/8"] }), { baa: off });
    const r2 = await get(ipOut, "198.51.100.7");
    expect(r2.json().issue[0].details.coding[0].code).toBe("FHIR_BAD_BEARER");
  });

  it("the mint is throttled per client (429 + retryAfterSeconds) once the bucket is empty", async () => {
    const limiter = createInMemoryFhirClientRateLimiter(() => 1_000);
    const deps = mintDeps(seed({ rateLimitRps: 2 }), { baa: baaOn, rateLimiter: limiter });
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await mintFhirToken(deps, goodReq));
    expect(results.slice(0, 2).every((r) => r.ok)).toBe(true);
    const third = results[2];
    expect(third?.ok).toBe(false);
    if (third && !third.ok) {
      expect(third.error.status).toBe(429);
      expect(third.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("client-baa-ops", () => {
  const input = { organizationId: ORG, contractReference: "r", asOf: "2026-01-01T00:00:00Z" };

  it("baaStatusOf is tri-state: seam error and unbound are unknown, never not_in_force", async () => {
    expect(await baaStatusOf({ isBaaActive: async () => true }, input)).toBe("in_force");
    expect(await baaStatusOf({ isBaaActive: async () => false }, input)).toBe("not_in_force");
    expect(
      await baaStatusOf(
        {
          isBaaActive: async () => {
            throw new Error("x");
          },
        },
        input,
      ),
    ).toBe("unknown");
    expect(await baaStatusOf(undefined, input)).toBe("unknown");
  });

  it("assertBaaInForceForClient refuses unless in force (422 vs 503 for unknown)", async () => {
    await expect(
      assertBaaInForceForClient({ isBaaActive: async () => true }, input),
    ).resolves.toBeUndefined();
    await expect(
      assertBaaInForceForClient({ isBaaActive: async () => false }, input),
    ).rejects.toMatchObject({
      statusCode: 422,
    });
    await expect(assertBaaInForceForClient(undefined, input)).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("parseIpAllowlist accepts addresses/CIDR and 422s on anything else", () => {
    expect(parseIpAllowlist(undefined)).toEqual([]);
    expect(parseIpAllowlist([" 10.0.0.0/8 ", "::1", "2001:db8::/32"])).toEqual([
      "10.0.0.0/8",
      "::1",
      "2001:db8::/32",
    ]);
    for (const bad of ["", "10.0.0.0/33", "a.b.c.d", "10.0.0.0/8/1", "::1/129", "1.2.3.4/x"]) {
      expect(() => parseIpAllowlist([bad])).toThrowError(/IP address or CIDR/);
    }
  });

  it("sampleFhirBaaCoverage counts unresolved active clients and tolerates a failing org", async () => {
    const refs: Record<string, string[]> = { o1: ["ok", "lapsed"], o2: ["lapsed"] };
    const sample = await sampleFhirBaaCoverage({
      listOrgs: async () => [
        { organizationId: "o1" },
        { organizationId: "o2" },
        { organizationId: "o3" },
      ],
      activeClientRefs: async (o) => {
        if (o === "o3") throw new Error("rls");
        return refs[o] ?? [];
      },
      baa: { isBaaActive: async ({ contractReference }) => contractReference === "ok" },
      now: () => "2026-01-01T00:00:00Z",
    });
    expect(sample).toEqual({
      orgsChecked: 3,
      orgsFailed: 1,
      activeClients: 3,
      notInForce: 2,
      unknown: 0,
    });
  });

  it("warnOnFhirBaaGap warns on a gap or an unmeasurable state, infos when clean, never throws", async () => {
    const calls: string[] = [];
    const log = {
      warn: (_f: Record<string, unknown>, m: string) => calls.push(`warn:${m.slice(0, 8)}`),
      info: () => calls.push("info"),
    };
    const clean = { orgsChecked: 1, orgsFailed: 0, activeClients: 2, notInForce: 0, unknown: 0 };
    await warnOnFhirBaaGap(async () => clean, log);
    await warnOnFhirBaaGap(async () => ({ ...clean, notInForce: 1 }), log);
    await warnOnFhirBaaGap(async () => ({ ...clean, orgsFailed: 1 }), log);
    await warnOnFhirBaaGap(async () => null, log);
    await warnOnFhirBaaGap(async () => {
      throw new Error("x");
    }, log);
    expect(calls).toEqual([
      "info",
      "warn:GAP-083:",
      "warn:GAP-083:",
      "warn:GAP-083:",
      "warn:GAP-083:",
    ]);
  });
});
