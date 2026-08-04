// packages/dosespot/__tests__/dosespot-adapter.test.ts — M12-T06 (spec §2.5 / §4.10 / §7.4 / §2.6 / D5 / D7 /
// D8 / D4). The adapter package's pure surface: the INT-009 DegradedError, the per-tenant circuit breaker
// transitions + degraded/recovered edges, the per-call backoff schedule, the Phase-1 deny-stub, the §7.4 D7
// webhook security envelope (HMAC constant-time verify + 5-min replay window + dedup key + body digest), the
// D8 NewRx idempotency-key determinism (cosmetic-sig folding; correction distinctness), the
// `medication_order_transmission` enqueue/success/failure planners (retry-exhaustion → M36 alert), and the §2.6
// D4 patient-sync planner. No live infra — the HTTP transport is deferred; this proves the contract M12 depends on.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DOSESPOT_CIRCUIT_BREAKER_CONFIG,
  DegradedError,
  INITIAL_BREAKER_SNAPSHOT,
  PATIENT_SYNC_MAX_RETRIES,
  type PatientSyncSnapshot,
  RX_TRANSMISSION_MAX_RETRIES,
  RetryableError,
  applyOutcome,
  buildPatientUpsertPayload,
  canonicalizeSig,
  classifyRetryableStatus,
  computeBackoffDelays,
  computeNewRxIdempotencyKey,
  computeRxBusinessKey,
  computeWebhookSignature,
  createUnboundDoseSpotClient,
  didTransition,
  evaluateBreaker,
  isDegradedError,
  isRetryableError,
  nextRetryDecision,
  openCircuitError,
  patientSyncIdempotencyKey,
  planPatientSync,
  planPatientSyncFailure,
  planTransmissionEnqueue,
  planTransmissionFailure,
  planTransmissionSuccess,
  signaturesMatch,
  verifyWebhookEnvelope,
  webhookBodyDigest,
  webhookDedupKey,
} from "../src/index";

// ── client/errors.ts — the INT-009 DegradedError + the in-call RetryableError ─────────────────────────

describe("DegradedError (INT-009 five-field shape)", () => {
  it("carries integration / operation / retryable / customerMessage / correlationId", () => {
    const e = new DegradedError("dosespot", "transmitNewRx", true, "transient 503", "corr-1");
    expect(e.integration).toBe("dosespot");
    expect(e.operation).toBe("transmitNewRx");
    expect(e.retryable).toBe(true);
    expect(e.customerMessage).toBe("transient 503");
    expect(e.correlationId).toBe("corr-1");
    expect(e.message).toContain("[dosespot/transmitNewRx]");
    expect(e.message).toContain("corr-1");
    expect(isDegradedError(e)).toBe(true);
    expect(isDegradedError(new Error("x"))).toBe(false);
  });
});

describe("RetryableError", () => {
  it("narrows and never leaks PHI (only reason + class)", () => {
    const e = new RetryableError("rate_limited", "rate_limited");
    expect(isRetryableError(e)).toBe(true);
    expect(isRetryableError(new Error("x"))).toBe(false);
    expect(e.message).not.toContain("patient");
  });
});

// ── client/circuit-breaker.ts ─────────────────────────────────────────────────────────────────────────

describe("per-tenant circuit breaker (§2.5: 5 failures / 60s → open 30s → half-open 1 probe)", () => {
  it("opens at the failure threshold within the window", () => {
    let snap = INITIAL_BREAKER_SNAPSHOT;
    const base = Date.parse("2026-06-22T00:00:00.000Z");
    for (let i = 0; i < DOSESPOT_CIRCUIT_BREAKER_CONFIG.failureThreshold; i++) {
      snap = applyOutcome(snap, "failure", new Date(base + i * 1000).toISOString());
    }
    expect(snap.state).toBe("open");
    const before = INITIAL_BREAKER_SNAPSHOT;
    expect(didTransition(before, snap)).toBe("opened");
  });

  it("does not open when failures age out of the 60s window", () => {
    let snap = INITIAL_BREAKER_SNAPSHOT;
    const base = Date.parse("2026-06-22T00:00:00.000Z");
    // 4 failures inside window, then one 61s later (the first 4 prune out).
    for (let i = 0; i < 4; i++)
      snap = applyOutcome(snap, "failure", new Date(base + i * 1000).toISOString());
    snap = applyOutcome(snap, "failure", new Date(base + 61_000).toISOString());
    expect(snap.state).toBe("closed");
  });

  it("half-opens after the open duration and closes on probe success", () => {
    let snap = INITIAL_BREAKER_SNAPSHOT;
    const base = Date.parse("2026-06-22T00:00:00.000Z");
    for (let i = 0; i < 5; i++)
      snap = applyOutcome(snap, "failure", new Date(base + i * 1000).toISOString());
    expect(snap.state).toBe("open");
    // Before cooldown → still open, denied (cooldown is measured from the last-failure `openedAt` = base+4s).
    const hot = evaluateBreaker(snap, new Date(base + 10_000).toISOString());
    expect(hot).toEqual({ effectiveState: "open", allowed: false });
    // After the 30s open duration elapses (well past openedAt) → half-open, allowed.
    const cooled = evaluateBreaker(snap, new Date(base + 40_000).toISOString());
    expect(cooled).toEqual({ effectiveState: "half_open", allowed: true });
    // Probe success closes + emits the recovered edge.
    const closed = applyOutcome(
      { ...snap, state: "half_open" },
      "success",
      new Date(base + 40_500).toISOString(),
    );
    expect(closed.state).toBe("closed");
    expect(didTransition(snap, closed)).toBe("closed");
  });

  it("openCircuitError is retryable + PHI-free", () => {
    const e = openCircuitError("transmitNewRx", "corr-9");
    expect(e.retryable).toBe(true);
    expect(e.operation).toBe("transmitNewRx");
  });
});

