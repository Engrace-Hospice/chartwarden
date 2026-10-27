import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemoryAttemptStore,
  type SubmissionAttempt,
  type SubmissionAttemptStore,
} from "./attempt-store";
import {
  type StediAnomaly,
  StediTransport,
  createStediTransportFromEnv,
  settleGuard,
} from "./stedi-transport";
import { identityOf, scopeKey } from "./submission-identity";
import { CH, RETRYABLE_CODES } from "./types";
import type { ClearinghouseContext, ClearinghouseSubmission } from "./types";

const fixture = (name: string): string =>
  readFileSync(join(__dirname, "__fixtures__", `stedi-${name}.x12`), "utf8");
const CLAIM_X12 = fixture("claim");
const NOE_X12 = fixture("NOE_81A");
const KEY = "test_key_do_not_leak_0123456789";

const CTX: ClearinghouseContext = {
  organizationId: "org-1",
  providerEntityId: "pe-1",
  payerId: "12M41",
  correlationId: "corr-1",
  usage: "test",
};

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function harness(
  respond: (call: Call, n: number) => Response | Promise<Response> = () =>
    Response.json({ status: "SUCCESS", claimReference: { correlationId: "corr-abc" } }),
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call, calls.length);
  }) as typeof fetch;
  const attempts = new InMemoryAttemptStore();
  const clock = { now: new Date("2026-10-11T10:00:00.000Z") };
  const transport = new StediTransport({
    apiKey: KEY,
    fetch: fetchImpl,
    attempts,
    now: () => clock.now,
  });
  return { calls, transport, attempts, clock };
}

/** Rewrites ISA13 so the fixture interchange carries the control number the submission declares. */
const withIsa13 = (x12: string, controlNumber: string): string =>
  x12.replace(/^(ISA(?:\*[^*]*){12}\*)[^*]*/, `$1${controlNumber}`);

function claim(overrides: Partial<ClearinghouseSubmission> = {}): ClearinghouseSubmission {
  return {
    kind: "claim",
    controlNumber: "CCN-1",
    idempotencyKey: "idem-1",
    payload: { format: "x12", x12: withIsa13(CLAIM_X12, overrides.controlNumber ?? "CCN-1") },
    ...overrides,
  };
}
const notice = (overrides: Partial<ClearinghouseSubmission> = {}): ClearinghouseSubmission => ({
  kind: "noe",
  controlNumber: "NOE-1",
  idempotencyKey: "idem-noe-1",
  payload: { format: "x12", x12: withIsa13(NOE_X12, overrides.controlNumber ?? "NOE-1") },
  ...overrides,
});
const code = (r: { ok: boolean; degraded?: { code: string } }): string | undefined =>
  r.ok ? undefined : r.degraded?.code;

