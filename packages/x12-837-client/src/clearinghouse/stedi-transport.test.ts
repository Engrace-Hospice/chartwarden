import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryAttemptStore } from "./attempt-store";
import { StediTransport, createStediTransportFromEnv } from "./stedi-transport";
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
  const transport = new StediTransport({ apiKey: KEY, fetch: fetchImpl, attempts });
  return { calls, transport, attempts };
}

function claim(overrides: Partial<ClearinghouseSubmission> = {}): ClearinghouseSubmission {
  return {
    kind: "claim",
    controlNumber: "CCN-1",
    idempotencyKey: "idem-1",
    payload: { format: "x12", x12: CLAIM_X12 },
    ...overrides,
  };
}
const notice = (overrides: Partial<ClearinghouseSubmission> = {}): ClearinghouseSubmission => ({
  kind: "noe",
  controlNumber: "NOE-1",
  idempotencyKey: "idem-noe-1",
  payload: { format: "x12", x12: NOE_X12 },
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
    expect(headers.get("idempotency-key")).toBe("idem-1");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ x12: CLAIM_X12 });
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
          claim({ payload: { format: "x12", x12: `${CLAIM_X12} ` } }),
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
    const other = await transport.submitClaim({ ...CTX, organizationId: "org-2" }, claim());
    expect(other.ok && !other.data.replayed).toBe(true);
    expect(calls).toHaveLength(2);
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
    const bad = CLAIM_X12.replace(/CLM\*([^*]*)\*[0-9.]+/, "CLM*$1*1");
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
    if (expected === CH.UNAVAILABLE) expect(RETRYABLE_CODES.has(expected)).toBe(true);
  });

  it("records nothing on a failure, so the same submission can be retried and sent again", async () => {
    let n = 0;
    const { calls, transport } = harness(() =>
      ++n === 1
        ? new Response("{}", { status: 503 })
        : Response.json({ claimReference: { correlationId: "later" } }),
    );
    expect(code(await transport.submitClaim(CTX, claim()))).toBe(CH.UNAVAILABLE);
    const retry = await transport.submitClaim(CTX, claim());
    expect(retry.ok && !retry.data.replayed).toBe(true);
    expect(new Headers(calls[1]?.init.headers).get("idempotency-key")).toBe("idem-1");
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

describe("StediTransport not-yet-implemented methods", () => {
  it("fail closed with CH_NOT_WIRED, never send, never throw", async () => {
    const { calls, transport } = harness();
    const results = [
      await transport.validateOnly(CTX, claim()),
      await transport.checkEligibility(CTX, { mbi: "1EG4-TE5-MK73", serviceDate: "2026-10-01" }),
      await transport.fetchAcknowledgments(CTX, null),
      await transport.fetchRemittances(CTX, null),
      await transport.fetchClaimStatus(CTX, "CCN-1"),
      await transport.verifyAndParseEvent({ headers: {}, rawBody: "{}" }),
    ];
    for (const r of results) expect(code(r)).toBe(CH.NOT_WIRED);
    expect(calls).toHaveLength(0);
    expect(transport.vendor).toBe("stedi");
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
