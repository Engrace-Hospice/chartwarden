// @wardenx/audit — the Drizzle reader behind the audit hash-chain seal and its sampled verification
// (M4 §4.4). `audit_event` is HELPER-ONLY, so the only sanctioned reader of its rows is this package; the
// backend job in apps/backend/src/modules/04-audit/jobs consumes this port and never selects the table.
//
// EXACTNESS. Everything that feeds a hash is read so that no precision is lost on the way to JS:
//   • `created_at` is rendered by Postgres as UTC ISO-8601 WITH MICROSECONDS (a JS Date keeps only ms, and
//     two rows within the same ms would also break a Date-based keyset cursor);
//   • the keyset cursor re-parses that same text as `timestamptz`, so paging is exact to the microsecond;
//   • `before` / `after` / `context` are read as `jsonb::text` (Postgres' canonical rendering), not
//     re-serialised from a parsed object.
// Every read runs inside `withOrgContext`, so RLS scopes it to the tenant, and carries an explicit
// `organization_id` predicate as well.
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { type SQL, sql } from "drizzle-orm";
import { type RecomputedMonth, createChainHasher, hashAuditRow } from "./chain-sample";

/** Rows fetched per round trip while streaming a month. */
export const CHAIN_READ_PAGE_SIZE = 1000;

const ISO_UTC_MICROS = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The first instant of `month` (`YYYY-MM`) and of the following month, as UTC ISO strings. */
export function monthBounds(month: string): { start: string; next: string } {
  if (!MONTH_RE.test(month)) throw new Error(`invalid audit month '${month}'`);
  const [y, m] = month.split("-").map(Number) as [number, number];
  return {
    start: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    next: new Date(Date.UTC(y, m, 1)).toISOString(),
  };
}

/** `YYYY-MM` of a UTC instant. */
export const monthOf = (at: Date): string => at.toISOString().slice(0, 7);

export interface AuditChainReader {
  /** UTC months (`YYYY-MM`, ascending) that hold at least one of the org's events and end before `before`. */
  listClosedMonths(organizationId: string, before: Date): Promise<string[]>;
  /**
   * Stream a month's rows in `(created_at, id)` order into a chain digest that starts from
   * `prevChainHash`. Returns null when the org has no event in that month.
   */
  digestMonth(
    organizationId: string,
    month: string,
    prevChainHash: string | null,
  ): Promise<RecomputedMonth | null>;
}

interface RawRow extends Record<string, unknown> {
  id: string;
  ts: string;
  organization_id: string | null;
  actor_user_id: string | null;
  actor_kind: string;
  actor_role: string | null;
  event_type: string;
  resource_kind: string;
  resource_id: string | null;
  correlation_id: string;
  outcome: string;
  severity: string;
  retention_class: string;
  before_text: string | null;
  after_text: string | null;
  context_text: string | null;
}

/** Build the production reader over the pooled client. */
export function createDbAuditChainReader(db: DbClient): AuditChainReader {
  return {
    async listClosedMonths(organizationId, before) {
      const rows = await withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        tx.execute<{ month: string }>(sql`
          SELECT DISTINCT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month
            FROM audit_event
           WHERE organization_id = ${organizationId}::uuid
             AND created_at < ${before.toISOString()}::timestamptz
           ORDER BY 1
        `),
      );
      return rows.rows.map((r) => r.month);
    },

    async digestMonth(organizationId, month, prevChainHash) {
      const { start, next } = monthBounds(month);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const hasher = createChainHasher(prevChainHash);
        let eventCount = 0;
        let fromId: string | null = null;
        let toId: string | null = null;
        let cursorTs: string | null = null;
        let cursorId: string | null = null;
        for (;;) {
          const after: SQL =
            cursorTs !== null && cursorId !== null
              ? sql`AND (created_at, id) > (${cursorTs}::timestamptz, ${cursorId}::uuid)`
              : sql``;
          const page: { rows: RawRow[] } = await tx.execute<RawRow>(sql`
            SELECT id::text AS id,
                   to_char(created_at AT TIME ZONE 'UTC', ${sql.raw(`'${ISO_UTC_MICROS}'`)}) AS ts,
                   organization_id::text AS organization_id,
                   actor_user_id::text AS actor_user_id,
                   actor_kind::text AS actor_kind,
                   actor_role,
                   event_type,
                   resource_kind,
                   resource_id::text AS resource_id,
                   correlation_id,
                   outcome::text AS outcome,
                   severity::text AS severity,
                   retention_class::text AS retention_class,
                   before::text AS before_text,
                   after::text AS after_text,
                   context::text AS context_text
              FROM audit_event
             WHERE organization_id = ${organizationId}::uuid
               AND created_at >= ${start}::timestamptz
               AND created_at < ${next}::timestamptz
               ${after}
             ORDER BY created_at, id
             LIMIT ${CHAIN_READ_PAGE_SIZE}
          `);
          for (const r of page.rows) {
            hasher.add(
              hashAuditRow({
                id: r.id,
                createdAt: r.ts,
                organizationId: r.organization_id,
                actorUserId: r.actor_user_id,
                actorKind: r.actor_kind,
                actorRole: r.actor_role,
                eventType: r.event_type,
                resourceKind: r.resource_kind,
                resourceId: r.resource_id,
                correlationId: r.correlation_id,
                outcome: r.outcome,
                severity: r.severity,
                retentionClass: r.retention_class,
                beforeText: r.before_text,
                afterText: r.after_text,
                contextText: r.context_text,
              }),
            );
            eventCount += 1;
            fromId ??= r.id;
            toId = r.id;
          }
          const last: RawRow | undefined = page.rows[page.rows.length - 1];
          if (page.rows.length < CHAIN_READ_PAGE_SIZE || !last) break;
          cursorTs = last.ts;
          cursorId = last.id;
        }
        if (eventCount === 0) return null;
        return { eventCount, fromId, toId, chainHash: hasher.digest() };
      });
    },
  };
}
