import { describe, expect, it } from "vitest";
import {
  EPISODE_ALERT_DDE_API_KEY_ENV,
  EPISODE_ALERT_DDE_BASE_URL_ENV,
  EpisodeAlertDdeProvider,
  createEpisodeAlertDdeProviderFromEnv,
} from "./episode-alert-dde-provider";
import { EA_DDE_FACTS, EA_DDE_WIRE, WIRE_UNVERIFIED } from "./episode-alert-dde-wire";
import type { EpisodeAlertDdeWire } from "./episode-alert-dde-wire";
import { DDE_PROVIDER_ENV, bindDdeProvider } from "./provider-registry";
import { DDE, type DdeContext, type DdeOperation } from "./types";

const MBI = "1EG4TE5MK73";
const SECRET = "ea-secret-key-123";
const CTX: DdeContext = {
  organizationId: "org-1",
  providerEntityId: "pe-1",
  operatorMembershipId: "op-1",
  correlationId: "c-1",
  usage: "production",
};
const OP: DdeOperation = {
  kind: "noe",
  controlNumber: "cn-1",
  idempotencyKey: "dde:item:1",
  payload: { format: "json", document: { itemType: "noe" } },
  beneficiary: { mbi: MBI, lastName: "Doe", firstName: "Jane", dateOfBirth: "1950-01-01" },
};

/** A wire for exercising the plumbing ONLY: its paths and shapes are invented here, and exist nowhere else. */
const TEST_WIRE: EpisodeAlertDdeWire = {
  verified: true,
  buildSubmit: (secret, _ctx, op) => ({
    ok: true,
    value: {
      path: "t/submit",
      method: "POST",
      headers: { k: secret },
      body: JSON.stringify(op.beneficiary),
    },
  }),
  parseReceipt: (body, op) =>
    body === "bad"
      ? { ok: false, code: "EA_DDE_WIRE_UNREADABLE" }
      : {
          ok: true,
          value: {
            providerReference: "ref-1",
            idempotencyKey: op.idempotencyKey,
            controlNumber: op.controlNumber,
            receivedAt: "2026-01-01T00:00:00Z",
            replayed: false,
          },
        },
  buildChangeReport: (secret) => ({
    ok: true,
    value: { path: "t/changes", method: "GET", headers: { k: secret } },
  }),
  parseChangeReport: () => ({ ok: true, value: { items: [], nextCursor: "1", hasMore: false } }),
  buildStatus: (secret) => ({
    ok: true,
    value: { path: "t/status", method: "GET", headers: { k: secret } },
  }),
  parseStatus: (_b, ref) => ({
    ok: true,
    value: { providerReference: ref, state: "received", latest: null },
  }),
};

const fakeFetch = (status: number, body = "ok"): typeof fetch =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

const make = (f: typeof fetch, extra: { allowTestUsage?: boolean } = {}) =>
  new EpisodeAlertDdeProvider({
    apiKey: SECRET,
    baseUrl: "https://vendor.invalid/api",
    wire: TEST_WIRE,
    fetch: f,
    ...extra,
  });

describe("Episode Alert DDE adapter skeleton (wire unverified)", () => {
  it("records no vendor fact and a wire that answers unverified for everything", () => {
    expect(Object.values(EA_DDE_FACTS).every((v) => v === null)).toBe(true);
    expect(EA_DDE_WIRE.verified).toBe(false);
    expect(EA_DDE_WIRE.buildSubmit(SECRET, CTX, OP)).toEqual({ ok: false, code: WIRE_UNVERIFIED });
    expect(EA_DDE_WIRE.buildChangeReport(SECRET, CTX, null)).toEqual({
      ok: false,
      code: WIRE_UNVERIFIED,
    });
    expect(EA_DDE_WIRE.parseChangeReport("<x/>")).toEqual({ ok: false, code: WIRE_UNVERIFIED });
  });

  it("refuses to bind: the factory throws while the wire is unverified", () => {
    const env = {
      [EPISODE_ALERT_DDE_API_KEY_ENV]: SECRET,
      [EPISODE_ALERT_DDE_BASE_URL_ENV]: "https://x.invalid",
    };
    expect(() => createEpisodeAlertDdeProviderFromEnv(env)).toThrow(/unverified/);
    expect(() =>
      bindDdeProvider(
        { [DDE_PROVIDER_ENV]: "episode_alert", ...env },
        { episode_alert: (e) => createEpisodeAlertDdeProviderFromEnv(e) },
      ),
    ).toThrow(/unverified/);
    expect(() => bindDdeProvider({ [DDE_PROVIDER_ENV]: "episode_alert" }, {})).toThrow(
      /no adapter/,
    );
  });

  it("fails closed with DDE_NOT_WIRED on every operation and sends nothing", async () => {
    let calls = 0;
    const p = new EpisodeAlertDdeProvider({
      apiKey: SECRET,
      baseUrl: "https://vendor.invalid",
      fetch: (async () => {
        calls += 1;
        return new Response("");
      }) as unknown as typeof fetch,
    });
    for (const r of [
      await p.submitOperation(CTX, OP),
      await p.fetchOutcomes(CTX, null),
      await p.fetchOperationStatus(CTX, "ref"),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.degraded.code).toBe(DDE.NOT_WIRED);
    }
    expect(calls).toBe(0);
  });

  it("refuses the beneficiary's identifier in every result and reason", async () => {
    const p = make(fakeFetch(500, `${MBI} ${SECRET}`));
    const out = JSON.stringify(await p.submitOperation(CTX, OP));
    expect(out).not.toContain(MBI);
    expect(out).not.toContain(SECRET);
  });
});

describe("Episode Alert DDE plumbing (generic: status mapping, usage, bodies)", () => {
  it("maps HTTP statuses onto the port's codes", async () => {
    const code = async (status: number) => {
      const r = await make(fakeFetch(status)).fetchOutcomes(CTX, null);
      return r.ok ? "ok" : r.degraded.code;
    };
    expect(await code(200)).toBe("ok");
    expect(await code(401)).toBe(DDE.NOT_PROVISIONED);
    expect(await code(403)).toBe(DDE.NOT_PROVISIONED);
    expect(await code(422)).toBe(DDE.INVALID_REQUEST);
    expect(await code(409)).toBe(DDE.IDEMPOTENCY_CONFLICT);
    expect(await code(503)).toBe(DDE.UNAVAILABLE);
  });

  it("reports a network failure as unavailable and an unreadable answer without echoing it", async () => {
    const down = make((async () => {
      throw new Error(`boom ${MBI}`);
    }) as unknown as typeof fetch);
    const r = await down.fetchOutcomes(CTX, null);
    expect(r.ok ? "" : r.degraded.code).toBe(DDE.UNAVAILABLE);
    expect(JSON.stringify(r)).not.toContain(MBI);
    const bad = await make(fakeFetch(200, "bad")).submitOperation(CTX, OP);
    expect(bad.ok ? "" : bad.degraded.code).toBe(DDE.UNAVAILABLE);
  });

  it("refuses usage test unless a contract test allows it (the vendor has no recorded test mode)", async () => {
    const r = await make(fakeFetch(200)).fetchOutcomes({ ...CTX, usage: "test" }, null);
    expect(r.ok ? "" : r.degraded.code).toBe(DDE.NOT_PROVISIONED);
    const allowed = await make(fakeFetch(200), { allowTestUsage: true }).fetchOutcomes(
      { ...CTX, usage: "test" },
      null,
    );
    expect(allowed.ok).toBe(true);
  });
});
