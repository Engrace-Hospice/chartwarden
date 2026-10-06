// apps/backend/src/modules/03-authorization/engagement-store.ts — the PRODUCTION EngagementStore (M3 §3.5,
// GAP-011): the live Drizzle implementation over the M3-owned `auditor_engagement` table. The engagement
// console (POST/PATCH /engagements, enroll, summary) ran on `createInMemoryEngagementStore`, so no
// `auditor_engagement` row was ever written and an engagement vanished on restart — which is also why the
// M31 auditor view had nothing real to resolve. Every statement runs inside `withOrgContext` (create) /
// `withOrgContextFromRequest` (by-id) so RLS scopes it by `app.org_id`.
//
// Lifecycle notes (spec §2.3.3): an engagement created with `start_at <= now` is created `active` (the
// "reaches start_at → active" transition is already true); a future one is `scheduled`. NO worker flips a
// scheduled row to active or closes an expired one yet (`authz.close_engagements` is unbuilt), so the
// reader — which requires `active` AND the window — keeps denying a not-yet-activated row. Fail closed.
//
// The enrolled-auditor COUNT lives in a server-owned `scope` key (no enrolment table exists); it is stripped
// from anything a client supplies and from the view the routes return.
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import { ValidationError } from "@wardenx/types";
import { eq, sql } from "drizzle-orm";
import type {
  EngagementStatus,
  EngagementStore,
  EngagementSummary,
  EngagementView,
} from "./authz-ports";
import { ENROLLED_COUNT_KEY, stripReservedScopeKeys } from "./engagement-scope";

const TABLE = schema.auditorEngagements;
const COLUMNS = {
  id: TABLE.id,
  organizationId: TABLE.organizationId,
  engagementType: TABLE.engagementType,
  auditorAgency: TABLE.auditorAgency,
  scope: TABLE.scope,
  status: TABLE.status,
  startAt: TABLE.startAt,
  endAt: TABLE.endAt,
} as const;

interface Row {
  id: string;
  organizationId: string;
  engagementType: string;
  auditorAgency: string;
  scope: unknown;
  status: string;
  startAt: Date;
  endAt: Date;
}

function toView(r: Row): EngagementView {
  return {
    engagementId: r.id,
    organizationId: r.organizationId,
    engagementType: r.engagementType,
    auditorAgency: r.auditorAgency,
    scope: stripReservedScopeKeys(r.scope),
    status: r.status as EngagementStatus,
    startAt: r.startAt.toISOString(),
    endAt: r.endAt.toISOString(),
  };
}

function enrolledCount(scope: unknown): number {
  const raw =
    typeof scope === "object" && scope !== null
      ? (scope as Record<string, unknown>)[ENROLLED_COUNT_KEY]
      : undefined;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/** Build the live EngagementStore over the pooled Drizzle client (org-scoped under RLS). */
export function createDbEngagementStore(
  db: DbClient,
  now: () => Date = () => new Date(),
): EngagementStore {
  return {
    async create(input): Promise<EngagementView> {
      const startAt = new Date(input.startAt);
      const endAt = new Date(input.endAt);
      const status: EngagementStatus =
        startAt.getTime() <= now().getTime() ? "active" : "scheduled";
      return withOrgContext(
        db,
        { organizationId: input.organizationId, userId: input.createdByUserId },
        async (tx) => {
          const inserted = (await tx
            .insert(TABLE)
            .values({
              organizationId: input.organizationId,
              engagementType: input.engagementType as never,
              auditorAgency: input.auditorAgency,
              scope: { ...stripReservedScopeKeys(input.scope), [ENROLLED_COUNT_KEY]: 0 },
              status,
              startAt,
              endAt,
              createdBy: input.createdByUserId,
            })
            .returning(COLUMNS)) as Row[];
          const row = inserted[0];
          if (!row) throw new Error("auditor_engagement insert returned no row");
          return toView(row);
        },
      );
    },

    async get(engagementId): Promise<EngagementView | null> {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = (await tx
          .select(COLUMNS)
          .from(TABLE)
          .where(eq(TABLE.id, engagementId))
          .limit(1)) as Row[];
        return rows[0] ? toView(rows[0]) : null;
      });
    },

    async update(engagementId, patch): Promise<EngagementView> {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = (await tx
          .select(COLUMNS)
          .from(TABLE)
          .where(eq(TABLE.id, engagementId))
          .limit(1)) as Row[];
        const current = rows[0];
        if (!current) throw new Error(`unknown engagement ${engagementId}`);
        const set: { status?: "cancelled"; endAt?: Date } = {};
        if (patch.cancel && (current.status === "scheduled" || current.status === "active")) {
          set.status = "cancelled";
        }
        if (patch.endAt !== undefined) {
          const next = new Date(patch.endAt);
          // "Shorten the window" (route doc): never extend an engagement past what Compliance granted,
          // and never to an interval the `auditor_engagement_window_chk` CHECK would refuse.
          if (
            !(
              next.getTime() > current.startAt.getTime() &&
              next.getTime() <= current.endAt.getTime()
            )
          ) {
            throw new ValidationError("invalid window", [
              {
                field: "endAt",
                code: "INVALID",
                message: "endAt may only shorten the window and must stay after startAt",
              },
            ]);
          }
          set.endAt = next;
        }
        if (Object.keys(set).length === 0) return toView(current);
        const updated = (await tx
          .update(TABLE)
          .set(set)
          .where(eq(TABLE.id, engagementId))
          .returning(COLUMNS)) as Row[];
        if (!updated[0]) throw new Error(`unknown engagement ${engagementId}`);
        return toView(updated[0]);
      });
    },

    async recordAuditorEnrolled(engagementId): Promise<void> {
      await withOrgContextFromRequest(db, async (tx) => {
        // Atomic increment of the server-owned counter (no read-modify-write race across instances).
        await tx
          .update(TABLE)
          .set({
            scope: sql`COALESCE(${TABLE.scope}, '{}'::jsonb) || jsonb_build_object(${ENROLLED_COUNT_KEY}::text, COALESCE((${TABLE.scope} ->> ${ENROLLED_COUNT_KEY}::text)::int, 0) + 1)`,
          })
          .where(eq(TABLE.id, engagementId));
      });
    },

    async summary(engagementId): Promise<EngagementSummary | null> {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = (await tx
          .select(COLUMNS)
          .from(TABLE)
          .where(eq(TABLE.id, engagementId))
          .limit(1)) as Row[];
        const row = rows[0];
        if (!row) return null;
        return {
          engagementId,
          auditorsEnrolled: enrolledCount(row.scope),
          resourcesTouched: 0, // populated from the break-glass + read-audit trail (M4/T10).
        };
      });
    },
  };
}
