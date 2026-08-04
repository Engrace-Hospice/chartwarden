// M35-T04 — §4.13/§4.14/§8.7 Stripe adapter pure cores (verifier / redactor / idempotency / dispatcher /
// webhook ingestion). Pure, no DB — in-memory fakes for every injected port.
import { createHmac } from "node:crypto";
import type { OrgId, StripeApiCallAuditId } from "@wardenx/types";
import { describe, expect, it, vi } from "vitest";
import { createStripeClient, failClosedStripeHttpPort } from "../src/stripe/client";
import {
  STRIPE_MAX_ATTEMPTS,
  type StripeDispatcherDeps,
  dispatchStripeCall,
} from "../src/stripe/dispatcher";
import { STRIPE_IDEMPOTENCY_PREFIX, deriveIdempotencyKey } from "../src/stripe/idempotency";
import { REDACTED, redactForAudit } from "../src/stripe/redactor";
import type {
  StripeApiCallAuditStore,
  StripeApiError,
  StripeApiResponse,
  StripeDispatchEvent,
  StripeHttpPort,
  StripeMirrorApplier,
  StripeWebhookEventStore,
  WebhookPayloadEncryptor,
} from "../src/stripe/types";
import {
  WEBHOOK_MAX_AGE_DAYS,
  type WebhookIngestDeps,
  ingestStripeWebhook,
} from "../src/stripe/webhook-handler";
import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  StripeSignatureError,
  verifyStripeWebhook,
} from "../src/stripe/webhook-verifier";

const ORG = "11111111-1111-1111-1111-111111111111" as OrgId;

// ── redactor (§8.7) ─────────────────────────────────────────────────────────────────────────────────────
describe("redactForAudit (§8.7)", () => {
  it("redacts values under denylisted keys, preserving structure", () => {
    const out = redactForAudit({
      customer: "cus_123",
      card: { number: "4242424242424242", cvc: "123", brand: "visa" },
      client_secret: "seti_abc_secret_xyz",
      amount: 5000,
    }) as Record<string, unknown>;
    expect(out.amount).toBe(5000);
    expect((out.card as Record<string, unknown>).brand).toBe("visa");
    expect((out.card as Record<string, unknown>).number).toBe(REDACTED);
    expect((out.card as Record<string, unknown>).cvc).toBe(REDACTED);
    expect(out.client_secret).toBe(REDACTED);
    // `customer` is not denylisted and its value is not secret-shaped
    expect(out.customer).toBe("cus_123");
  });

  it("redacts secret-shaped VALUES regardless of key", () => {
    const out = redactForAudit({
      note: "the key is sk_live_ABCDEF1234567890",
      ok: "plain",
    }) as Record<string, unknown>;
    expect(out.note).toBe(REDACTED);
    expect(out.ok).toBe("plain");
  });

  it("redacts a bare PAN-length digit run", () => {
    const out = redactForAudit({ ref: "4242 4242 4242 4242" }) as Record<string, unknown>;
    expect(out.ref).toBe(REDACTED);
  });

  it("walks arrays and never mutates the input", () => {
    const input = { items: [{ token: "tok_secret" }, { safe: 1 }] };
    const out = redactForAudit(input) as { items: Array<Record<string, unknown>> };
    expect(out.items[0].token).toBe(REDACTED);
    expect(out.items[1].safe).toBe(1);
    expect(input.items[0].token).toBe("tok_secret"); // untouched
  });

  it("is total on primitives and cycles", () => {
    expect(redactForAudit(42)).toBe(42);
    expect(redactForAudit(null)).toBe(null);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = redactForAudit(cyclic) as Record<string, unknown>;
    expect(out.a).toBe(1);
    expect(out.self).toBe(REDACTED);
  });
});

// ── idempotency (§4.13/§4.16) ───────────────────────────────────────────────────────────────────────────
describe("deriveIdempotencyKey (§4.13)", () => {
  it("is deterministic and shaped stripe-idem-{op}-{businessKey}-{attempt}", () => {
    const ev = { operation: "subscription.update", businessKey: "sub_1", attemptIndex: 0 } as const;
    expect(deriveIdempotencyKey(ev)).toBe(
      `${STRIPE_IDEMPOTENCY_PREFIX}-subscription.update-sub_1-0`,
    );
    expect(deriveIdempotencyKey(ev)).toBe(deriveIdempotencyKey(ev));
  });

  it("changes with the attempt index (each attempt is individually keyed)", () => {
    const a = deriveIdempotencyKey({
      operation: "invoice.pay",
      businessKey: "in_1",
      attemptIndex: 0,
    });
    const b = deriveIdempotencyKey({
      operation: "invoice.pay",
      businessKey: "in_1",
      attemptIndex: 1,
    });
    expect(a).not.toBe(b);
  });

  it("sanitizes odd businessKey bytes and rejects empties / bad attempts", () => {
    expect(
      deriveIdempotencyKey({ operation: "refund.create", businessKey: "a b/c", attemptIndex: 0 }),
    ).toBe(`${STRIPE_IDEMPOTENCY_PREFIX}-refund.create-a-b-c-0`);
    expect(() =>
      deriveIdempotencyKey({ operation: "refund.create", businessKey: "", attemptIndex: 0 }),
    ).toThrow();
    expect(() =>
      deriveIdempotencyKey({ operation: "refund.create", businessKey: "x", attemptIndex: -1 }),
    ).toThrow();
  });
});

