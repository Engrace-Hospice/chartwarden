// apps/backend/src/modules/04-audit/messaging-hold-workflow.ts - the transaction-scoped legal-hold seam M36 (messaging)
// calls instead of re-implementing M4's table writes (ADR-0086 (proposed), WP 5.6). Precedent: m34-destruction-workflow.ts.
//
// `applyLegalHoldInTx` / `releaseLegalHoldInTx` are the exact bodies of `POST /api/v1/legal-holds` and
// `POST /api/v1/legal-holds/:id/release` (routes/legal-holds.ts), extracted so the route and a cross-module caller write
// the SAME row, the SAME `data.legal_hold_*` audit event and the SAME `m4.legal_hold.*` outbox payload. The caller owns the
// transaction (`withOrgContext`), the permission/step-up gates and the match count.
import { type AuditContext, audit } from "@wardenx/audit";
import { type DbClient, schema } from "@wardenx/db";
import {
  MESSAGING_GOVERNANCE_HOLD_ORIGIN,
  NotFoundError,
  WardenXError,
  messagingHoldLockName,
} from "@wardenx/types";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { LegalHoldCriteria } from "./routes/audit-typebox";

const HOLD = schema.legalHolds;
const CERT = schema.destructionCertificates;

/** A transactional-outbox emission (mirrors the `WriteOutboxPort` shape every other module binds). */
export interface M4OutboxEmission {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly organizationId: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
}

/** The composition root's transactional-outbox port, pinned to callerModule `m4` (optional: unbound => no notification). */
export interface M4OutboxPort {
  publish(tx: DbClient, emission: M4OutboxEmission): Promise<void>;
}

/** True when `criteria` names at least one selector (POST body validation: 422 EMPTY_CRITERIA). */
export function hasSelector(criteria: LegalHoldCriteria): boolean {
  return (
    (criteria.patientIds?.length ?? 0) > 0 ||
    criteria.dateRange !== undefined ||
    (criteria.resourceKinds?.length ?? 0) > 0 ||
    (criteria.channelIds?.length ?? 0) > 0 ||
    (criteria.userIds?.length ?? 0) > 0
  );
}

export interface ApplyLegalHoldInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly name: string;
  readonly criteria: LegalHoldCriteria;
  readonly reason: string;
  readonly matchedRecordCount: number;
}

/** Insert the hold, audit it at `compliance` retention and notify through the outbox. Runs inside the caller's tx. */
export async function applyLegalHoldInTx(
  tx: DbClient,
  deps: { readonly outbox?: M4OutboxPort },
  auditContext: AuditContext,
  input: ApplyLegalHoldInput,
): Promise<typeof HOLD.$inferSelect> {
  // Serialise against the M36 tenant eraser (it holds this lock SHARED across its check-and-destroy transaction): a hold either
  // commits before the eraser looks, or waits until the erase has committed. Released with this transaction.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${messagingHoldLockName(input.organizationId)}, 0))`,
  );
  const [row] = await tx
    .insert(HOLD)
    .values({
      organizationId: input.organizationId,
      name: input.name,
      criteria: input.criteria,
      reason: input.reason,
      appliedBy: input.userId,
    })
    .returning();
  if (!row) throw new Error("legal_hold insert returned no row");
  await audit(tx, auditContext, {
    eventType: "data.legal_hold_applied",
    resourceKind: "legal_hold",
    resourceId: row.id,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    context: {
      name: input.name,
      matchedRecordCount: input.matchedRecordCount,
      reason: input.reason,
    },
  });
  if (deps.outbox) {
    await deps.outbox.publish(tx, {
      eventName: "m4.legal_hold.applied",
      payload: { holdId: row.id, matched: input.matchedRecordCount, reason: input.reason },
      organizationId: input.organizationId,
      aggregateKind: "legal_hold",
      aggregateId: row.id,
    });
  }
  return row;
}

export interface ReleaseLegalHoldInput {
  readonly organizationId: string;
  readonly holdId: string;
  readonly reason: string;
  /** Live count of what the hold covered, computed (inside the tx) from the hold's own criteria. */
  readonly countRestored: (criteria: LegalHoldCriteria) => Promise<number>;
}

/**
 * What M4's own release route reports as "restored". A MESSAGING-governance hold's scope is messages, not audit events, so
 * counting audit events (`auditCount`, the route's default) would report a meaningless number for it. When the composition root
 * binds M36's overlay counter (`overlayCount`; M4 may not read M36's table itself) use it for a governance-origin hold.
 * (M36's own route supplies its live count and never calls this.)
 */