describe("StediTransport.submitClaim", () => {
  it("posts raw X12 to the raw endpoint with the key, content type and idempotency key", async () => {
    const { calls, transport } = harness();
    const r = await transport.submitClaim(CTX, claim());
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/institutionalclaims/v1/raw-x12-submission",
    );
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(KEY);
    expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f]{64}$/);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ x12: withIsa13(CLAIM_X12, "CCN-1") });
    if (r.ok) {
      expect(r.data).toMatchObject({
        clearinghouseSubmissionId: "corr-abc",
        controlNumber: "CCN-1",
        idempotencyKey: "idem-1",
        replayed: false,
      });
    }
  });

  it("posts a JSON document to the JSON endpoint", async () => {
    const { calls, transport } = harness();
    const document = { usageIndicator: "T", claimInformation: { a: 1 } };
    const r = await transport.submitClaim(CTX, claim({ payload: { format: "json", document } }));
    expect(r.ok).toBe(true);
    expect(calls[0]?.url.endsWith("/institutionalclaims/v1/submission")).toBe(true);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(document);
  });

  it("replays an identical resubmission without a second send", async () => {
    const { calls, transport } = harness();
    const first = await transport.submitClaim(CTX, claim());
    const second = await transport.submitClaim(CTX, claim());
    expect(calls).toHaveLength(1);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.data.replayed).toBe(true);
      expect(second.data.clearinghouseSubmissionId).toBe(first.data.clearinghouseSubmissionId);
    }
  });

  it("conflicts, with no send, on a reused key with another payload, number or kind", async () => {
    const { calls, transport } = harness();
    await transport.submitClaim(CTX, claim());
    const sends = calls.length;
    expect(
      code(
        await transport.submitClaim(
          CTX,
          claim({ payload: { format: "x12", x12: `${withIsa13(CLAIM_X12, "CCN-1")} ` } }),
        ),
      ),
    ).toBe(CH.IDEMPOTENCY_CONFLICT);
    expect(code(await transport.submitClaim(CTX, claim({ controlNumber: "CCN-2" })))).toBe(
      CH.IDEMPOTENCY_CONFLICT,
    );
    expect(code(await transport.submitClaim(CTX, claim({ idempotencyKey: "idem-new" })))).toBe(
      CH.IDEMPOTENCY_CONFLICT,
    );
    expect(calls).toHaveLength(sends);
  });

  it("treats JSON key order as the same submission and a reused key with another kind as a conflict", async () => {
    const { calls, transport } = harness();
    const a = { usageIndicator: "T", x: { c: 2, d: 3 }, y: 1 };
    const b = { y: 1, x: { d: 3, c: 2 }, usageIndicator: "T" };
    await transport.submitClaim(CTX, claim({ payload: { format: "json", document: a } }));
    const again = await transport.submitClaim(
      CTX,
      claim({ payload: { format: "json", document: b } }),
    );
    expect(again.ok && again.data.replayed).toBe(true);
    expect(calls).toHaveLength(1);
    const asNotice = await transport.submitNotice(CTX, notice({ idempotencyKey: "idem-1" }));
    expect(code(asNotice)).toBe(CH.IDEMPOTENCY_CONFLICT);
    expect(calls).toHaveLength(1);
  });

  it("keeps tenants and usage modes apart", async () => {
    const { calls, transport } = harness();
    await transport.submitClaim(CTX, claim());
    const other = await transport.submitClaim(
      { ...CTX, organizationId: "org-2" },
      claim({ controlNumber: "CCN-2" }),
    );
    expect(other.ok && !other.data.replayed).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("refuses another tenant's use of a live control number: the sender is the platform's", async () => {
    const { calls, transport } = harness();
    await transport.submitClaim(CTX, claim());
    const other = await transport.submitClaim({ ...CTX, organizationId: "org-2" }, claim());
    expect(code(other)).toBe(CH.IDEMPOTENCY_CONFLICT);
    expect(calls).toHaveLength(1);
  });

  it("scopes the wire idempotency key per tenant and usage, but keeps it stable for a retry", async () => {
    const { calls, transport } = harness();
    await transport.submitClaim(CTX, claim());
    await transport.submitClaim(
      { ...CTX, organizationId: "org-2" },
      claim({ controlNumber: "CCN-2" }),
    );
    const keys = calls.map((c) => new Headers(c.init.headers).get("idempotency-key"));
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).not.toBe("idem-1");
  });

  it("refuses a JSON document whose usageIndicator is production under test usage", async () => {
    const { calls, transport } = harness();
    const r = await transport.submitClaim(
      CTX,
      claim({ payload: { format: "json", document: { usageIndicator: "P" } } }),
    );
    expect(code(r)).toBe(CH.INVALID_REQUEST);
    expect(calls).toHaveLength(0);
  });

  it("refuses an adjustment and sends nothing", async () => {
    const { calls, transport } = harness();
    const r = await transport.submitClaim(
      CTX,
      claim({ adjustment: { kind: "void", originalControlNumber: "CCN-0" } }),
    );
    expect(code(r)).toBe(CH.INVALID_REQUEST);
    expect(calls).toHaveLength(0);
  });

  it("refuses a notice kind and a usage mismatch before any send", async () => {
    const { calls, transport } = harness();
    expect(code(await transport.submitClaim(CTX, claim({ kind: "noe" })))).toBe(CH.INVALID_REQUEST);
    expect(code(await transport.submitClaim({ ...CTX, usage: "production" }, claim()))).toBe(
      CH.INVALID_REQUEST,
    );
    expect(
      code(
        await transport.submitClaim(
          { ...CTX, usage: "production" },
          claim({ payload: { format: "json", document: { usageIndicator: "T" } } }),
        ),
      ),
    ).toBe(CH.INVALID_REQUEST);
    expect(calls).toHaveLength(0);
  });

  it("refuses a payload that fails the local Stedi edit checks, with rule names only", async () => {
    const { calls, transport } = harness();
    const bad = withIsa13(CLAIM_X12, "CCN-1").replace(/CLM\*([^*]*)\*[0-9.]+/, "CLM*$1*1");
    const r = await transport.submitClaim(CTX, claim({ payload: { format: "x12", x12: bad } }));
    expect(code(r)).toBe(CH.INVALID_REQUEST);
    if (!r.ok) expect(r.degraded.reason).toMatch(/total-matches-lines/);
    expect(calls).toHaveLength(0);
  });
});