// ── client/retry.ts ───────────────────────────────────────────────────────────────────────────────────

describe("per-call backoff (§4.10: 3 attempts / base 250ms)", () => {
  it("computes the 250/500/1000 schedule", () => {
    expect(computeBackoffDelays()).toEqual([250, 500, 1000]);
  });
  it("stops retrying once attempts exhaust", () => {
    expect(nextRetryDecision(0)).toEqual({ retry: true, delayMs: 500 });
    expect(nextRetryDecision(1)).toEqual({ retry: true, delayMs: 1000 });
    expect(nextRetryDecision(2)).toEqual({ retry: false, delayMs: 0 });
  });
  it("classifies 429 + 5xx as in-call retryable, 4xx as permanent", () => {
    expect(classifyRetryableStatus(429)?.reason).toBe("rate_limited");
    expect(classifyRetryableStatus(503)?.reason).toBe("upstream_5xx");
    expect(classifyRetryableStatus(400)).toBeNull();
    expect(classifyRetryableStatus(200)).toBeNull();
  });
});

// ── client/unbound.ts — the Phase-1 deny-stub ────────────────────────────────────────────────────────

describe("createUnboundDoseSpotClient (Phase-1 deny-stub, D11)", () => {
  it("rejects every method with a retryable:false DegradedError", async () => {
    const c = createUnboundDoseSpotClient();
    await expect(c.transmitNewRx("o", {} as never, "k")).rejects.toMatchObject({
      integration: "dosespot",
      operation: "transmitNewRx",
      retryable: false,
    });
    await expect(c.upsertPatient("o", {} as never, "k")).rejects.toBeInstanceOf(DegradedError);
    await expect(c.revokePrescriber("o", "x")).rejects.toBeInstanceOf(DegradedError);
  });
});

// ── webhook/verify.ts — §7.4 D7 ───────────────────────────────────────────────────────────────────────