// ── webhook verifier (§4.14) ────────────────────────────────────────────────────────────────────────────
const SECRET = "whsec_test_secret";
function signedHeader(rawBody: string, tSeconds: number, secret = SECRET): string {
  const sig = createHmac("sha256", secret).update(`${tSeconds}.${rawBody}`).digest("hex");
  return `t=${tSeconds},v1=${sig}`;
}
function eventBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt_1",
    type: "invoice.paid",
    created: 1_700_000_000,
    api_version: "2024-06-20",
    ...overrides,
  });
}

describe("verifyStripeWebhook (§4.14)", () => {
  const created = 1_700_000_000;
  const nowMs = created * 1000;

  it("accepts a valid signature within tolerance and parses the envelope", () => {
    const raw = eventBody();
    const env = verifyStripeWebhook({
      rawBody: raw,
      signatureHeader: signedHeader(raw, created),
      webhookSecret: SECRET,
      nowMs,
    });
    expect(env.id).toBe("evt_1");
    expect(env.type).toBe("invoice.paid");
    expect(env.apiVersion).toBe("2024-06-20");
    expect(env.created).toBe(created);
  });

  it("rejects a tampered body (HMAC mismatch)", () => {
    const raw = eventBody();
    const header = signedHeader(raw, created);
    expect(() =>
      verifyStripeWebhook({
        rawBody: raw + " ",
        signatureHeader: header,
        webhookSecret: SECRET,
        nowMs,
      }),
    ).toThrow(StripeSignatureError);
  });

  it("rejects the wrong secret", () => {
    const raw = eventBody();
    expect(() =>
      verifyStripeWebhook({
        rawBody: raw,
        signatureHeader: signedHeader(raw, created, "whsec_other"),
        webhookSecret: SECRET,
        nowMs,
      }),
    ).toThrow(StripeSignatureError);
  });

  it("rejects a missing/blank header and a missing secret", () => {
    const raw = eventBody();
    expect(() =>
      verifyStripeWebhook({
        rawBody: raw,
        signatureHeader: undefined,
        webhookSecret: SECRET,
        nowMs,
      }),
    ).toThrow();
    expect(() =>
      verifyStripeWebhook({ rawBody: raw, signatureHeader: "", webhookSecret: SECRET, nowMs }),
    ).toThrow();
    expect(() =>
      verifyStripeWebhook({
        rawBody: raw,
        signatureHeader: signedHeader(raw, created),
        webhookSecret: "",
        nowMs,
      }),
    ).toThrow();
  });

  it("rejects a timestamp outside the tolerance window", () => {
    const raw = eventBody();
    const farNow = (created + DEFAULT_SIGNATURE_TOLERANCE_SECONDS + 5) * 1000;
    expect(() =>
      verifyStripeWebhook({
        rawBody: raw,
        signatureHeader: signedHeader(raw, created),
        webhookSecret: SECRET,
        nowMs: farNow,
      }),
    ).toThrow(StripeSignatureError);
  });

  it("rejects a malformed header and a body missing required fields", () => {
    const raw = eventBody();
    expect(() =>
      verifyStripeWebhook({
        rawBody: raw,
        signatureHeader: "garbage",
        webhookSecret: SECRET,
        nowMs,
      }),
    ).toThrow();
    const noId = JSON.stringify({ type: "x", created });
    expect(() =>
      verifyStripeWebhook({
        rawBody: noId,
        signatureHeader: signedHeader(noId, created),
        webhookSecret: SECRET,
        nowMs,
      }),
    ).toThrow();
  });
});