describe("StediTransport.submitNotice", () => {
  it("posts a NOE as raw X12", async () => {
    const { calls, transport } = harness();
    const r = await transport.submitNotice(CTX, notice());
    expect(r.ok).toBe(true);
    expect(calls[0]?.url.endsWith("/raw-x12-submission")).toBe(true);
  });

  it("refuses a claim kind, a JSON payload and an adjustment", async () => {
    const { calls, transport } = harness();
    expect(code(await transport.submitNotice(CTX, notice({ kind: "claim" })))).toBe(
      CH.INVALID_REQUEST,
    );
    expect(
      code(
        await transport.submitNotice(
          CTX,
          notice({ payload: { format: "json", document: { usageIndicator: "T" } } }),
        ),
      ),
    ).toBe(CH.INVALID_REQUEST);
    expect(
      code(
        await transport.submitNotice(
          CTX,
          notice({ adjustment: { kind: "void", originalControlNumber: "NOE-0" } }),
        ),
      ),
    ).toBe(CH.INVALID_REQUEST);
    expect(calls).toHaveLength(0);
  });

  it("refuses a chargeable ($0) notice that Stedi would reject", async () => {
    const { calls, transport } = harness();
    const chargeable = NOE_X12.replace(
      /BHT\*([^*]*)\*([^*]*)\*([^*]*)\*([^*]*)\*([^*]*)\*RP/,
      "BHT*$1*$2*$3*$4*$5*CH",
    );
    const r = await transport.submitNotice(
      CTX,
      notice({ payload: { format: "x12", x12: chargeable } }),
    );
    expect(code(r)).toBe(CH.INVALID_REQUEST);
    expect(calls).toHaveLength(0);
  });
});

