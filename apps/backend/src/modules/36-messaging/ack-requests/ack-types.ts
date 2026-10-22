// apps/backend/src/modules/36-messaging/ack-requests/ack-types.ts - WP 4.2 (ADR-0069): the row shapes and the storage port of the
// acknowledgment-request aggregate. The service owns the rules; a store only reads and writes rows inside one transaction
// (the DB trigger is the backstop for the state machine). Ids, enums and instants only.
import type { AckClass, AckEventType, AckReasonCode, AckStatus } from "@chartwarden/types";

export interface AckRow {
  readonly id: string;
  readonly organizationId: string;
  readonly messageId: string;
  readonly channelId: string;
  readonly patientId: string;
  readonly ackClass: AckClass;
  readonly status: AckStatus;
  readonly requesterUserId: string;
  readonly assignedUserId: string;
  readonly requestedAt: Date;
  readonly windowStartedAt: Date;
  readonly deadlineAt: Date;
  readonly currentTier: number;
  readonly acknowledgedAt: Date | null;
  readonly acknowledgedByUserId: string | null;
  readonly resolvedAt: Date | null;
  readonly resolvedByUserId: string | null;
  readonly cancelledAt: Date | null;
  readonly version: number;
  /** ADR-0081: the role the sender addressed, null when a person was named. Fixed once set. */
  readonly addressedRole?: string | null;
  /** Last write (the instant a `failed_unreachable` request became so, while it stays so). Optional: older fixtures omit it. */
  readonly updatedAt?: Date;
}

export interface NewAckRequest {
  readonly organizationId: string;
  readonly messageId: string;
  readonly channelId: string;
  readonly patientId: string;
  readonly ackClass: AckClass;
  readonly requesterUserId: string;
  readonly assignedUserId: string;
  readonly requestedAt: Date;
  readonly deadlineAt: Date;
  /** ADR-0081: set only by a role-based send. */
  readonly addressedRole?: string | undefined;
}

/** The columns a transition may change (everything else is immutable; the DB trigger refuses the rest). */
export interface AckPatch {
  readonly status: AckStatus;
  readonly assignedUserId?: string;
  readonly windowStartedAt?: Date;
  readonly deadlineAt?: Date;
  readonly currentTier?: number;
  readonly acknowledgedAt?: Date | null;
  readonly acknowledgedByUserId?: string | null;
  readonly resolvedAt?: Date | null;
  readonly resolvedByUserId?: string | null;
  readonly cancelledAt?: Date | null;
  readonly updatedAt: Date;
}

export interface NewAckEvent {
  readonly organizationId: string;
  readonly requestId: string;
  readonly eventType: AckEventType;
  readonly actorUserId: string | null;
  readonly fromStatus: AckStatus | null;
  readonly toStatus: AckStatus | null;
  readonly assignedUserId: string | null;
  readonly previousAssignedUserId: string | null;
  readonly tier: number;
  readonly at: Date;
  /** ADR-0078: set only on a SUPERVISOR's `reassigned` event (a fixed non-clinical code). */
  readonly reasonCode?: AckReasonCode | null;
}

export interface AckEventRow {
  readonly id: string;
  readonly eventType: AckEventType;
  readonly actorUserId: string | null;
  readonly actorKind: "user" | "system";
  readonly fromStatus: AckStatus | null;
  readonly toStatus: AckStatus | null;
  readonly assignedUserId: string | null;
  readonly previousAssignedUserId: string | null;
  readonly tier: number;
  readonly createdAt: Date;
  readonly reasonCode?: string | null;
}

/** The WP 4.4 timer's one status write: hand an unacknowledged request to the next tier's user and start that tier's window. */
export interface AckEscalation {
  readonly assignedUserId: string;
  readonly tier: number;
  /** The new window's length; the DATABASE starts it at its own now() (the update guard demands a window that starts now). */
  readonly windowMinutes: number;
  readonly updatedAt: Date;
}

export interface UnroutedSummary {
  readonly count: number;
  /** How many of `count` are `ladder_exhausted` (the rest are `route_unavailable`): the per-type occurrence is derived from it. */
  readonly ladderCount: number;
  readonly lastAt: Date;
  readonly lastType: "route_unavailable" | "ladder_exhausted";
}

