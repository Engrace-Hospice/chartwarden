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
import { randomUUID } from "node:crypto";
import { schema } from "@wardenx/db";
import { type SQL, sql } from "drizzle-orm";
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
    // The resolved class can be `compliance_42cfr_part2` (a Part 2 / SUD event, M4 §6). The
    // backing pg-enum value lands with its migration (M4-T05 / §3.7.1); the `$inferInsert` type
    // still reflects the 3-value enum, so widen at this one boundary (the value is valid the
    // moment the migration is applied; the in-memory sink stores it now).
    retentionClass: resolveRetention(
      input.eventType,
      input.retentionClass,
    ) as NewAuditEvent["retentionClass"],
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
 * Like {@link audit}, but returns the new row's id so the caller can store it as a back-reference (e.g. M23's
 * `validation_override.m4_audit_event_id`). The id is generated here and inserted explicitly; everything else, including
 * redaction and retention resolution, is exactly `audit()`.
 */
export async function auditReturningId(
  tx: AuditExecutor,
  ctx: AuditContext,
  input: AuditEventInput,
): Promise<string> {
  const id = randomUUID();
  await tx.insert(schema.auditEvents).values({ ...buildRow(ctx, input), id });
  return id;
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

/** Structural view of the tx `auditPlatformEvent` needs — just enough to run a raw SQL statement
 *  (the SECURITY DEFINER function call). Satisfied by a plain `DbClient` or any `withOrgContext`/
 *  `withPlatformContext` transaction handle. */
export interface PlatformAuditExecutor {
  execute(query: SQL): Promise<unknown>;
}

/** What happened — the per-event payload for a platform-scoped (no single org) audit row. Narrower
 *  than {@link AuditEventInput}: `before`/`after` are omitted (a platform-scoped event records a
 *  system action, not a tenant record's before/after state). */
export interface PlatformAuditEventInput {
  /** Dotted event type, e.g. `platform.bypass_invoked`. */
  readonly eventType: string;
  readonly resourceKind: string;
  readonly resourceId?: string;
  readonly outcome: AuditOutcome;
  readonly severity?: AuditSeverity;
  readonly correlationId: string;
  readonly context?: Record<string, unknown>;
  readonly retentionClass?: RetentionClass;
}

/**
 * Write one PLATFORM-SCOPED (`organization_id IS NULL`, `actor_kind = 'system'`) `audit_event` row.
 * `wardenx_app` holds no INSERT policy admitting a null-org row (ADR-0010 D2/D3 ban a second
 * RLS-policy GUC or an org-alternative disjunct on a tenant-writable policy — see migration 0186's
 * own comment for why), so a plain `tx.insert(schema.auditEvents)...` — the path `audit()` takes —
 * fails under real RLS the same way `outbox_event`'s platform-wide insert did before migration 0186.
 * This instead calls the SECURITY DEFINER `audit_writer_insert_platform_event` function (migration
 * 0187) — owned by `wardenx_audit_writer` (which already holds the unconditional `audit_writer_insert`
 * policy, migration 0013), EXECUTE granted directly to `wardenx_app`. `organization_id`/`actor_kind`
 * are hardcoded inside the function body, never caller-supplied, so there is no way to widen scope
 * through an argument — the same shape as `outbox_event`'s platform-writer functions.
 *
 * This is the ONLY sanctioned way to write a platform-scoped audit_event row — `withPlatformContext`'s
 * mandatory `platform.bypass_invoked` write (the sole caller today) uses it via
 * `m34PlatformBypassAuditor` (apps/backend/src/index.ts).
 */
export async function auditPlatformEvent(
  tx: PlatformAuditExecutor,
  input: PlatformAuditEventInput,
): Promise<void> {
  const context = redactSnapshot(input.context) ?? {};
  const retentionClass = resolveRetention(input.eventType, input.retentionClass);
  await tx.execute(sql`
    SELECT audit_writer_insert_platform_event(
      ${input.eventType},
      ${input.resourceKind},
      ${input.resourceId ?? null},
      ${input.outcome},
      ${input.severity ?? "info"},
      ${input.correlationId},
      ${JSON.stringify(context)}::jsonb,
      ${retentionClass}
    )
  `);
}