describe("StediTransport billing provider binding", () => {
  it("sends when the payload's billing NPI is the context's", async () => {
    const { calls, transport } = harness();
    const r = await transport.submitClaim({ ...CTX, billingNpi: "1234567893" }, claim());
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("refuses a payload that bills under another NPI, with no send", async () => {
    const { calls, transport } = harness();
    const r = await transport.submitClaim({ ...CTX, billingNpi: "1000000004" }, claim());
    expect(code(r)).toBe(CH.INVALID_REQUEST);
    expect(calls).toHaveLength(0);
  });

  it("requires the NPI in production, but not in test", async () => {
    const { calls, transport } = harness();
    const production = { ...CTX, usage: "production" as const };
    const x12 = withIsa13(CLAIM_X12, "CCN-1").replace(/\*T\*:~/, "*P*:~");
    const r = await transport.submitClaim(production, claim({ payload: { format: "x12", x12 } }));
    expect(code(r)).toBe(CH.INVALID_REQUEST);
    if (!r.ok) expect(r.degraded.reason).toMatch(/billingNpi is required/);
    expect(calls).toHaveLength(0);
  });

  it("checks a JSON claim's billing NPI the same way", async () => {
    const { calls, transport } = harness();
    const document = { usageIndicator: "T", billing: { npi: "1234567893" } };
    const ok = await transport.submitClaim(
      { ...CTX, billingNpi: "1234567893" },
      claim({ payload: { format: "json", document } }),
    );
    expect(ok.ok).toBe(true);
    const bad = await transport.submitClaim(
      { ...CTX, billingNpi: "1000000004" },
      claim({
        controlNumber: "CCN-2",
        idempotencyKey: "idem-2",
        payload: { format: "json", document },
      }),
    );
    expect(code(bad)).toBe(CH.INVALID_REQUEST);
    expect(calls).toHaveLength(1);
  });
});

describe("StediTransport after an operator voids an attempt", () => {
  it("refuses the burned key, with no send, but accepts a new key and control number", async () => {
    const { calls, transport, attempts, clock } = harness(
      () => new Response("{}", { status: 503 }),
    );
    await transport.submitClaim(CTX, claim());
    clock.now = new Date(clock.now.getTime() + 25 * 60 * 60_000);
    await attempts.resolve(
      CTX.organizationId,
      scopeKey(CTX),
      "idem-1",
      { kind: "voided" },
      "op",
      settleGuard(clock.now),
    );
    const sends = calls.length;
    const again = await transport.submitClaim(CTX, claim());
    expect(code(again)).toBe(CH.IDEMPOTENCY_CONFLICT);
    expect(calls).toHaveLength(sends);
  });
});

describe("StediTransport input binding and ambiguous refusals", () => {
  it("keeps the reservation on a 409, so a new key cannot re-file the same control number", async () => {
    const { calls, transport } = harness(() => new Response("{}", { status: 409 }));
    expect(code(await transport.submitClaim(CTX, claim()))).toBe(CH.IDEMPOTENCY_CONFLICT);
    const other = await transport.submitClaim(CTX, claim({ idempotencyKey: "idem-other" }));
    expect(code(other)).toBe(CH.IDEMPOTENCY_CONFLICT);
    expect(calls).toHaveLength(1);
  });

  it("refuses a control number that is not the interchange's ISA13, with no send", async () => {
    const { calls, transport } = harness();
    const r = await transport.submitClaim(
      CTX,
      claim({ payload: { format: "x12", x12: withIsa13(CLAIM_X12, "OTHER-9") } }),
    );
    expect(code(r)).toBe(CH.INVALID_REQUEST);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["key with a space", { idempotencyKey: "has space" }],
    ["key over 128 characters", { idempotencyKey: "k".repeat(129) }],
    ["control number over 64 characters", { controlNumber: "9".repeat(65) }],
  ])("refuses %s as invalid, not retryable", async (_n, overrides) => {
    const { calls, transport } = harness();
    const r = await transport.submitClaim(CTX, claim(overrides));
    expect(code(r)).toBe(CH.INVALID_REQUEST);
    expect(calls).toHaveLength(0);
  });

  it("returns a degraded result for a payload that cannot be fingerprinted", async () => {
    const { calls, transport } = harness();
    const document: Record<string, unknown> = { usageIndicator: "T" };
    document.self = document;
    const r = await transport.submitClaim(CTX, claim({ payload: { format: "json", document } }));
    expect(code(r)).toBe(CH.INVALID_REQUEST);
    expect(calls).toHaveLength(0);
  });
});

describe("StediTransport HTTP failure mapping", () => {
  const fail = (status: number, body: unknown) => () =>
    status === 0
      ? Promise.reject(new TypeError("network down"))
      : new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  it.each([
    ["ACCOUNT_NOT_PROVISIONED", 400, { code: "ACCOUNT_NOT_PROVISIONED" }, CH.NOT_PROVISIONED],
    [
      "edit rejection",
      400,
      { errors: [{ code: "33", description: "secret detail 1500.00" }] },
      CH.INVALID_REQUEST,
    ],
    ["bad body", 400, { code: "INVALID_REQUEST_BODY" }, CH.INVALID_REQUEST],
    ["unauthorized", 401, {}, CH.NOT_WIRED],
    ["conflict", 409, {}, CH.IDEMPOTENCY_CONFLICT],
    ["rate limited", 429, {}, CH.UNAVAILABLE],
    ["server error", 503, "<html>oops</html>", CH.UNAVAILABLE],
    ["network failure", 0, null, CH.UNAVAILABLE],
  ])("%s -> %s", async (_name, status, body, expected) => {
    const { transport } = harness(fail(status, body));
    const r = await transport.submitClaim(CTX, claim());
    expect(code(r)).toBe(expected);
    if (!r.ok) {
      expect(r.degraded.reason).not.toContain(KEY);
      expect(r.degraded.reason).not.toContain("secret detail");
      expect(r.degraded.reason).not.toContain("1500.00");
    }
    if (expected === CH.UNAVAILABLE) expect(RETRYABLE_CODES.has(code(r) ?? "")).toBe(true);
  });

  it("releases the reservation on a definitive rejection, so the same submission can be retried", async () => {
    let n = 0;
    const { calls, transport } = harness(() =>
      ++n === 1
        ? new Response("{}", { status: 429 })
        : Response.json({ claimReference: { correlationId: "later" } }),
    );
    expect(code(await transport.submitClaim(CTX, claim()))).toBe(CH.UNAVAILABLE);
    const retry = await transport.submitClaim(CTX, claim());
    expect(retry.ok && !retry.data.replayed).toBe(true);
    expect(new Headers(calls[1]?.init.headers).get("idempotency-key")).toBe(
      new Headers(calls[0]?.init.headers).get("idempotency-key"),
    );
  });

  it("after an ambiguous failure the next attempt re-sends after a settle delay under the same wire key", async () => {
    let n = 0;
    const { calls, transport, clock } = harness(() =>
      ++n === 1
        ? new Response("{}", { status: 503 })
        : Response.json({ claimReference: { correlationId: "later" } }),
    );
    expect(code(await transport.submitClaim(CTX, claim()))).toBe(CH.UNAVAILABLE);
    // The first request may still be processing at Stedi: not re-sent inside the settle delay.
    expect(code(await transport.submitClaim(CTX, claim()))).toBe(CH.UNAVAILABLE);
    expect(calls).toHaveLength(1);
    clock.now = new Date(clock.now.getTime() + 61_000);
    const retry = await transport.submitClaim(CTX, claim());
    expect(retry.ok && retry.data.clearinghouseSubmissionId).toBe("later");
    expect(calls).toHaveLength(2);
    // Same wire key, so Stedi replays the first send if it had in fact been filed.
    expect(new Headers(calls[1]?.init.headers).get("idempotency-key")).toBe(
      new Headers(calls[0]?.init.headers).get("idempotency-key"),
    );
  });

  it("stops re-sending once the vendor's key window has passed since the first attempt", async () => {
    const anomalies: StediAnomaly[] = [];
    const calls: string[] = [];
    const clock = { now: new Date("2026-10-11T10:00:00.000Z") };
    const transport = new StediTransport({
      apiKey: KEY,
      attempts: new InMemoryAttemptStore(),
      fetch: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response("{}", { status: 503 });
      }) as typeof fetch,
      onAnomaly: (a) => anomalies.push(a),
      now: () => clock.now,
    });
    expect(code(await transport.submitClaim(CTX, claim()))).toBe(CH.UNAVAILABLE);
    expect(calls).toHaveLength(1);
    clock.now = new Date(clock.now.getTime() + 25 * 60 * 60_000);
    expect(code(await transport.submitClaim(CTX, claim()))).toBe(CH.UNAVAILABLE);
    expect(calls).toHaveLength(1);
    expect(anomalies).toEqual([{ type: "stale_reservation", idempotencyKey: "idem-1" }]);
  });

  it("treats a 200 with an unreadable body as filed, with a derived submission id", async () => {
    const { transport } = harness(() => new Response("not json", { status: 200 }));
    const r = await transport.submitClaim(CTX, claim());
    expect(r.ok && r.data.clearinghouseSubmissionId).toBe("stedi:idem-1");
  });

  it("never throws, whatever fetch does", async () => {
    const { transport } = harness(() => {
      throw new Error("sync boom");
    });
    expect(code(await transport.submitClaim(CTX, claim()))).toBe(CH.UNAVAILABLE);
  });
});