/** What the service needs to know about the message a request is about. */
export interface AckMessageFacts {
  readonly channelId: string;
  readonly authorUserId: string | null;
  readonly status: string;
  readonly urgency: string;
  readonly urgentRecipientUserId: string | null;
}

/** Another writer got there first (the optimistic version no longer matches). The service answers 409. */
export class AckStaleError extends Error {
  constructor() {
    super("ack request changed concurrently");
    this.name = "AckStaleError";
  }
}

/** One transaction's view of the aggregate. Every call is scoped to the organization the transaction was opened for. */
export interface AckTx {
  findById(id: string, lock: boolean): Promise<AckRow | null>;
  findByMessage(messageId: string, lock: boolean): Promise<AckRow | null>;
  /** Insert, or return the existing row for the message (`inserted: false`) - the unique index is the replay arbiter. */
  insert(row: NewAckRequest): Promise<{ readonly row: AckRow; readonly inserted: boolean }>;
  /** Applies the patch only if the stored version is `expectedVersion` (then bumps it); else throws AckStaleError. */
  update(id: string, expectedVersion: number, patch: AckPatch): Promise<AckRow>;
  insertEvent(event: NewAckEvent): Promise<void>;
  /**
   * ADR-0078: marks THIS transaction as a supervisor reassign (a transaction-local setting the update guard of migration 1126 reads).
   * Call it immediately before the reassign `update`; it grants nothing the guard's other rules do not also allow.
   */
  allowSupervisorReassign(): Promise<void>;
  /** WP 4.4: applies an escalation only if the stored version is `expectedVersion`; else throws AckStaleError. */
  escalate(id: string, expectedVersion: number, escalation: AckEscalation): Promise<AckRow>;
  /**
   * WP 4.4: ONE batched read of the unroutable history (`route_unavailable` / `ladder_exhausted` rows written inside each request's
   * CURRENT window): how many, when the newest was written and which type it was. Requests with none are absent from the map.
   */
  unroutedSummary(
    requests: readonly { readonly id: string; readonly windowStartedAt: Date }[],
  ): Promise<ReadonlyMap<string, UnroutedSummary>>;
  /**
   * WP 4.4: open waiting requests (pending or escalated) whose deadline is at or before `asOf`, oldest deadline first, EXCLUDING the
   * ones whose unroutable backoff has not elapsed (decided in the query, so backed-off rows never consume the batch).
   */
  listDue(asOf: Date, limit: number): Promise<readonly AckRow[]>;
  /**
   * ADR-0079 (G-5): `failed_unreachable` requests whose deadline is at or before `asOf`, oldest deadline first. The deadline timer does
   * not watch these (nothing can escalate them), so the unreachable watch reads them to keep them in front of supervisors. Bounded in
   * SQL to rows whose anchor, `greatest(deadline_at, updated_at)`, is after `since`, so rows past the end of their schedule never take a batch slot.
   */
  listUnreachableOverdue(asOf: Date, limit: number, since: Date): Promise<readonly AckRow[]>;
  listEvents(requestId: string): Promise<readonly AckEventRow[]>;
  /** Every open request, then the newest closed ones up to `limit` in all; newest first within each group. */
  listForChannel(channelId: string, limit: number): Promise<readonly AckRow[]>;
  messageFacts(messageId: string): Promise<AckMessageFacts | null>;
}

export interface AckStore {
  /** Runs `fn` in one transaction as `actor` (the audit trigger attributes the writes to `actor.userId`). */
  run<T>(
    actor: { readonly orgId: string; readonly userId: string },
    fn: (tx: AckTx, rawTx: unknown) => Promise<T>,
  ): Promise<T>;
  /** WP 4.4: a tenant-scoped transaction with NO acting user (the timer's own writes: an empty app.user_id is a system write). */
  runAsSystem<T>(orgId: string, fn: (tx: AckTx, rawTx: unknown) => Promise<T>): Promise<T>;
  /** A tenant-scoped read with no acting user (outbox consumers are not requests). Never writes. */
  readAsSystem<T>(orgId: string, fn: (tx: AckTx) => Promise<T>): Promise<T>;
  /** A view over a transaction somebody else owns (the send core's hook, the delete path). */
  bind(rawTx: unknown, orgId: string): AckTx;
}
