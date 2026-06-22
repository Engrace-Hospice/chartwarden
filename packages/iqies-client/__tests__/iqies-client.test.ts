// packages/iqies-client/__tests__/iqies-client.test.ts — M10-T07 (spec §4.10 / §4.10.1 / D6). The
// adapter package's pure surface: the five-field DegradedError, the per-PE circuit breaker transitions,
// the deterministic envelope canonicalisation + SHA-256, the MinIO storage-key builder, and the Phase-1
// deny-stub. No live infra — the transport is deferred; this proves the contract M10's workers depend on.
import { describe, expect, it } from "vitest";
import {
  DegradedError,
  IQIES_CIRCUIT_BREAKER_CONFIG,
  IQIES_ENVELOPE_OBJECT_LOCK,
  INITIAL_BREAKER_SNAPSHOT,
  applyOutcome,
  assembleEnvelopeCanonical,
  buildEnvelopeStorageUri,
  createUnboundIqiesAdapter,
  envelopeSha256,
  evaluateBreaker,
  isDegradedError,
  openCircuitError,
  type HopeSubmissionEnvelope,
} from "../src/index";

describe("DegradedError (INT-009 five-field shape)", () => {
  it("carries integration / operation / retryable / customerMessage / correlationId", () => {
    const e = new DegradedError("iqies", "submitBatch", true, "transient 503", "corr-1");
    expect(e.integration).toBe("iqies");
    expect(e.operation).toBe("submitBatch");
    expect(e.retryable).toBe(true);
    expect(e.customerMessage).toBe("transient 503");
    expect(e.correlationId).toBe("corr-1");
    expect(e.message).toContain("[iqies/submitBatch]");
    expect(e.message).toContain("corr-1");
    expect(isDegradedError(e)).toBe(true);
    expect(isDegradedError(new Error("x"))).toBe(false);
  });

  it("openCircuitError is retryable (BullMQ re-queues) and PHI-free", () => {
    const e = openCircuitError("submitBatch", "corr-2");
    expect(e.retryable).toBe(true);
    expect(e.operation).toBe("submitBatch");
    expect(e.customerMessage).not.toMatch(/patient|mbi|ssn/i);
  });
});

describe("circuit breaker (SD-075 defaults, per-PE)", () => {
  const cfg = IQIES_CIRCUIT_BREAKER_CONFIG;

  it("stays closed and permits attempts below the failure threshold", () => {
    let snap = INITIAL_BREAKER_SNAPSHOT;
    for (let i = 0; i < cfg.failureThreshold - 1; i++) {
      snap = applyOutcome(snap, "failure", `2026-06-22T00:00:0${i}.000Z`, cfg);
    }
    expect(snap.state).toBe("closed");
    expect(evaluateBreaker(snap, "2026-06-22T00:00:10.000Z", cfg).allowed).toBe(true);
  });

  it("opens at the threshold within the window and fails fast", () => {
    let snap = INITIAL_BREAKER_SNAPSHOT;
    for (let i = 0; i < cfg.failureThreshold; i++) {
      snap = applyOutcome(snap, "failure", `2026-06-22T00:00:0${i}.000Z`, cfg);
    }
    expect(snap.state).toBe("open");
    // Immediately after opening, attempts are denied.
    expect(evaluateBreaker(snap, "2026-06-22T00:00:05.000Z", cfg).allowed).toBe(false);
  });

  it("transitions open → half_open after openDurationSeconds, allowing one probe", () => {
    let snap = INITIAL_BREAKER_SNAPSHOT;
    for (let i = 0; i < cfg.failureThreshold; i++) {
      snap = applyOutcome(snap, "failure", `2026-06-22T00:00:0${i}.000Z`, cfg);
    }
    // openedAt = ...:04. After 60s the breaker cools to half_open.
    const later = "2026-06-22T00:01:05.000Z";
    const ev = evaluateBreaker(snap, later, cfg);
    expect(ev.effectiveState).toBe("half_open");
    expect(ev.allowed).toBe(true);
  });

  it("a successful probe closes the breaker and clears the window", () => {
    let snap = INITIAL_BREAKER_SNAPSHOT;
    for (let i = 0; i < cfg.failureThreshold; i++) {
      snap = applyOutcome(snap, "failure", `2026-06-22T00:00:0${i}.000Z`, cfg);
    }
    const closed = applyOutcome(snap, "success", "2026-06-22T00:01:06.000Z", cfg);
    expect(closed.state).toBe("closed");
    expect(closed.recentFailureInstants).toHaveLength(0);
    expect(closed.openedAt).toBeNull();
  });

  it("a failed probe re-opens immediately (half_open is unforgiving)", () => {
    const halfOpen = { state: "half_open" as const, recentFailureInstants: [], openedAt: null };
    const reopened = applyOutcome(halfOpen, "failure", "2026-06-22T00:02:00.000Z", cfg);
    expect(reopened.state).toBe("open");
  });

  it("prunes failures that fall outside the rolling window", () => {
    let snap = INITIAL_BREAKER_SNAPSHOT;
    // Four failures across 5 minutes — all stale relative to a fresh failure 5 min later.
    snap = applyOutcome(snap, "failure", "2026-06-22T00:00:00.000Z", cfg);
    snap = applyOutcome(snap, "failure", "2026-06-22T00:05:00.000Z", cfg);
    // Only the second (within 30s of itself) plus the new one survive — still under threshold → closed.
    expect(snap.state).toBe("closed");
    expect(snap.recentFailureInstants).toEqual(["2026-06-22T00:05:00.000Z"]);
  });
});

