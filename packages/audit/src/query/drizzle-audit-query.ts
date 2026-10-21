// @chartwarden/audit — the PRODUCTION AuditQuery (M4 §4.1–4.3) over the M1-owned, append-only
// `audit_event` log. `audit_event` is HELPER-ONLY (manifest HELPER_ONLY_TABLES) — packages/audit is its
// only sanctioned reader, so this Drizzle adapter lives here (not the M4 backend dir).
//
// Every read runs inside `withOrgContext`, so RLS scopes rows to the tenant (`audit_event` grants
// wardenx_app SELECT on its own org's rows only). All list reads are cursor-paginated newest-first; the
// opaque cursor encodes the last row's (createdAt, id) for stability across the partitioned table. The
// filter/access/scope predicates are pushed to SQL so pagination is exact (LIMIT n+1).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { type SQL, and, desc, eq, getTableColumns, gte, lte, or, sql } from "drizzle-orm";
import { rowHeldByActiveLegalHold } from "../lifecycle/hold-overlay";
import {
  ACCOUNTING_TPO_EXCLUSION_NOTE,
  type AccountingFilter,
  type AccountingReport,
  type AccountingScope,
  type AuditEventFilter,
  type AuditEventRecord,
  type AuditQuery,
  type DisclosureEntry,
  type Page,
  type PatientAccessEntry,
  type PatientAccessFilter,
  decodeCursor,
  encodeCursor,
  resolveLimit,
} from "./audit-query";

const A = schema.auditEvents;

/** Project a Drizzle `audit_event` row into the AuditEventRecord DTO (createdAt as ISO string). */
function toRecord(r: typeof A.$inferSelect & { legalHold?: boolean }): AuditEventRecord {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    organizationId: r.organizationId,
    actorUserId: r.actorUserId,
    actorKind: r.actorKind,
    actorRole: r.actorRole,
    eventType: r.eventType,
    resourceKind: r.resourceKind,
    resourceId: r.resourceId,
    outcome: r.outcome as AuditEventRecord["outcome"],
    severity: r.severity as AuditEventRecord["severity"],
    before: (r.before as Record<string, unknown> | null) ?? null,
    after: (r.after as Record<string, unknown> | null) ?? null,
    context: (r.context as Record<string, unknown>) ?? {},
    retentionClass: r.retentionClass as AuditEventRecord["retentionClass"],
    ...(r.legalHold === undefined ? {} : { legalHold: r.legalHold }),
  };
}

/** True while an ACTIVE legal hold covers the row: an overlay entry whose hold is still 'active' (ADR-0051). */
const heldByActiveLegalHold = rowHeldByActiveLegalHold() as SQL<boolean>;

/** Newest-first "strictly older than the cursor" predicate: (createdAt, id) < (cAt, cId). */
function afterCursor(cursor?: string): SQL | undefined {
  if (!cursor) return undefined;
  const c = decodeCursor(cursor);
  if (!c) return undefined;
  return or(
    sql`${A.createdAt} < ${c.createdAt}`,
    and(sql`${A.createdAt} = ${c.createdAt}`, sql`${A.id} < ${c.id}`),
  );
}

/** Event TOUCHES `patientId`: context.patientId match, or a `patient`-kind row. */
function touchesPatient(patientId: string): SQL {
  return or(
    sql`${A.context}->>'patientId' = ${patientId}`,
    and(eq(A.resourceKind, "patient"), sql`${A.resourceId} = ${patientId}::uuid`),
  ) as SQL;
}

/** ACCESS event (§10.2): a read/disclosure/list-view/access, or an under-glass access. */
function isAccess(): SQL {
  return or(
    sql`${A.eventType} LIKE '%.viewed'`,
    sql`${A.eventType} LIKE '%.disclosed'`,
    sql`${A.eventType} LIKE '%.list_viewed'`,
    sql`${A.eventType} LIKE '%.access'`,
    sql`${A.eventType} LIKE '%breakglass.access%'`,
    sql`${A.context} ? 'breakGlassEventId'`,
  ) as SQL;
}

/** The §7 accounting set for a scope, as a SQL predicate. */
function inScope(scope: AccountingScope): SQL {
  switch (scope) {
    case "hipaa_528":
      return sql`${A.eventType} LIKE '%.disclosed'`;
    case "part_2_13":
      // `compliance_42cfr_part2` is a type-only retention class — the pg enum doesn't carry it yet
      // (M4-T09 deferred the enum widening), so compare via a text cast (valid SQL; matches nothing
      // until the value exists rather than erroring on an unknown enum literal).
      return or(
        and(
          sql`${A.eventType} LIKE '%.disclosed'`,
          sql`${A.retentionClass}::text = 'compliance_42cfr_part2'`,
        ),
        eq(A.eventType, "sud.unredact.exercise"),
      ) as SQL;
    case "all":
      return or(
        sql`${A.eventType} LIKE '%.disclosed'`,
        eq(A.eventType, "sud.unredact.exercise"),
      ) as SQL;
  }
}

/** Split an over-fetched (n+1) row set into a page + nextCursor. */
function paginate<T>(rows: AuditEventRecord[], limit: number, project: (r: AuditEventRecord) => T): Page<T> {
  if (rows.length > limit) {
    const page = rows.slice(0, limit);
    return { items: page.map(project), nextCursor: encodeCursor(page[page.length - 1]!) };
  }
  return { items: rows.map(project), nextCursor: null };
}

