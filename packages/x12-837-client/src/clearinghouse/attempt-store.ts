// @wardenx/x12-837-client — the durable record of what we sent a clearinghouse (ADR-0053 D4).
//
// Vendors expire idempotency keys (Stedi: 24 h) and share one platform credential across every tenant, so the
// guarantee "the same key + identical submission replays; anything else conflicts; tenants never collide" is kept by
// OUR record, not the vendor's. This is a port: the package ships an in-memory implementation for tests, and the
// backend supplies a durable, tenant-scoped one (M23, `clearinghouse_submission_attempt`).
//
// A submission is RESERVED before it is sent and COMPLETED once the vendor has taken it, so two concurrent
// submissions cannot both reach the vendor. A reservation the sender never completed (a crash mid-send) is not lost
// work: the transport re-sends under the same wire idempotency key, which the vendor replays inside its window.
import type { SubmissionKind } from "./types";

export type AttemptStatus = "reserved" | "sent" | "released";

export interface SubmissionAttempt {
  readonly organizationId: string;
  readonly providerEntityId: string;
  /** `scopeKey(ctx)`: (organizationId, providerEntityId, usage). */
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly controlNumber: string;
  readonly kind: SubmissionKind;
  /** `identityOf(submission)`: binds kind, control number, adjustment and payload. */
  readonly identity: string;
  readonly status: AttemptStatus;
  /** Null until the vendor has taken the submission. */
  readonly clearinghouseSubmissionId: string | null;
  /** When the current reservation was made or last retaken (ISO-8601). */
  readonly reservedAt: string;
  readonly receivedAt: string | null;
}

export interface ReserveResult {
  /** The row written by this call, or the earlier live row (reserved or sent) that holds the key or number. */
  readonly attempt: SubmissionAttempt;
  /** True only when this call wrote the reservation. */
  readonly reserved: boolean;
}

export interface SubmissionAttemptStore {
  /**
   * Atomic insert-if-absent of a `reserved` row on (scope, idempotencyKey) AND (scope, controlNumber), among live
   * (not released) rows. When either is taken it returns that row, preferring the key match. It never overwrites.
   */
  reserve(attempt: SubmissionAttempt): Promise<ReserveResult>;
  /**
   * reserved -> sent, recording the vendor's id. Idempotent: a row that is already sent is returned unchanged.
   * Null when no such row exists.
   */
  complete(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    clearinghouseSubmissionId: string,
    receivedAt: string,
  ): Promise<SubmissionAttempt | null>;
  /** reserved -> released: the vendor definitively did not take it, so the key and number are free again. */
  release(organizationId: string, scope: string, idempotencyKey: string): Promise<void>;
  /**
   * Compare-and-set of an abandoned reservation's time, so exactly one retry takes it over. True only when the row
   * is still reserved with `reservedAt === expectedReservedAt`.
   */
  retake(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    expectedReservedAt: string,
    newReservedAt: string,
  ): Promise<boolean>;
}

/** Process-local store. TEST SUPPORT: it does not survive a restart, so it must not back a production binding. */
export class InMemoryAttemptStore implements SubmissionAttemptStore {
  private readonly rows: SubmissionAttempt[] = [];

  private live(organizationId: string, scope: string): SubmissionAttempt[] {
    return this.rows.filter(
      (r) => r.organizationId === organizationId && r.scope === scope && r.status !== "released",
    );
  }

  private indexOf(organizationId: string, scope: string, idempotencyKey: string): number {
    return this.rows.findIndex(
      (r) =>
        r.organizationId === organizationId &&
        r.scope === scope &&
        r.idempotencyKey === idempotencyKey &&
        r.status !== "released",
    );
  }

  reserve(attempt: SubmissionAttempt): Promise<ReserveResult> {
    const live = this.live(attempt.organizationId, attempt.scope);
    const held =
      live.find((r) => r.idempotencyKey === attempt.idempotencyKey) ??
      live.find((r) => r.controlNumber === attempt.controlNumber);
    if (held) return Promise.resolve({ attempt: held, reserved: false });
    const row: SubmissionAttempt = {
      ...attempt,
      status: "reserved",
      clearinghouseSubmissionId: null,
      receivedAt: null,
    };
    this.rows.push(row);
    return Promise.resolve({ attempt: row, reserved: true });
  }

  complete(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    clearinghouseSubmissionId: string,
    receivedAt: string,
  ): Promise<SubmissionAttempt | null> {
    const i = this.indexOf(organizationId, scope, idempotencyKey);
    const row = this.rows[i];
    if (!row) return Promise.resolve(null);
    if (row.status === "sent") return Promise.resolve(row);
    const sent: SubmissionAttempt = {
      ...row,
      status: "sent",
      clearinghouseSubmissionId,
      receivedAt,
    };
    this.rows[i] = sent;
    return Promise.resolve(sent);
  }

  release(organizationId: string, scope: string, idempotencyKey: string): Promise<void> {
    const i = this.indexOf(organizationId, scope, idempotencyKey);
    const row = this.rows[i];
    if (row && row.status === "reserved") this.rows[i] = { ...row, status: "released" };
    return Promise.resolve();
  }

  retake(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    expectedReservedAt: string,
    newReservedAt: string,
  ): Promise<boolean> {
    const i = this.indexOf(organizationId, scope, idempotencyKey);
    const row = this.rows[i];
    if (!row || row.status !== "reserved" || row.reservedAt !== expectedReservedAt) {
      return Promise.resolve(false);
    }
    this.rows[i] = { ...row, reservedAt: newReservedAt };
    return Promise.resolve(true);
  }
}