// ── dispatcher (§4.13) ──────────────────────────────────────────────────────────────────────────────────
function fakeAuditStore(overrides: Partial<StripeApiCallAuditStore> = {}): {
  store: StripeApiCallAuditStore;
  calls: { success: number; failure: number; inserted: number };
} {
  const calls = { success: 0, failure: 0, inserted: 0 };
  const store: StripeApiCallAuditStore = {
    hasSucceededForIdempotencyKey: async () => false,
    insertCall: async () => {
      calls.inserted++;
      return { auditId: "audit-1" as StripeApiCallAuditId };
    },
    recordSuccess: async () => {
      calls.success++;
    },
    recordFailure: async () => {
      calls.failure++;
    },
    ...overrides,
  };
  return { store, calls };
}

const dispatchEvent: StripeDispatchEvent = {
  operation: "subscription.update",
  businessKey: "sub_1",
  targetResourceId: "sub_1",
  organizationId: ORG,
  payload: { cancel_at_period_end: true, client_secret: "seti_secret" },
  attemptIndex: 0,
};

describe("dispatchStripeCall (§4.13)", () => {
  it("no-ops when a prior call with the same idempotency key already succeeded", async () => {
    const { store, calls } = fakeAuditStore({ hasSucceededForIdempotencyKey: async () => true });
    const client = { execute: vi.fn() };
    const mirror: StripeMirrorApplier = { apply: vi.fn() };
    const deps: StripeDispatcherDeps = { client, auditStore: store, mirror, nowMs: () => 0 };
    const out = await dispatchStripeCall(deps, dispatchEvent);
    expect(out.kind).toBe("noop");
    expect(client.execute).not.toHaveBeenCalled();
    expect(calls.inserted).toBe(0);
  });

  it("records a redacted request, calls Stripe with the idempotency key, applies the mirror on 2xx", async () => {
    const { store, calls } = fakeAuditStore();
    const insertSpy = vi.spyOn(store, "insertCall");
    const response: StripeApiResponse = {
      statusCode: 200,
      body: { id: "sub_1", client_secret: "leaked" },
    };
    const client: StripeHttpPort = { execute: vi.fn(async () => response) };
    const apply = vi.fn();
    const mirror: StripeMirrorApplier = { apply };
    let t = 1000;
    const deps: StripeDispatcherDeps = { client, auditStore: store, mirror, nowMs: () => (t += 5) };
    const out = await dispatchStripeCall(deps, dispatchEvent);
    expect(out.kind).toBe("succeeded");
    expect(calls.success).toBe(1);
    expect(apply).toHaveBeenCalledOnce();
    // request envelope redacted before it reaches the store
    const inserted = insertSpy.mock.calls[0][0];
    expect((inserted.requestEnvelopeRedacted as Record<string, unknown>).client_secret).toBe(
      REDACTED,
    );
    // Stripe called with the deterministic key
    expect((client.execute as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({
      idempotencyKey: deriveIdempotencyKey(dispatchEvent),
    });
  });

  it("rethrows a retryable error below the attempt ceiling (BullMQ backoff), recording the failure", async () => {
    const { store, calls } = fakeAuditStore();
    const err: StripeApiError = { message: "rate limited", statusCode: 429, retryable: true };
    const client: StripeHttpPort = { execute: async () => Promise.reject(err) };
    const mirror: StripeMirrorApplier = { apply: vi.fn() };
    const deps: StripeDispatcherDeps = { client, auditStore: store, mirror, nowMs: () => 0 };
    await expect(dispatchStripeCall(deps, { ...dispatchEvent, attemptIndex: 1 })).rejects.toBe(err);
    expect(calls.failure).toBe(1);
  });

  it("returns the api_call_failed outbox intent on a permanent failure", async () => {
    const { store } = fakeAuditStore();
    const err: StripeApiError = { message: "card declined", statusCode: 402, retryable: false };
    const client: StripeHttpPort = { execute: async () => Promise.reject(err) };
    const mirror: StripeMirrorApplier = { apply: vi.fn() };
    const deps: StripeDispatcherDeps = { client, auditStore: store, mirror, nowMs: () => 0 };
    const out = await dispatchStripeCall(deps, dispatchEvent);
    expect(out.kind).toBe("failed_permanent");
    if (out.kind === "failed_permanent") {
      expect(out.outbox).toHaveLength(1);
      expect(out.outbox[0].eventName).toBe("m35.stripe.api_call_failed");
    }
  });

  it("DLQs (does not rethrow) a retryable error at the attempt ceiling", async () => {
    const { store } = fakeAuditStore();
    const err: StripeApiError = { message: "still failing", statusCode: 503, retryable: true };
    const client: StripeHttpPort = { execute: async () => Promise.reject(err) };
    const mirror: StripeMirrorApplier = { apply: vi.fn() };
    const deps: StripeDispatcherDeps = { client, auditStore: store, mirror, nowMs: () => 0 };
    const out = await dispatchStripeCall(deps, {
      ...dispatchEvent,
      attemptIndex: STRIPE_MAX_ATTEMPTS,
    });
    expect(out.kind).toBe("failed_permanent");
  });
});

// ── client fail-closed default ──────────────────────────────────────────────────────────────────────────
describe("failClosedStripeHttpPort", () => {
  it("rejects every call until a live transport is wired", async () => {
    const client = createStripeClient(failClosedStripeHttpPort());
    await expect(
      client.execute({ operation: "customer.create", payload: {} }, { idempotencyKey: "k" }),
    ).rejects.toThrow(/STRIPE_NOT_CONFIGURED/);
  });
});

// ── webhook ingestion (§4.14) ───────────────────────────────────────────────────────────────────────────
function fakeWebhookDeps(overrides: Partial<WebhookIngestDeps> = {}): {
  deps: WebhookIngestDeps;
  inserted: Array<{ id: string }>;
} {
  const inserted: Array<{ id: string }> = [];
  const store: StripeWebhookEventStore = {
    insertIfNew: async (row) => {
      if (inserted.some((r) => r.id === row.id)) return { inserted: false };
      inserted.push({ id: row.id });
      return { inserted: true };
    },
  };
  const encryptor: WebhookPayloadEncryptor = {
    encrypt: (pt) => ({ ciphertext: `enc(${pt.length})`, dekRef: "dek-1" }),
  };
  const created = 1_700_000_000;
  const deps: WebhookIngestDeps = {
    store,
    encryptor,
    webhookSecret: SECRET,
    nowMs: () => created * 1000,
    ...overrides,
  };
  return { deps, inserted };
}

describe("ingestStripeWebhook (§4.14)", () => {
  const created = 1_700_000_000;

  it("verifies, dedups, and emits exactly one webhook_received intent on first receipt", async () => {
    const { deps, inserted } = fakeWebhookDeps();
    const raw = eventBody({ created });
    const res = await ingestStripeWebhook(deps, {
      rawBody: raw,
      signatureHeader: signedHeader(raw, created),
    });
    expect(res.kind).toBe("accepted");
    if (res.kind === "accepted") {
      expect(res.stripeEventId).toBe("evt_1");
      expect(res.outbox).toHaveLength(1);
      expect(res.outbox[0].eventName).toBe("m35.stripe.webhook_received");
    }
    expect(inserted).toHaveLength(1);
  });

  it("returns duplicate (no new outbox) on a replay of the same event id", async () => {
    const { deps } = fakeWebhookDeps();
    const raw = eventBody({ created });
    const header = signedHeader(raw, created);
    await ingestStripeWebhook(deps, { rawBody: raw, signatureHeader: header });
    const res = await ingestStripeWebhook(deps, { rawBody: raw, signatureHeader: header });
    expect(res.kind).toBe("duplicate");
  });

  it("returns invalid_signature on a bad signature (no store write)", async () => {
    const { deps, inserted } = fakeWebhookDeps();
    const raw = eventBody({ created });
    const res = await ingestStripeWebhook(deps, {
      rawBody: raw,
      signatureHeader: "t=1,v1=deadbeef",
    });
    expect(res.kind).toBe("invalid_signature");
    expect(inserted).toHaveLength(0);
  });

  it("returns too_old for an event beyond the 30-day replay window", async () => {
    const oldCreated = created;
    const nowMs = (oldCreated + (WEBHOOK_MAX_AGE_DAYS + 1) * 86_400) * 1000;
    const { deps } = fakeWebhookDeps({
      nowMs: () => nowMs,
      toleranceSeconds: Number.MAX_SAFE_INTEGER,
    });
    const raw = eventBody({ created: oldCreated });
    const res = await ingestStripeWebhook(deps, {
      rawBody: raw,
      signatureHeader: signedHeader(raw, oldCreated),
    });
    expect(res.kind).toBe("too_old");
  });

  it("carries a resolved derivedOrganizationId onto the intent", async () => {
    const { deps } = fakeWebhookDeps({ resolveOrgFromEvent: () => ORG });
    const raw = eventBody({ created });
    const res = await ingestStripeWebhook(deps, {
      rawBody: raw,
      signatureHeader: signedHeader(raw, created),
    });
    expect(res.kind).toBe("accepted");
    if (res.kind === "accepted") {
      expect(
        (res.outbox[0].payload as { derivedOrganizationId: unknown }).derivedOrganizationId,
      ).toBe(ORG);
    }
  });
});
