// @chartwarden/x12-837-client — the durable record of what we sent a clearinghouse (ADR-0053 D4).
//
// Vendors expire idempotency keys (Stedi: 24 h) and share one platform credential across every tenant, so the
// guarantee "the same key + identical submission replays; anything else conflicts; tenants never collide" is kept by
// OUR record, not the vendor's. This is a port: the package ships an in-memory implementation for tests, and the
// backend supplies a durable, tenant-scoped one (M23, `clearinghouse_submission_attempt`).
//
// A submission is RESERVED before it is sent and COMPLETED once the vendor has taken it, so two concurrent
// submissions cannot both reach the vendor. A reservation the sender never completed (a crash mid-send) is not lost
// work: the transport re-sends under the same wire idempotency key, which the vendor replays inside its window.
import type { ClearinghouseContext, SubmissionKind } from "./types";

export type AttemptUsage = ClearinghouseContext["usage"];

/**
 * Another tenant (or this one, under another key) holds the control number in this usage mode. The sender is the
 * platform's, so the vendor dedupes on (sender, control number) across every tenant.
 */
export class PlatformControlNumberTaken extends Error {
  constructor() {
    super("the control number is already in use on this platform");
    this.name = "PlatformControlNumberTaken";
  }
}

export type AttemptStatus = "reserved" | "sent" | "released" | "voided";

export interface SubmissionAttempt {
  readonly organizationId: string;
  readonly providerEntityId: string;
  /** `scopeKey(ctx)`: (organizationId, providerEntityId, usage). */
  readonly scope: string;
  /** The vendor mode; control numbers are unique per mode across the whole platform. */
  readonly usage: AttemptUsage;
  readonly idempotencyKey: string;
  readonly controlNumber: string;
  readonly kind: SubmissionKind;
  /** `identityOf(submission)`: binds kind, control number, adjustment and payload. */
  readonly identity: string;
  readonly status: AttemptStatus;
  /** Null until the vendor has taken the submission. */
  readonly clearinghouseSubmissionId: string | null;
  /** When the submission was FIRST reserved (ISO-8601); never changes. The vendor's key window runs from here. */
  readonly firstReservedAt: string;
  /** When the current reservation was made or last retaken or backdated (ISO-8601). The in-flight window runs from here. */
  readonly reservedAt: string;
  readonly receivedAt: string | null;
}

export type AttemptResolution =
  | {
      readonly kind: "sent";
      readonly clearinghouseSubmissionId: string;
      readonly receivedAt: string;
    }
  | { readonly kind: "voided" };

/**
 * Conditions a settlement must still satisfy AT the write, so a sender that retook the row after the operator read it
 * cannot be overridden: the first reservation is older than `firstReservedBefore` and the current one older than
 * `reservedBefore` (ISO-8601).
 */
export interface SettleGuard {
  readonly firstReservedBefore: string;
  readonly reservedBefore: string;
}

export interface ReserveResult {
  /** The row written by this call, or the earlier live row (reserved or sent) that holds the key or number. */
  readonly attempt: SubmissionAttempt;
  /** True only when this call wrote the reservation. */
  readonly reserved: boolean;
}

/** What one submission's interchange was first rendered with: its ISA13 (9 digits) and the render clock. */
export interface InterchangeMemo {
  readonly number: string;
  readonly renderedAt: Date;
}