describe("envelope canonicalisation + SHA-256", () => {
  const envelope: HopeSubmissionEnvelope = {
    providerEntityCcn: "123456",
    submissionPeriod: "2026-Q2",
    items: [
      { hopeAssessmentId: "b", rfaKind: "02_huv1", correctsIqiesRecordId: null },
      { hopeAssessmentId: "a", rfaKind: "01_admission", correctsIqiesRecordId: null },
    ],
  };

  it("is deterministic and order-independent (the batch is a set)", () => {
    const reordered: HopeSubmissionEnvelope = { ...envelope, items: [...envelope.items].reverse() };
    expect(assembleEnvelopeCanonical(envelope)).toBe(assembleEnvelopeCanonical(reordered));
  });

  it("sorts items by assessment id in the canonical form", () => {
    const canonical = assembleEnvelopeCanonical(envelope);
    expect(canonical.indexOf('"a"')).toBeLessThan(canonical.indexOf('"b"'));
  });

  it("produces a stable hex SHA-256 over the canonical pre-image", () => {
    const h = envelopeSha256(assembleEnvelopeCanonical(envelope));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(envelopeSha256(assembleEnvelopeCanonical(envelope)));
  });
});

describe("MinIO envelope storage", () => {
  it("builds the per-tenant / per-PE / per-period object key", () => {
    expect(
      buildEnvelopeStorageUri({
        organizationId: "org_a",
        providerEntityId: "pe_1",
        submissionPeriod: "2026-Q2",
        submissionId: "sub_9",
      }),
    ).toBe("tenants/org_a/iqies-envelopes/pe_1/2026-Q2/sub_9.xml.enc");
  });

  it("declares COMPLIANCE object-lock with the CMS 10-year retention", () => {
    expect(IQIES_ENVELOPE_OBJECT_LOCK.mode).toBe("COMPLIANCE");
    expect(IQIES_ENVELOPE_OBJECT_LOCK.retentionDays).toBe(3650);
    expect(IQIES_ENVELOPE_OBJECT_LOCK.lifecycleExpirationDays).toBe(4380);
  });
});

describe("unbound deny-stub adapter (Phase 1)", () => {
  it("rejects every operation with a non-retryable DegradedError (immediate DLQ)", async () => {
    const adapter = createUnboundIqiesAdapter();
    for (const call of [
      () => adapter.submitBatch({} as never),
      () => adapter.fetchAcceptanceReport("batch"),
      () => adapter.submitCorrection({} as never),
    ]) {
      try {
        await call();
        throw new Error("expected DegradedError");
      } catch (e) {
        expect(isDegradedError(e)).toBe(true);
        expect((e as DegradedError).retryable).toBe(false);
      }
    }
  });
});