describe("StediTransport reservation, completion and races", () => {
  const reserved = (over: Partial<SubmissionAttempt> = {}): SubmissionAttempt => ({
    organizationId: CTX.organizationId,
    providerEntityId: CTX.providerEntityId,
    scope: scopeKey(CTX),
    usage: CTX.usage,
    idempotencyKey: "idem-1",
    controlNumber: "CCN-1",
    kind: "claim",
    identity: identityOf(claim()),
    status: "reserved",
    clearinghouseSubmissionId: null,
    firstReservedAt: "2026-10-11T10:00:00.000Z",
    reservedAt: "2026-10-11T10:00:00.000Z",
    receivedAt: null,
    ...over,
  });
  const NOW = new Date("2026-10-11T10:05:00.000Z");
  const withStore = (attempts: SubmissionAttemptStore, anomalies: StediAnomaly[] = []) => {
    const calls: string[] = [];
    const transport = new StediTransport({
      apiKey: KEY,
      attempts,
      fetch: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return Response.json({ claimReference: { correlationId: "mine" } });
      }) as typeof fetch,
      onAnomaly: (a) => anomalies.push(a),
      now: () => NOW,
    });
    return { transport, calls };
  };
  const seeded = async (row: SubmissionAttempt) => {
    const store = new InMemoryAttemptStore();
    await store.reserve(row);
    if (row.status === "sent") {
      await store.complete(
        row.organizationId,
        row.scope,
        row.idempotencyKey,
        row.clearinghouseSubmissionId ?? "",
        row.receivedAt ?? row.reservedAt,
      );
    }
    return store;
  };

  it("sends once when two callers submit the same thing at the same time", async () => {
    const { calls, transport } = harness();
    const [a, b] = await Promise.all([
      transport.submitClaim(CTX, claim()),
      transport.submitClaim(CTX, claim()),
    ]);
    expect(calls).toHaveLength(1);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(code(loser)).toBe(CH.UNAVAILABLE);
  });

  it("holds a submission another caller reserved moments ago", async () => {
    const { transport, calls } = withStore(await seeded(reserved()));
    expect(code(await transport.submitClaim(CTX, claim()))).toBe(CH.UNAVAILABLE);
    expect(calls).toHaveLength(0);
  });

  it("conflicts, with no send, on a control number reserved under another key", async () => {
    const { transport, calls } = withStore(await seeded(reserved({ idempotencyKey: "other" })));
    expect(code(await transport.submitClaim(CTX, claim()))).toBe(CH.IDEMPOTENCY_CONFLICT);
    expect(calls).toHaveLength(0);
  });

  it("conflicts, with no send, on a key reserved for a different submission", async () => {
    const { transport, calls } = withStore(await seeded(reserved({ identity: "someone-else" })));
    expect(code(await transport.submitClaim(CTX, claim()))).toBe(CH.IDEMPOTENCY_CONFLICT);
    expect(calls).toHaveLength(0);
  });

  it("replays a submission that is already sent", async () => {
    const store = await seeded(
      reserved({
        status: "sent",
        clearinghouseSubmissionId: "winner",
        receivedAt: "2026-10-11T10:01:00.000Z",
      }),
    );
    const { transport, calls } = withStore(store);
    const r = await transport.submitClaim(CTX, claim());
    expect(r.ok && r.data.replayed && r.data.clearinghouseSubmissionId).toBe("winner");
    expect(calls).toHaveLength(0);
  });

  it("retakes a reservation abandoned past the in-flight window and sends under the same key", async () => {
    const store = await seeded(
      reserved({
        firstReservedAt: "2026-10-11T09:30:00.000Z",
        reservedAt: "2026-10-11T09:30:00.000Z",
      }),
    );
    const { transport, calls } = withStore(store);
    const r = await transport.submitClaim(CTX, claim());
    expect(r.ok && !r.data.replayed && r.data.clearinghouseSubmissionId).toBe("mine");
    expect(calls).toHaveLength(1);
  });

  it("refuses to resend a reservation older than Stedi's key window, and says so", async () => {
    const anomalies: StediAnomaly[] = [];
    const store = await seeded(
      reserved({
        firstReservedAt: "2026-10-10T09:00:00.000Z",
        reservedAt: "2026-10-10T09:00:00.000Z",
      }),
    );
    const { transport, calls } = withStore(store, anomalies);
    expect(code(await transport.submitClaim(CTX, claim()))).toBe(CH.UNAVAILABLE);
    expect(calls).toHaveLength(0);
    expect(anomalies).toEqual([{ type: "stale_reservation", idempotencyKey: "idem-1" }]);
  });

  it("answers unavailable, sending nothing, when the reservation cannot be made", async () => {
    const dead: SubmissionAttemptStore = {
      ...bind(new InMemoryAttemptStore()),
      reserve: () => Promise.reject(new Error("db down")),
      complete: () => Promise.reject(new Error("db down")),
      release: () => Promise.reject(new Error("db down")),
      retake: () => Promise.reject(new Error("db down")),
    };
    const { transport, calls } = withStore(dead);
    expect(code(await transport.submitClaim(CTX, claim()))).toBe(CH.UNAVAILABLE);
    expect(calls).toHaveLength(0);
  });

  it("retries completing the record, then reports an unrecorded send without losing the id", async () => {
    let completes = 0;
    const anomalies: StediAnomaly[] = [];
    const base = new InMemoryAttemptStore();
    const flaky: SubmissionAttemptStore = {
      ...bind(base),
      complete: (o, s, k, id, at) =>
        ++completes < 2 ? Promise.reject(new Error("db down")) : base.complete(o, s, k, id, at),
    };
    const ok = await withStore(flaky, anomalies).transport.submitClaim(CTX, claim());
    expect(ok.ok && ok.data.replayed).toBe(false);
    expect(anomalies).toEqual([]);

    const dead: SubmissionAttemptStore = {
      ...flaky,
      complete: () => Promise.reject(new Error("db down")),
    };
    const lost = await withStore(dead, anomalies).transport.submitClaim(
      CTX,
      claim({ idempotencyKey: "k2", controlNumber: "CCN-2" }),
    );
    expect(code(lost)).toBe(CH.UNAVAILABLE);
    // the file WAS taken: the caller is told the send is ambiguous even though the code is a retryable CH_UNAVAILABLE
    expect(!lost.ok && lost.degraded.ambiguous).toBe(true);
    expect(anomalies).toEqual([
      { type: "sent_but_unrecorded", idempotencyKey: "k2", clearinghouseSubmissionId: "mine" },
    ]);
  });

  it("flags a 5xx as ambiguous but a refusal before the request left (the attempt could not be reserved) as clean", async () => {
    const fiveHundred = await harness(
      () => new Response("{}", { status: 503 }),
    ).transport.submitClaim(CTX, claim());
    expect(code(fiveHundred)).toBe(CH.UNAVAILABLE);
    expect(!fiveHundred.ok && fiveHundred.degraded.ambiguous).toBe(true);

    const dead: SubmissionAttemptStore = {
      ...bind(new InMemoryAttemptStore()),
      reserve: () => Promise.reject(new Error("db down")),
    };
    const clean = await withStore(dead).transport.submitClaim(CTX, claim());
    expect(code(clean)).toBe(CH.UNAVAILABLE);
    expect(!clean.ok && clean.degraded.ambiguous).toBeUndefined();
  });

  it("reports an unrecorded send when the reservation vanished before completion", async () => {
    const anomalies: StediAnomaly[] = [];
    const base = new InMemoryAttemptStore();
    const vanishing: SubmissionAttemptStore = {
      ...bind(base),
      complete: () => Promise.resolve(null),
    };
    const r = await withStore(vanishing, anomalies).transport.submitClaim(CTX, claim());
    expect(code(r)).toBe(CH.UNAVAILABLE);
    expect(anomalies.map((a) => a.type)).toEqual(["sent_but_unrecorded"]);
  });
});