export interface SubmissionAttemptStore {
  /**
   * Atomic insert-if-absent of a `reserved` row on (scope, idempotencyKey) AND (scope, controlNumber), among live
   * (not released) rows. When either is taken it returns that row, preferring the key match. It never overwrites.
   * Throws `PlatformControlNumberTaken` when the control number is live under another tenant in the same usage mode.
   */
  reserve(attempt: SubmissionAttempt): Promise<ReserveResult>;
  /** The live (reserved or sent) attempt for a key, or null. Tenant-scoped. */
  find(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
  ): Promise<SubmissionAttempt | null>;
  /**
   * The next platform-wide control number for a usage mode: 9 digits (ISA13), increasing, never reused. Callers build
   * the interchange with it. Rejects when the 9-digit space is exhausted rather than wrapping.
   */
  allocateControlNumber(usage: AttemptUsage): Promise<string>;
  /**
   * The interchange control number (ISA13) for one submission: 9 digits, platform-unique like
   * {@link allocateControlNumber}, and REMEMBERED under (tenant, scope, idempotency key). A job redelivered after the
   * vendor took the file (before its own transaction committed) renders the identical ISA13. The interchange date and
   * time (ISA09/ISA10, GS04/GS05, BHT04/BHT05) are remembered too (`renderedAt`, the clock of the first allocation), so a
   * redelivery renders a byte-identical interchange and a raw-X12 vendor sees the same payload hash. The memo is durable
   * and independent of the caller's transaction. A new submission (a new control number, so a new key) gets a new number.
   */
  allocateInterchangeNumber(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    usage: AttemptUsage,
  ): Promise<InterchangeMemo>;
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
  /**
   * An operator's decision on a reservation the transport can no longer settle itself (it is past the vendor's key
   * window, so a re-send could file twice): `sent` records the vendor id the operator found; `voided` records that
   * the operator confirmed it was never filed — the control number is freed but the KEY stays burned, since the vendor
   * can no longer replay it and a re-send under it would file a duplicate. Acts only on a still-reserved row; null when there is none. `actorUserId` is recorded in the
   * audit trail.
   */
  resolve(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    outcome: AttemptResolution,
    actorUserId: string,
    guard: SettleGuard,
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
  private readonly counters: Record<AttemptUsage, number> = { test: 0, production: 0 };
  private readonly interchangeNumbers = new Map<string, { number: string; usage: AttemptUsage; renderedAt: Date }>();

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

  find(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
  ): Promise<SubmissionAttempt | null> {
    return Promise.resolve(this.rows[this.indexOf(organizationId, scope, idempotencyKey)] ?? null);
  }

  private nextNumber(usage: AttemptUsage): string {
    if (this.counters[usage] >= 999_999_999) throw new Error("control numbers exhausted");
    this.counters[usage] += 1;
    return String(this.counters[usage]).padStart(9, "0");
  }

  allocateControlNumber(usage: AttemptUsage): Promise<string> {
    try {
      return Promise.resolve(this.nextNumber(usage));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  allocateInterchangeNumber(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    usage: AttemptUsage,
  ): Promise<InterchangeMemo> {
    const memo = JSON.stringify([organizationId, scope, idempotencyKey]);
    try {
      const prior = this.interchangeNumbers.get(memo);
      if (prior && prior.usage !== usage) {
        throw new Error("clearinghouse interchange number was allocated under a different usage");
      }
      const known = prior ?? { number: this.nextNumber(usage), usage, renderedAt: new Date() };
      this.interchangeNumbers.set(memo, known);
      return Promise.resolve({ number: known.number, renderedAt: known.renderedAt });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  reserve(attempt: SubmissionAttempt): Promise<ReserveResult> {
    const live = this.live(attempt.organizationId, attempt.scope);
    const byKey = live.find((r) => r.idempotencyKey === attempt.idempotencyKey);
    if (byKey) return Promise.resolve({ attempt: byKey, reserved: false });
    const foreign = this.rows.some(
      (r) =>
        r.status !== "released" &&
        r.status !== "voided" &&
        r.usage === attempt.usage &&
        r.controlNumber === attempt.controlNumber &&
        (r.organizationId !== attempt.organizationId || r.scope !== attempt.scope),
    );
    if (foreign) return Promise.reject(new PlatformControlNumberTaken());
    const held = live.find(
      (r) => r.controlNumber === attempt.controlNumber && r.status !== "voided",
    );
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

  resolve(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    outcome: AttemptResolution,
    _actorUserId: string,
    guard: SettleGuard,
  ): Promise<SubmissionAttempt | null> {
    const i = this.indexOf(organizationId, scope, idempotencyKey);
    const row = this.rows[i];
    if (!row || row.status !== "reserved") return Promise.resolve(null);
    if (row.firstReservedAt > guard.firstReservedBefore || row.reservedAt > guard.reservedBefore) {
      return Promise.resolve(null);
    }
    const next: SubmissionAttempt =
      outcome.kind === "sent"
        ? {
            ...row,
            status: "sent",
            clearinghouseSubmissionId: outcome.clearinghouseSubmissionId,
            receivedAt: outcome.receivedAt,
          }
        : { ...row, status: "voided" };
    this.rows[i] = next;
    return Promise.resolve(next);
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
