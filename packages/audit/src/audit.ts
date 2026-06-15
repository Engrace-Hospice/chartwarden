// @wardenx/audit — the single audit() / auditRead() helper every module calls (M1 spec §8.2).
//
// audit_event is HELPER-ONLY (manifest HELPER_ONLY_TABLES): this package is its only
// sanctioned writer — feature modules never insert into it directly. The helper does three
// jobs the spec demands and a raw insert would skip:
//   1. ATOMICITY — it writes through the SAME Drizzle tx the business change uses, so the
//      audit row commits or rolls back together with the action it records (spec §7.3).
//   2. REDACTION — before/after/context snapshots are run through the field denylist FIRST,
//      so the trail proves what changed without copying the PHI (HIPAA §164.312(b)).
//   3. RETENTION — the event's retention class is resolved (operational/compliance/
//      legal_hold) so its partition ages out on the right schedule (ADR-0004).
//
// packages/audit is a FOUNDATION_HELPER_PACKAGE and may import the @wardenx/db schema TYPES
// (ADR-0005 D4); table ownership for audit_event is satisfied by the helper-package rule.
import { schema } from "@wardenx/db";
import { redactSnapshot } from "./denylist";
import { type RetentionClass, resolveRetention } from "./retention";

/** A row ready for insert into `audit_event` (derived from the M1-owned Drizzle schema). */
export type NewAuditEvent = typeof schema.auditEvents.$inferInsert;

export type AuditActorKind = (typeof schema.auditActorKind.enumValues)[number];
export type AuditOutcome = (typeof schema.auditOutcome.enumValues)[number];
export type AuditSeverity = (typeof schema.auditSeverity.enumValues)[number];

/**
 * Structural view of the Drizzle transaction audit() writes through — just enough of
 * `db.insert(table).values(row)` to record the event. Taking the caller's `tx` (not a
 * detached writer) is what makes the audit write atomic with the business write.
 */
export interface AuditExecutor {
  insert(table: typeof schema.auditEvents): {
    values(row: NewAuditEvent): PromiseLike<unknown>;
  };
}

/** Tenant + actor + request facts audit() needs (carried by the request context, §4.5). */
export interface AuditContext {
  /** Tenant scope. `null` only for platform/system events with no single org. */
  readonly organizationId?: string | null;
  /** Acting user; `null` for system / integration actors. */
  readonly userId?: string | null;
  readonly actorKind?: AuditActorKind;
  readonly actorRole?: string;
  /** Correlation id stitching this event to the request's other audit/outbox records. */
  readonly correlationId: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly sourceIp?: string;
  readonly userAgent?: string;
}

/** What happened — the per-event payload (spec §8.2). */
export interface AuditEventInput {
  /** Dotted event type, e.g. `org.created`, `patient.viewed`. */
  readonly eventType: string;
  /** Resource kind acted on, e.g. `organization`, `patient`. */
  readonly resourceKind: string;
  readonly resourceId?: string;
  readonly outcome: AuditOutcome;
  readonly severity?: AuditSeverity;
  /** Pre-change snapshot (redacted before write). */
  readonly before?: Record<string, unknown>;
  /** Post-change snapshot (redacted before write). */
  readonly after?: Record<string, unknown>;
  /** Extra structured context (redacted before write). */
  readonly context?: Record<string, unknown>;
  /** Override the resolved retention class for this one event. */
  readonly retentionClass?: RetentionClass;
}

/** Build the redacted, retention-classified row for one audit event. */
function buildRow(ctx: AuditContext, input: AuditEventInput): NewAuditEvent {
  return {
    organizationId: ctx.organizationId ?? null,
    actorUserId: ctx.userId ?? null,
    actorKind: ctx.actorKind ?? "user",
    actorRole: ctx.actorRole,
    eventType: input.eventType,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    correlationId: ctx.correlationId,
    requestId: ctx.requestId,
    traceId: ctx.traceId,
    sourceIp: ctx.sourceIp,
    userAgent: ctx.userAgent,
    outcome: input.outcome,
    severity: input.severity ?? "info",
    before: redactSnapshot(input.before),
    after: redactSnapshot(input.after),
    context: redactSnapshot(input.context) ?? {},
    retentionClass: resolveRetention(input.eventType, input.retentionClass),
  };
}

/**
 * Write one audit_event row atomically on `tx`. Snapshots are redacted and the retention
 * class is resolved before insert. This is the only sanctioned path to audit_event.
 */
export async function audit(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: AuditEventInput,
): Promise<void> {
  await tx.insert(schema.auditEvents).values(buildRow(ctx, input));
}

/**
 * Record a PHI READ. Viewing PHI is itself an auditable event (HIPAA §164.312(b)); this is a
 * thin wrapper over audit() with read semantics — no before/after snapshot, outcome defaults
 * to `success`.
 */
export async function auditRead(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: Omit<AuditEventInput, "before" | "after" | "outcome"> & { outcome?: AuditOutcome },
): Promise<void> {
  await audit(tx, ctx, { ...input, outcome: input.outcome ?? "success" });
}