function bind(s: SubmissionAttemptStore): SubmissionAttemptStore {
  return {
    reserve: (a) => s.reserve(a),
    complete: (o, sc, k, id, at) => s.complete(o, sc, k, id, at),
    release: (o, sc, k) => s.release(o, sc, k),
    retake: (o, sc, k, e, n) => s.retake(o, sc, k, e, n),
    find: (o, sc, k) => s.find(o, sc, k),
    allocateControlNumber: (u) => s.allocateControlNumber(u),
    allocateInterchangeNumber: (o, sc, k, u) => s.allocateInterchangeNumber(o, sc, k, u),
    resolve: (o, sc, k, out, who, g) => s.resolve(o, sc, k, out, who, g),
  };
}

describe("StediTransport not-yet-implemented methods", () => {
  it("fail closed with CH_NOT_WIRED, never send, never throw", async () => {
    const { calls, transport } = harness();
    const results = [
      await transport.validateOnly(CTX, claim()),
      await transport.checkEligibility(CTX, { mbi: "1EG4-TE5-MK73", serviceDate: "2026-10-01" }),
      await transport.fetchAcknowledgments(CTX, null),
      await transport.fetchRemittances(CTX, null),
      await transport.verifyAndParseEvent({ headers: {}, rawBody: "{}" }),
    ];
    for (const r of results) expect(code(r)).toBe(CH.NOT_WIRED);
    expect(calls).toHaveLength(0);
    expect(transport.vendor).toBe("stedi");
  });
});

