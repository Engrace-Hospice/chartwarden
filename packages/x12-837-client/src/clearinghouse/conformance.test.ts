import { describe, expect, it } from "vitest";
import {
  CLEARINGHOUSE_CONFORMANCE_CASES,
  type ClearinghouseHarness,
  runClearinghouseConformance,
  runConformance,
} from "./conformance";
import { createInMemoryHarness } from "./in-memory-transport";
import {
  CH,
  type ClearinghouseContext,
  type ClearinghouseSubmission,
  type ClearinghouseTransport,
  type SubmissionReceipt,
} from "./types";

describe("in-memory clearinghouse transport", () => {
  for (const c of CLEARINGHOUSE_CONFORMANCE_CASES) {
    it(`${c.id}: ${c.title}`, async () => {
      await c.run(createInMemoryHarness());
    });
  }

  it("has a unique id for every conformance case", () => {
    const ids = CLEARINGHOUSE_CONFORMANCE_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// The suite must have teeth: a transport that breaks one rule has to fail the case guarding it.
describe("conformance suite catches broken transports", () => {
  function mutant(patch: (t: ClearinghouseTransport) => Partial<ClearinghouseTransport>) {
    return async (): Promise<ClearinghouseHarness> => {
      const base = createInMemoryHarness();
      const patched = Object.assign(Object.create(base.transport), patch(base.transport));
      return { transport: patched as ClearinghouseTransport, script: base.script };
    };
  }

  it("flags a transport that never reports a replay", async () => {
    const failures = await runClearinghouseConformance(
      mutant((t) => ({
        submitClaim: async (ctx, s) => {
          const r = await t.submitClaim(ctx, s);
          return r.ok ? { ok: true, data: { ...r.data, replayed: false } } : r;
        },
      })),
    );
    expect(failures.map((f) => f.id)).toContain("C04-idempotent-submission");
  });

  it("flags a transport that cannot carry a transfer notice", async () => {
    const failures = await runClearinghouseConformance(
      mutant((t) => ({
        submitNotice: async (ctx, s) =>
          s.kind === "transfer_notice"
            ? { ok: false, degraded: { code: CH.INVALID_REQUEST, reason: "no" } }
            : t.submitNotice(ctx, s),
      })),
    );
    expect(failures.map((f) => f.id)).toContain("C03-notice-kind-routing");
  });

  it("flags a transport that folds a payer partial into a rejection", async () => {
    const failures = await runClearinghouseConformance(
      mutant((t) => ({
        fetchClaimStatus: async (ctx, n) => {
          const r = await t.fetchClaimStatus(ctx, n);
          return r.ok && r.data.state === "payer_partial"
            ? { ok: true, data: { ...r.data, state: "payer_rejected" } }
            : r;
        },
      })),
    );
    expect(failures.map((f) => f.id)).toContain("C07b-payer-partial-acceptance");
  });

  it("flags a transport that echoes the MBI", async () => {
    const failures = await runClearinghouseConformance(
      mutant((t) => ({
        checkEligibility: async (ctx, req) => {
          const r = await t.checkEligibility(ctx, req);
          return r.ok
            ? { ok: true, data: { ...r.data, mbi: "mbi" in req ? req.mbi : "" } as typeof r.data }
            : r;
        },
      })),
    );
    expect(failures.map((f) => f.id)).toContain("C01-eligibility-outcome-only");
  });

  it("flags a transport whose dry-run creates a submission", async () => {
    const failures = await runClearinghouseConformance(
      mutant((t) => ({
        validateOnly: async (ctx, s) => {
          await t.submitClaim(ctx, s);
          return t.validateOnly(ctx, s);
        },
      })),
    );
    expect(failures.map((f) => f.id)).toContain("C02-validate-only-has-no-side-effects");
  });

  it("flags a transport that throws instead of degrading", async () => {
    const failures = await runClearinghouseConformance(
      mutant(() => ({
        fetchRemittances: async () => {
          throw new Error("boom");
        },
      })),
    );
    expect(failures.map((f) => f.id)).toContain("C10-remittance");
  });

  it("flags a transport that accepts a tampered webhook", async () => {
    const failures = await runClearinghouseConformance(
      mutant((t) => ({
        verifyAndParseEvent: async (hook) => {
          const r = await t.verifyAndParseEvent(hook);
          return r.ok
            ? r
            : {
                ok: true,
                data: {
                  eventId: "evt-11",
                  kind: "acknowledgment_available",
                  reference: "CCN-0011",
                  occurredAt: "2026-10-11T00:00:00.000Z",
                },
              };
        },
      })),
    );
    expect(failures.map((f) => f.id)).toContain("C11-push-events");
  });

  const WRONG_ORG = { organizationId: "org-conf", providerEntityId: "pe-conf" } as const;

  it.each([
    ["acknowledgments", "fetchAcknowledgments"],
    ["remittances", "fetchRemittances"],
    ["status", "fetchClaimStatus"],
  ] as const)("flags a transport that ignores the usage mode on %s", async (_label, method) => {
    const failures = await runClearinghouseConformance(
      mutant((t) => ({
        [method]: (ctx: ClearinghouseContext, arg: never) =>
          (t[method] as (c: ClearinghouseContext, a: never) => unknown)(
            { ...ctx, usage: "test" },
            arg,
          ),
      })),
    );
    expect(failures.map((f) => f.id)).toContain("C14-test-production-isolation");
  });

  it.each([
    ["acknowledgments", "fetchAcknowledgments"],
    ["remittances", "fetchRemittances"],
    ["status", "fetchClaimStatus"],
  ] as const)("flags a transport that leaks %s across tenants", async (_label, method) => {
    const failures = await runClearinghouseConformance(
      mutant((t) => ({
        [method]: (ctx: ClearinghouseContext, arg: never) =>
          (t[method] as (c: ClearinghouseContext, a: never) => unknown)(
            { ...ctx, ...WRONG_ORG },
            arg,
          ),
      })),
    );
    expect(failures.map((f) => f.id)).toContain("C15-tenant-isolation");
  });

  it("flags a transport whose status regresses on a late clearinghouse ack", async () => {
    const failures = await runClearinghouseConformance(
      mutant((t) => ({
        fetchClaimStatus: async (ctx, n) => {
          const r = await t.fetchClaimStatus(ctx, n);
          if (!r.ok || r.data.state === "not_found") return r;
          const acks = await t.fetchAcknowledgments(ctx, null);
          const last = acks.ok
            ? acks.data.items.filter((a) => a.controlNumber === n).at(-1)
            : undefined;
          return last?.stage === "clearinghouse"
            ? {
                ok: true,
                data: { ...r.data, state: "clearinghouse_accepted" as const, latest: last },
              }
            : r;
        },
      })),
    );
    expect(failures.map((f) => f.id)).toContain("C16-out-of-order-acks");
  });

  it("flags a transport that treats a malformed cursor as the start", async () => {
    const failures = await runClearinghouseConformance(
      mutant((t) => ({
        fetchAcknowledgments: (ctx, c) =>
          t.fetchAcknowledgments(ctx, c !== null && !/^\d+$/.test(c) ? null : c),
      })),
    );
    expect(failures.map((f) => f.id)).toContain("C17-cursor-validation");
  });

  it("flags a transport that binds the idempotency key to the payload only", async () => {
    // A payload-only identity: remember the first receipt per payload and replay it for anything sharing it,
    // whatever the key, control number, kind or adjustment.
    const failures = await runClearinghouseConformance(async () => {
      const base = createInMemoryHarness();
      const seen = new Map<string, SubmissionReceipt>();
      const key = (s: ClearinghouseSubmission): string => JSON.stringify(s.payload);
      const wrap =
        (call: ClearinghouseTransport["submitClaim"]): ClearinghouseTransport["submitClaim"] =>
        async (ctx, s) => {
          const prior = seen.get(key(s));
          if (prior && s.payload.format === "x12" && s.idempotencyKey === prior.idempotencyKey) {
            return { ok: true, data: { ...prior, replayed: true } };
          }
          const r = await call(ctx, s);
          if (r.ok) seen.set(key(s), r.data);
          return r;
        };
      const patched = Object.assign(Object.create(base.transport), {
        submitClaim: wrap(base.transport.submitClaim.bind(base.transport)),
        submitNotice: wrap(base.transport.submitNotice.bind(base.transport)),
      });
      return { transport: patched as ClearinghouseTransport, script: base.script };
    });
    expect(failures.map((f) => f.id)).toContain("C18-idempotency-identity");
  });

  it("refuses a signed event whose kind is unknown", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "unit-test-secret";
    const hmac = (body: string): string => createHmac("sha256", secret).update(body).digest("hex");
    const { transport } = createInMemoryHarness({ webhookSecret: secret });
    const rawBody = JSON.stringify({
      eventId: "evt-x",
      kind: "something_else",
      reference: "CCN-1",
      occurredAt: "2026-10-11T00:00:00.000Z",
    });
    const r = await transport.verifyAndParseEvent({
      headers: { "x-clearinghouse-signature": hmac(rawBody) },
      rawBody,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.degraded.code).toBe("CH_INVALID_REQUEST");
  });

  it("flags a transport that sends during an outage as if it had filed", async () => {
    // Reports success on the first send, then replays it: an outage that was recorded as sent.
    const failures = await runClearinghouseConformance(
      mutant((t) => ({
        submitClaim: async (ctx, s) => {
          const r = await t.submitClaim(ctx, s);
          return r.ok
            ? r
            : {
                ok: true,
                data: {
                  clearinghouseSubmissionId: "x",
                  idempotencyKey: s.idempotencyKey,
                  controlNumber: s.controlNumber,
                  receivedAt: "2026-10-11T00:00:00.000Z",
                  replayed: true,
                },
              };
        },
      })),
    );
    expect(failures.map((f) => f.id)).toContain("S01-submit-outage-fails-closed");
  });

  it("flags a transport that shares submission state across usage modes", async () => {
    const failures = await runClearinghouseConformance(
      mutant((t) => ({
        submitClaim: (ctx, s) => t.submitClaim({ ...ctx, usage: "test" }, s),
      })),
    );
    expect(failures.map((f) => f.id)).toContain("S02-submit-tenant-and-mode-isolation");
  });

  it("skips, by name, the cases a harness does not declare capabilities for", async () => {
    const outcomes = await runConformance(async () => ({
      ...createInMemoryHarness(),
      capabilities: new Set(["submit"]),
    }));
    expect(outcomes.find((o) => o.id === "C10-remittance")).toMatchObject({
      status: "skipped",
      missing: ["receive"],
    });
    expect(outcomes.find((o) => o.id === "C04-idempotent-submission")?.status).toBe("passed");
  });

  it("passes the reference transport with no failures", async () => {
    const failures = await runClearinghouseConformance(async () => createInMemoryHarness());
    expect(failures).toEqual([]);
  });
});