describe("webhook security envelope (§7.4 D7)", () => {
  const secret = "tenant-webhook-secret";
  const body = JSON.stringify({
    organization_id: "org-1",
    dosespot_event_id: "evt-7",
    type: "ScriptStatusUpdate",
  });
  const nowMs = Date.parse("2026-06-22T12:00:00.000Z");
  const sign = (b: string, s: string): string =>
    createHmac("sha256", s).update(b, "utf8").digest("hex");

  it("accepts a well-formed, in-window, correctly-signed request and returns the body digest", () => {
    const result = verifyWebhookEnvelope({
      rawBody: body,
      signatureHeader: sign(body, secret),
      timestampHeader: String(nowMs),
      webhookSecret: secret,
      nowMs,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bodyDigest).toBe(webhookBodyDigest(body));
  });

  it("rejects a bad signature with INVALID_SIGNATURE", () => {
    const result = verifyWebhookEnvelope({
      rawBody: body,
      signatureHeader: sign(body, "wrong-secret"),
      timestampHeader: String(nowMs),
      webhookSecret: secret,
      nowMs,
    });
    expect(result).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const result = verifyWebhookEnvelope({
      rawBody: `${body} `, // one byte appended after signing
      signatureHeader: sign(body, secret),
      timestampHeader: String(nowMs),
      webhookSecret: secret,
      nowMs,
    });
    expect(result).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
  });

  it("rejects a replay outside the 5-minute window with STALE_REQUEST", () => {
    const stale = String(nowMs - 6 * 60 * 1000);
    const result = verifyWebhookEnvelope({
      rawBody: body,
      signatureHeader: sign(body, secret),
      timestampHeader: stale,
      webhookSecret: secret,
      nowMs,
    });
    expect(result).toEqual({ ok: false, reason: "STALE_REQUEST" });
  });

  it("rejects a missing/non-numeric timestamp with MALFORMED_TIMESTAMP", () => {
    for (const ts of [undefined, "", "not-a-number"]) {
      const result = verifyWebhookEnvelope({
        rawBody: body,
        signatureHeader: sign(body, secret),
        timestampHeader: ts,
        webhookSecret: secret,
        nowMs,
      });
      expect(result).toEqual({ ok: false, reason: "MALFORMED_TIMESTAMP" });
    }
  });

  it("rejects a missing signature header", () => {
    const result = verifyWebhookEnvelope({
      rawBody: body,
      signatureHeader: undefined,
      timestampHeader: String(nowMs),
      webhookSecret: secret,
      nowMs,
    });
    expect(result).toEqual({ ok: false, reason: "INVALID_SIGNATURE" });
  });

  it("signaturesMatch is constant-time-safe and length-guarded", () => {
    const a = computeWebhookSignature(body, secret);
    expect(signaturesMatch(a, a)).toBe(true);
    expect(signaturesMatch(a, a.slice(0, -2))).toBe(false);
    expect(signaturesMatch(a, "")).toBe(false);
  });

  it("dedup key is (organization_id, dosespot_event_id)", () => {
    expect(webhookDedupKey("evt-7", "org-1")).toBe("org-1:evt-7");
  });
});

// ── transmission/ — D8 idempotency + planners ────────────────────────────────────────────────────────

describe("D8 NewRx idempotency key", () => {
  it("rxBusinessKey is deterministic and folds cosmetic sig differences", () => {
    const a = computeRxBusinessKey({
      rxnormRxcui: "1191",
      strength: "81 mg",
      sigFreeText: "Take 1 tab PO QD.",
    });
    const b = computeRxBusinessKey({
      rxnormRxcui: "1191",
      strength: "81 mg",
      sigFreeText: "take  1 tab po qd",
    });
    expect(a).toBe(b);
  });

  it("different route/frequency produces a different key", () => {
    const a = computeRxBusinessKey({
      rxnormRxcui: "1191",
      strength: "81 mg",
      sigFreeText: "1 tab PO QD",
    });
    const b = computeRxBusinessKey({
      rxnormRxcui: "1191",
      strength: "81 mg",
      sigFreeText: "1 tab PO BID",
    });
    expect(a).not.toBe(b);
  });

  it("canonicalizeSig lowercases, collapses whitespace, trims trailing punctuation", () => {
    expect(canonicalizeSig("  Take   1 Tab  PO  QD. ")).toBe("take 1 tab po qd");
  });

  it("idempotencyKey binds prescriber + patient + rxBusinessKey (double-sign self-dedups)", () => {
    const rxKey = computeRxBusinessKey({
      rxnormRxcui: "1191",
      strength: "81 mg",
      sigFreeText: "1 tab PO QD",
    });
    const k1 = computeNewRxIdempotencyKey({
      prescriberMembershipId: "pm-1",
      patientId: "p-1",
      rxBusinessKey: rxKey,
    });
    const k2 = computeNewRxIdempotencyKey({
      prescriberMembershipId: "pm-1",
      patientId: "p-1",
      rxBusinessKey: rxKey,
    });
    expect(k1).toBe(k2);
    // A different patient → distinct key (no cross-patient dedup).
    const k3 = computeNewRxIdempotencyKey({
      prescriberMembershipId: "pm-1",
      patientId: "p-2",
      rxBusinessKey: rxKey,
    });
    expect(k1).not.toBe(k3);
  });

  it("correction-of-record (changed sig) produces a distinct idempotency key", () => {
    const orig = computeRxBusinessKey({
      rxnormRxcui: "1191",
      strength: "81 mg",
      sigFreeText: "1 tab PO QD",
    });
    const corrected = computeRxBusinessKey({
      rxnormRxcui: "1191",
      strength: "162 mg",
      sigFreeText: "1 tab PO QD",
    });
    const ka = computeNewRxIdempotencyKey({
      prescriberMembershipId: "pm-1",
      patientId: "p-1",
      rxBusinessKey: orig,
    });
    const kb = computeNewRxIdempotencyKey({
      prescriberMembershipId: "pm-1",
      patientId: "p-1",
      rxBusinessKey: corrected,
    });
    expect(ka).not.toBe(kb);
  });
});

describe("medication_order_transmission planners (§4.10 / §5.1)", () => {
  it("enqueue moves to queued_for_transmission with the D8 key", () => {
    const plan = planTransmissionEnqueue({
      medicationOrderId: "mo-1",
      idempotencyKey: "idem-1",
      rxBusinessKey: "rx-1",
      correlationId: "corr-1",
    });
    expect(plan.status).toBe("queued_for_transmission");
    expect(plan.sendState).toBe("queued");
    expect(plan.event).toBe("m12.medication_order.queued_for_transmission");
    expect(plan.insert).toMatchObject({
      medicationOrderId: "mo-1",
      idempotencyKey: "idem-1",
      retryCount: 0,
    });
  });

  it("success stamps the prescription id and moves to transmitted", () => {
    const plan = planTransmissionSuccess({
      dosespotPrescriptionId: "ds-rx-9",
      dosespotResponseDigest: "digest",
      nowInstant: "2026-06-22T12:00:00.000Z",
    });
    expect(plan.status).toBe("transmitted");
    expect(plan.sendState).toBe("transmitted");
    expect(plan.event).toBe("m12.medication_order.transmitted");
    expect(plan.transmissionUpdate.dosespotPrescriptionId).toBe("ds-rx-9");
  });

  it("failure re-queues while budget remains, then flips to transmission_failed + M36 alert at the cap", () => {
    const early = planTransmissionFailure({
      medicationOrderId: "mo-1",
      currentRetryCount: 0,
      lastErrorClass: "5xx_503",
      nowInstant: "2026-06-22T12:00:00.000Z",
    });
    expect(early.exhausted).toBe(false);
    if (!early.exhausted) expect(early.requeue).toBe(true);

    const terminal = planTransmissionFailure({
      medicationOrderId: "mo-1",
      currentRetryCount: RX_TRANSMISSION_MAX_RETRIES - 1,
      lastErrorClass: "5xx_503",
      nowInstant: "2026-06-22T12:00:00.000Z",
    });
    expect(terminal.exhausted).toBe(true);
    if (terminal.exhausted) {
      expect(terminal.status).toBe("transmission_failed");
      expect(terminal.sendState).toBe("failed");
      expect(terminal.event).toBe("m12.medication_order.transmission_failed");
      expect(terminal.alert).toMatchObject({
        eventType: "medication_order.transmission_failed",
        orderId: "mo-1",
        retryCount: RX_TRANSMISSION_MAX_RETRIES,
        severity: "high",
      });
    }
  });
});

// ── patient-sync/ — §2.6 D4 ───────────────────────────────────────────────────────────────────────────

describe("patient-sync planner (§2.6 D4)", () => {
  const snapshot: PatientSyncSnapshot = {
    patientId: "p-1",
    firstName: "Ada",
    lastName: "Lovelace",
    dateOfBirth: "1815-12-10",
    gender: "female",
    addressLine1: "1 Analytical Way",
    city: "London",
    state: "CA",
    postalCode: "90210",
    active: true,
    updatedAt: "2026-06-22T12:00:00.000Z",
  };

  it("idempotency key coalesces same-state re-syncs", () => {
    expect(patientSyncIdempotencyKey("p-1", "2026-06-22T12:00:00.000Z")).toBe(
      "patient:p-1:2026-06-22T12:00:00.000Z",
    );
  });

  it("builds the upsert payload keyed on wardenxPatientId and drops absent optionals", () => {
    const payload = buildPatientUpsertPayload(snapshot);
    expect(payload.wardenxPatientId).toBe("p-1");
    expect(payload.address.line1).toBe("1 Analytical Way");
    expect("line2" in payload.address).toBe(false);
    expect("phone" in payload).toBe(false);
  });

  it("planPatientSync emits the synced event", () => {
    const plan = planPatientSync(snapshot);
    expect(plan.event).toBe("m12.dosespot_patient_synced");
    expect(plan.idempotencyKey).toBe("patient:p-1:2026-06-22T12:00:00.000Z");
  });

  it("failure re-queues then escalates to M36 at the retry cap", () => {
    const early = planPatientSyncFailure({ patientId: "p-1", currentRetryCount: 0 });
    expect(early.escalate).toBe(false);

    const terminal = planPatientSyncFailure({
      patientId: "p-1",
      currentRetryCount: PATIENT_SYNC_MAX_RETRIES - 1,
    });
    expect(terminal.escalate).toBe(true);
    if (terminal.escalate) {
      expect(terminal.event).toBe("m12.dosespot_patient_sync_failed");
      expect(terminal.alert).toMatchObject({
        eventType: "patient_sync.failed",
        patientId: "p-1",
        retryCount: PATIENT_SYNC_MAX_RETRIES,
        severity: "warn",
      });
    }
  });
});