export async function restoredCountForM4Route(
  tx: DbClient,
  organizationId: string,
  holdId: string,
  criteria: LegalHoldCriteria,
  auditCount: (criteria: LegalHoldCriteria) => Promise<number>,
  overlayCount?: GovernanceOverlayCounter,
): Promise<number> {
  if (!overlayCount || !isGovernanceHold(criteria)) return auditCount(criteria);
  return overlayCount(tx, organizationId, holdId);
}

/** M36's materialised-overlay counter, bound at the composition root. */
export type GovernanceOverlayCounter = (
  tx: DbClient,
  organizationId: string,
  holdId: string,
) => Promise<number>;

/** Release an ACTIVE hold: audit + outbox identical to the route. 404 unknown, 409 ALREADY_RELEASED. */
export async function releaseLegalHoldInTx(
  tx: DbClient,
  deps: { readonly outbox?: M4OutboxPort },
  auditContext: AuditContext,
  input: ReleaseLegalHoldInput,
): Promise<{ released: true; restoredRecordCount: number }> {
  const { organizationId, holdId: id, reason } = input;
  const [hold] = await tx
    .select()
    .from(HOLD)
    .where(and(eq(HOLD.organizationId, organizationId), eq(HOLD.id, id)))
    .limit(1);
  if (!hold) throw new NotFoundError("legal_hold", id);
  const alreadyReleased = () =>
    new WardenXError("ALREADY_RELEASED", `legal_hold ${id} is already released`, 409);
  if (hold.status === "released") throw alreadyReleased();
  const restoredRecordCount = await input.countRestored(hold.criteria as LegalHoldCriteria);
  // Conditional update: of two concurrent releases that both read 'active', only one matches the row once the other commits,
  // so there is one winner, one audit row and one outbox event; the loser gets the same conflict as a sequential repeat.
  const [won] = await tx
    .update(HOLD)
    .set({ status: "released", releasedAt: new Date() })
    .where(and(eq(HOLD.organizationId, organizationId), eq(HOLD.id, id), eq(HOLD.status, "active")))
    .returning({ id: HOLD.id });
  if (!won) throw alreadyReleased();
  await audit(tx, auditContext, {
    eventType: "data.legal_hold_released",
    resourceKind: "legal_hold",
    resourceId: id,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    context: { reason, restoredRecordCount },
  });
  if (deps.outbox) {
    await deps.outbox.publish(tx, {
      eventName: "m4.legal_hold.released",
      payload: { holdId: id, matched: restoredRecordCount, reason },
      organizationId,
      aggregateKind: "legal_hold",
      aggregateId: id,
    });
  }
  return { released: true as const, restoredRecordCount };
}

/** The org's ACTIVE holds (id + criteria) for a cross-module reader that resolves them itself (the messaging scan). */
export async function activeLegalHolds(
  tx: DbClient,
  organizationId: string,
): Promise<readonly { readonly id: string; readonly criteria: LegalHoldCriteria }[]> {
  const rows = await tx
    .select({ id: HOLD.id, criteria: HOLD.criteria })
    .from(HOLD)
    .where(and(eq(HOLD.organizationId, organizationId), eq(HOLD.status, "active")));
  return rows.map((r) => ({ id: r.id, criteria: r.criteria as LegalHoldCriteria }));
}

export interface OpenMessageCertificateInput {
  readonly organizationId: string;
  /** `message.<retention class>`: ids/counts only, never content. */
  readonly dataClass: string;
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
  readonly recordCount: number;
  readonly method?: string;
}

/**
 * Open a PENDING destruction certificate for a message class and month, once. Idempotent on (organization, dataClass,
 * rangeStart): a second call returns the existing certificate untouched (its count is not rewritten). The scan runs one
 * worker per org, so select-then-insert is enough; there is no unique index to lean on (this slice adds no migration).
 */
export async function openMessageCertificate(
  tx: DbClient,
  input: OpenMessageCertificateInput,
): Promise<{ readonly id: string; readonly created: boolean }> {
  const [existing] = await tx
    .select({ id: CERT.id })
    .from(CERT)
    .where(
      and(
        eq(CERT.organizationId, input.organizationId),
        eq(CERT.dataClass, input.dataClass),
        eq(CERT.dateRangeStart, input.rangeStart),
      ),
    )
    .limit(1);
  if (existing) return { id: existing.id, created: false };
  const [row] = await tx
    .insert(CERT)
    .values({
      organizationId: input.organizationId,
      dataClass: input.dataClass,
      recordCount: input.recordCount,
      dateRangeStart: input.rangeStart,
      dateRangeEnd: input.rangeEnd,
      method: input.method ?? "secure_delete",
    })
    .returning({ id: CERT.id });
  if (!row) throw new Error("destruction_certificate insert returned no row");
  return { id: row.id, created: true };
}

