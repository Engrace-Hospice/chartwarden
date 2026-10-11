// @wardenx/x12-837-client — the durable record of what we sent a clearinghouse (ADR-0053 D4).
//
// Vendors expire idempotency keys (Stedi: 24 h) and share one platform credential across every tenant, so the
// guarantee "the same key + identical submission replays; anything else conflicts; tenants never collide" is kept by
// OUR record, not the vendor's. This is a port: the package ships an in-memory implementation for tests, and the
// backend supplies a durable, tenant-scoped one before any real adapter is bound.
import type { SubmissionKind } from "./types";

export interface SubmissionAttempt {
  /** `scopeKey(ctx)`: (organizationId, providerEntityId, usage). */
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly controlNumber: string;
  readonly kind: SubmissionKind;
  /** `identityOf(submission)`: binds kind, control number, adjustment and payload. */
  readonly identity: string;
  readonly clearinghouseSubmissionId: string;
  readonly receivedAt: string;
}

export interface SubmissionAttemptStore {
  findByKey(scope: string, idempotencyKey: string): Promise<SubmissionAttempt | null>;
  findByControlNumber(scope: string, controlNumber: string): Promise<SubmissionAttempt | null>;
  /**
   * Atomic insert-if-absent on (scope, idempotencyKey) AND (scope, controlNumber). Returns the stored attempt:
   * the one just written, or the earlier one that won a race. It never overwrites.
   */
  putIfAbsent(attempt: SubmissionAttempt): Promise<SubmissionAttempt>;
}

/** Process-local store. TEST SUPPORT: it does not survive a restart, so it must not back a production binding. */
export class InMemoryAttemptStore implements SubmissionAttemptStore {
  private readonly byKey = new Map<string, SubmissionAttempt>();
  private readonly byNumber = new Map<string, SubmissionAttempt>();

  findByKey(scope: string, idempotencyKey: string): Promise<SubmissionAttempt | null> {
    return Promise.resolve(this.byKey.get(JSON.stringify([scope, idempotencyKey])) ?? null);
  }

  findByControlNumber(scope: string, controlNumber: string): Promise<SubmissionAttempt | null> {
    return Promise.resolve(this.byNumber.get(JSON.stringify([scope, controlNumber])) ?? null);
  }

  putIfAbsent(attempt: SubmissionAttempt): Promise<SubmissionAttempt> {
    const keyId = JSON.stringify([attempt.scope, attempt.idempotencyKey]);
    const numberId = JSON.stringify([attempt.scope, attempt.controlNumber]);
    const existing = this.byKey.get(keyId) ?? this.byNumber.get(numberId);
    if (existing) return Promise.resolve(existing);
    this.byKey.set(keyId, attempt);
    this.byNumber.set(numberId, attempt);
    return Promise.resolve(attempt);
  }
}