function ctxString(context: Record<string, unknown>, field: string): string | undefined {
  const v = context[field];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Build the production AuditQuery over the pooled Drizzle client. */
export function createDbAuditQuery(db: DbClient): AuditQuery {
  const run = <T>(orgId: string, fn: (tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0]) => Promise<T>) =>
    withOrgContext(db, { organizationId: orgId, userId: "" }, fn);

  const fetch = async (
    tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
    where: SQL | undefined,
    limit: number,
  ): Promise<AuditEventRecord[]> => {
    const rows = await tx
      .select({ ...getTableColumns(A), legalHold: heldByActiveLegalHold })
      .from(A)
      .where(where)
      .orderBy(desc(A.createdAt), desc(A.id))
      .limit(limit + 1);
    return rows.map(toRecord);
  };

  return {
    async searchEvents(orgId: string, filter: AuditEventFilter): Promise<Page<AuditEventRecord>> {
      const limit = resolveLimit(filter.limit);
      const where = and(
        filter.actorUserId ? eq(A.actorUserId, filter.actorUserId) : undefined,
        filter.resourceKind ? eq(A.resourceKind, filter.resourceKind) : undefined,
        filter.resourceId ? sql`${A.resourceId} = ${filter.resourceId}::uuid` : undefined,
        filter.eventType ? eq(A.eventType, filter.eventType) : undefined,
        filter.outcome ? eq(A.outcome, filter.outcome as typeof A.$inferSelect.outcome) : undefined,
        filter.severity ? eq(A.severity, filter.severity as typeof A.$inferSelect.severity) : undefined,
        filter.from ? gte(A.createdAt, new Date(filter.from)) : undefined,
        filter.to ? lte(A.createdAt, new Date(filter.to)) : undefined,
        filter.patientId ? touchesPatient(filter.patientId) : undefined,
        afterCursor(filter.cursor),
      );
      return run(orgId, async (tx) => paginate(await fetch(tx, where, limit), limit, (r) => r));
    },

    async getEvent(orgId: string, id: string): Promise<AuditEventRecord | null> {
      return run(orgId, async (tx) => {
        const rows = await tx.select().from(A).where(eq(A.id, id)).limit(1);
        return rows[0] ? toRecord(rows[0]) : null;
      });
    },

    async patientAccess(
      orgId: string,
      patientId: string,
      filter: PatientAccessFilter,
    ): Promise<Page<PatientAccessEntry>> {
      const limit = resolveLimit(filter.limit);
      const where = and(
        touchesPatient(patientId),
        isAccess(),
        filter.from ? gte(A.createdAt, new Date(filter.from)) : undefined,
        filter.to ? lte(A.createdAt, new Date(filter.to)) : undefined,
        afterCursor(filter.cursor),
      );
      return run(orgId, async (tx) =>
        paginate(await fetch(tx, where, limit), limit, (r) => ({
          eventId: r.id,
          at: r.createdAt,
          actorUserId: r.actorUserId,
          actorRole: r.actorRole,
          eventType: r.eventType,
          fields: Array.isArray(r.context.fields)
            ? (r.context.fields as unknown[]).filter((f): f is string => typeof f === "string")
            : [],
          viaBreakGlass: typeof r.context.breakGlassEventId === "string",
        })),
      );
    },

    async accounting(
      orgId: string,
      patientId: string,
      filter: AccountingFilter,
    ): Promise<AccountingReport> {
      const limit = resolveLimit(filter.limit);
      const where = and(
        touchesPatient(patientId),
        inScope(filter.scope),
        gte(A.createdAt, new Date(filter.from)),
        lte(A.createdAt, new Date(filter.to)),
        afterCursor(filter.cursor),
      );
      const project = (r: AuditEventRecord): DisclosureEntry => {
        const disc = r.context.disclosure as { to?: unknown; purpose?: unknown } | undefined;
        const fields = Array.isArray(r.context.fields)
          ? (r.context.fields as unknown[]).filter((f): f is string => typeof f === "string")
          : [];
        return {
          date: r.createdAt,
          recipient: (typeof disc?.to === "string" && disc.to) || ctxString(r.context, "recipient") || "internal",
          purpose: (typeof disc?.purpose === "string" && disc.purpose) || ctxString(r.context, "purpose") || r.eventType,
          description: fields.length > 0 ? `${r.resourceKind}: ${fields.join(", ")}` : r.resourceKind,
          eventId: r.id,
          // §4.6.4: the unredact rationale is patient-accessible under Part 2 only.
          ...(filter.scope !== "hipaa_528" && ctxString(r.context, "rationale")
            ? { rationale: ctxString(r.context, "rationale") }
            : {}),
        };
      };
      return run(orgId, async (tx) => {
        const page = paginate(await fetch(tx, where, limit), limit, project);
        return {
          patientId,
          period: { from: filter.from, to: filter.to },
          disclosures: page.items,
          note: ACCOUNTING_TPO_EXCLUSION_NOTE,
          nextCursor: page.nextCursor,
        };
      });
    },
  };
}