describe("StediTransport.fetchClaimStatus (UNVERIFIED vendor shape, #820)", () => {
  const INQUIRY = {
    billingProvider: { organizationName: "Synthetic Hospice", npi: "1234567893" },
    subscriber: {
      memberId: "SYN123456",
      firstName: "Test",
      lastName: "Patient",
      dateOfBirth: "1950-02-03",
    },
    serviceFrom: "2026-03-01",
    serviceTo: "2026-03-31",
  };
  const answer = (code: string) => ({
    claims: [{ claimStatus: { statusInformation: [{ healthCareClaimStatusCategoryCode: code }] } }],
  });

  it("refuses without an inquiry and sends nothing", async () => {
    const { calls, transport } = harness();
    expect(code(await transport.fetchClaimStatus(CTX, "CCN-1"))).toBe(CH.INVALID_REQUEST);
    expect(calls).toHaveLength(0);
  });

  it("refuses an inquiry for another billing NPI than the context", async () => {
    const { calls, transport } = harness();
    const r = await transport.fetchClaimStatus(
      { ...CTX, billingNpi: "1999999992" },
      "CCN-1",
      INQUIRY,
    );
    expect(code(r)).toBe(CH.INVALID_REQUEST);
    expect(calls).toHaveLength(0);
  });

  it("posts the 276 body with the payer from the context and returns the parsed state, never leaking the subscriber", async () => {
    const { calls, transport } = harness(() => Response.json(answer("F1")));
    const r = await transport.fetchClaimStatus(CTX, "000000042", INQUIRY);
    expect(r).toEqual({
      ok: true,
      data: { controlNumber: "000000042", state: "payer_accepted", latest: null },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/claimstatus/");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.tradingPartnerServiceId).toBe("12M41");
    expect(JSON.stringify(r)).not.toContain("SYN123456");
  });

  it("maps a vendor 5xx to a retryable CH_UNAVAILABLE and a network failure to CH_UNAVAILABLE", async () => {
    const down = harness(() => new Response("{}", { status: 503 }));
    expect(code(await down.transport.fetchClaimStatus(CTX, "CCN-1", INQUIRY))).toBe(CH.UNAVAILABLE);
    const dead = harness(() => {
      throw new Error("boom");
    });
    expect(code(await dead.transport.fetchClaimStatus(CTX, "CCN-1", INQUIRY))).toBe(CH.UNAVAILABLE);
  });

  it("never reports not_found when the payer cannot locate the claim", async () => {
    const { transport } = harness(() => Response.json(answer("A4")));
    const r = await transport.fetchClaimStatus(CTX, "CCN-1", INQUIRY);
    expect(r.ok).toBe(false);
    expect(code(r)).toBe(CH.UNAVAILABLE);
  });
});

describe("createStediTransportFromEnv", () => {
  it("throws naming only the key when STEDI_API_KEY is missing or blank", () => {
    const attempts = new InMemoryAttemptStore();
    expect(() => createStediTransportFromEnv({}, attempts)).toThrow(/STEDI_API_KEY/);
    expect(() => createStediTransportFromEnv({ STEDI_API_KEY: "  " }, attempts)).toThrow(
      /STEDI_API_KEY/,
    );
  });
  it("builds a stedi transport from the key alone", () => {
    const t = createStediTransportFromEnv({ STEDI_API_KEY: KEY }, new InMemoryAttemptStore());
    expect(t.vendor).toBe("stedi");
  });
});
