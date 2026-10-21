// @chartwarden/audit — the PRODUCTION `performErasure` executor (M4 spec §6, §10.5; TASK-003
// follow-up): the actual row destruction behind `eraseAuditRows`. It lives HERE because
// `audit_event` is HELPER-ONLY (manifest HELPER_ONLY_TABLES) — packages/audit is the only
// sanctioned code allowed to touch the table — and because the tenant role cannot do this at all:
// `wardenx_app` holds INSERT/SELECT only (migration 0001, the append-only guarantee), so the
// caller must inject a DESTRUCTION-GRANTED DbClient (a separately pooled credential holding
// DELETE on `audit_event`, e.g. `wardenx_admin`). The M4 backend keeps its `performErasure` leg a
// loud UNBOUND throw until deployment provisions that credential and threads it through.
//
// Semantics — a hard partitioned DELETE, not a crypto-erase: `audit_event` stores its payloads
// (`before`/`after`/`context`) as plaintext jsonb with no per-row key to shred, so the only
// faithful erasure is destroying the rows. The DELETE targets the partitioned PARENT, which
// Postgres routes to every leaf (monthly `audit_event_YYYY_MM` partitions + `audit_event_default`);
// `EraseInput` carries no `created_at` window, so no partition pruning applies — the per-partition
// `audit_event_resource_idx` (resource_kind, resource_id) keeps the scan indexed.
//
// What one call destroys — exactly the row-group the orchestrator already vetted, nothing wider:
//   • organization_id = input.organizationId — an EXPLICIT org predicate as the second wall on top
//     of the withOrgContext envelope (repo precedent): the destruction role may not be subject to
//     tenant RLS, so the envelope alone cannot be trusted to scope the DELETE.
//   • resource_kind = input.resourceKind, and the row's resource: `resource_id = input.resourceId`
//     OR — mirroring the M4 store's `resourceId ?? r.id` grouping for rows with no resource id —
//     `resource_id IS NULL AND id = input.resourceId`.
//   • retention_class = input.retentionClass (text-cast: `compliance_42cfr_part2` is type-only
//     until the enum widening lands, same as the query adapter): the legal-hold/Part 2 guards ran
//     per (class, kind, id) group, so a row of a DIFFERENT class under the same resource was never
//     evaluated and must survive this call.
//   • NOT held (GAP-008, ADR-0051): a row with an overlay entry (`legal_hold_audit_event`) under a still-ACTIVE hold is
//     excluded from the DELETE itself, so the per-row protection holds even when the group-level check (which vets whole
//     groups by selector) is bypassed or stale; the database trigger on `audit_event` is the second backstop.
// The returned count is rows ACTUALLY destroyed (`.returning()` length) — never the requested
// group size — so a certificate line can only certify what left the database.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { EraseInput, EraserPorts } from "./eraser";
import { rowHeldByActiveLegalHold } from "./hold-overlay";

const A = schema.auditEvents;

/** The execution leg of `EraserPorts` — just the destruction, none of the guards. */
export type AuditEraseExecutor = Pick<EraserPorts, "performErasure">;

/**
 * Build the Drizzle `performErasure` executor over an injected DESTRUCTION-GRANTED client.
 * Do NOT pass the tenant pool here — `wardenx_app` has no DELETE grant and the call would fail
 * (correctly) at the database. The eraser/destruction guards (§10.6 legal hold, §6 Part 2) are NOT
 * re-checked here; this executor must only ever run behind `eraseAuditRows`, which is the sole
 * caller of the `performErasure` port.
 */
export function createDbAuditEraseExecutor(db: DbClient): AuditEraseExecutor {
  return {
    async performErasure(input: EraseInput): Promise<number> {
      return withOrgContext(
        db,
        { organizationId: input.organizationId, userId: "" },
        async (tx) => {
          const destroyed = await tx
            .delete(A)
            .where(
              and(
                // Second wall: explicit org scoping — the destruction role may bypass tenant RLS.
                eq(A.organizationId, input.organizationId),
                eq(A.resourceKind, input.resourceKind),
                or(
                  eq(A.resourceId, input.resourceId),
                  // A group formed from a resource-id-less row is keyed on the event id itself
                  // (the M4 store's `resourceId ?? r.id`); match it without widening to other
                  // rows that merely share a NULL resource_id.
                  and(isNull(A.resourceId), eq(A.id, input.resourceId)),
                ),
                sql`${A.retentionClass}::text = ${input.retentionClass}`,
                // GAP-008: a row an active legal hold covers is never destroyed (the overlay, not a retention_class flip).
                sql`NOT ${rowHeldByActiveLegalHold()}`,
                // GAP-008: inside the span the legal-hold check ran against - never wider (see EraseInput).
                input.createdAtFrom ? gte(A.createdAt, new Date(input.createdAtFrom)) : undefined,
                // Exclusive of the NEXT millisecond: the span came from JS Dates (ms) but created_at is microsecond.
                input.createdAtTo
                  ? lt(A.createdAt, new Date(Date.parse(input.createdAtTo) + 1))
                  : undefined,
              ),
            )
            .returning({ id: A.id });
          return destroyed.length;
        },
      );
    },
  };
}