/** One legal hold as the messaging governance screen reads it (the free-text reason stays in the audit row). */
export interface LegalHoldSummary {
  readonly id: string;
  readonly name: string;
  readonly criteria: LegalHoldCriteria;
  readonly status: "active" | "released";
  readonly appliedBy: string | null;
  readonly appliedAt: Date;
  readonly releasedAt: Date | null;
}

const toSummary = (r: typeof HOLD.$inferSelect): LegalHoldSummary => ({
  id: r.id,
  name: r.name,
  criteria: r.criteria as LegalHoldCriteria,
  status: r.status,
  appliedBy: r.appliedBy,
  appliedAt: r.appliedAt,
  releasedAt: r.releasedAt,
});

/** True when `criteria` carries the governance marker (placed through M36's apply route, not M4's own). */
export const isGovernanceHold = (criteria: unknown): boolean =>
  typeof criteria === "object" &&
  criteria !== null &&
  (criteria as { origin?: unknown }).origin === MESSAGING_GOVERNANCE_HOLD_ORIGIN;

/** The org's newest governance-placed holds (active and released); M4-placed holds are invisible here. Org-filtered in addition to RLS. */
export async function listLegalHolds(
  tx: DbClient,
  organizationId: string,
  limit: number,
): Promise<readonly LegalHoldSummary[]> {
  const rows = await tx
    .select()
    .from(HOLD)
    .where(
      and(
        eq(HOLD.organizationId, organizationId),
        sql`${HOLD.criteria}->>'origin' = ${MESSAGING_GOVERNANCE_HOLD_ORIGIN}`,
      ),
    )
    .orderBy(desc(HOLD.appliedAt), desc(HOLD.id))
    .limit(limit);
  return rows.map(toSummary);
}

/** One governance-placed hold of this org, or null (unknown, another tenant's and an M4-placed id are the same answer). */
export async function getLegalHold(
  tx: DbClient,
  organizationId: string,
  id: string,
): Promise<LegalHoldSummary | null> {
  const [row] = await tx
    .select()
    .from(HOLD)
    .where(and(eq(HOLD.organizationId, organizationId), eq(HOLD.id, id)))
    .limit(1);
  return row && isGovernanceHold(row.criteria) ? toSummary(row) : null;
}

/** Status of the given certificates (id -> status), for the retention overview. */
export async function certificateStatuses(
  tx: DbClient,
  organizationId: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: CERT.id, status: CERT.status })
    .from(CERT)
    .where(and(eq(CERT.organizationId, organizationId), inArray(CERT.id, [...ids])));
  return new Map(rows.map((r) => [r.id, r.status]));
}

/**
 * The hold seam M36's governance routes call (ADR-0086, WP 5.6), bound at the composition root with M4's outbox. M36 declares the matching
 * port interface itself (structural typing), so it imports nothing from here.
 */
export function createMessagingGovernanceHoldPort(deps: { readonly outbox?: M4OutboxPort }) {
  return {
    list: listLegalHolds,
    get: getLegalHold,
    activeHolds: activeLegalHolds,
    certificateStatuses,
    async apply(
      tx: DbClient,
      auditContext: AuditContext,
      input: Omit<ApplyLegalHoldInput, "criteria"> & { readonly criteria: unknown },
    ): Promise<{ readonly id: string }> {
      const row = await applyLegalHoldInTx(tx, deps, auditContext, {
        ...input,
        criteria: input.criteria as LegalHoldCriteria,
      });
      return { id: row.id };
    },
    async release(
      tx: DbClient,
      auditContext: AuditContext,
      input: Omit<ReleaseLegalHoldInput, "countRestored"> & {
        readonly countRestored: () => Promise<number>;
      },
    ): Promise<{ readonly restoredRecordCount: number }> {
      // Defence in depth: the service already resolved the hold through `get`, but release must never reach an M4-placed hold.
      if (!(await getLegalHold(tx, input.organizationId, input.holdId))) {
        throw new NotFoundError("legal_hold", input.holdId);
      }
      const out = await releaseLegalHoldInTx(tx, deps, auditContext, {
        ...input,
        countRestored: () => input.countRestored(),
      });
      return { restoredRecordCount: out.restoredRecordCount };
    },
  };
}
