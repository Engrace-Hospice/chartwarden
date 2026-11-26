// apps/backend/src/modules/11-orders/critical-lab-resolution.ts — #1136 (CW-CS-01): the in-app way to RESOLVE a
// quarantined (no-order) critical lab result.
//
// A critical result bound to no order sits in the `critical_lab_result` ledger (migration 1297) as
// `quarantined_no_order`, is paged at once and escalated once, and until now stayed there until someone edited the
// database. Resolving it appends ONE row to `critical_lab_result_resolution` (migration 1558): what the clinician decided
// (`matched_to_order` + the order, or `reviewed_no_action`), the required reason, who (membership + discipline) and when
// (database clock). The ledger row itself is never updated, so the app role needs no new UPDATE grant, and the resolution
// table is append-only (INSERT-only grant + trigger): a cleared result cannot be re-opened, rewritten or deleted by the
// application. "Open" is therefore "quarantined AND no resolution row": the escalation sweep and the queue read ask that.
//
// Who may resolve: the route requires `orders.complete` (the existing "Mark reviewed" grant) and this requires a
// prescriber discipline (the #909 lab-review rule: clearing a critical result is a clinical determination), plus the
// patient on the caller's scope. Resolving emits `m11.order.critical_lab_resolved` in the same transaction through the
// injected (catalog-validating) outbox port. PHI: ids only on the event; the free-text reason is stored in the row and is
// scrubbed from the audit images by the trigger; no message in this file carries it.
import { type DbClient, schema } from "@chartwarden/db";
import { decodeCursor, encodeCursor } from "@chartwarden/shared/route-kit";
import { withOrgContext } from "@chartwarden/tenancy";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@chartwarden/types";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type ResultReviewActor, reviewerDisciplineOf } from "./order-result-review";
import type { OrderWriteOutboxPort } from "./orders-route-service-db";

const CLR = schema.criticalLabResults;
const RES = schema.criticalLabResultResolutions;
const ORDER = schema.orderRecords;

export type CriticalLabResolutionKind = "matched_to_order" | "reviewed_no_action";

/** The catalog event a resolution publishes (`events-by-m11.ts`). */
export const CRITICAL_LAB_RESOLVED_EVENT = "m11.order.critical_lab_resolved";

export const CRITICAL_LAB_REASON_MIN_LENGTH = 10;
export const CRITICAL_LAB_REASON_MAX_LENGTH = 1000;

export interface ResolveCriticalLabInput {
  readonly resolution: CriticalLabResolutionKind;
  /** Required for `matched_to_order`, refused for `reviewed_no_action`. */
  readonly matchedOrderId?: string | undefined;
  readonly reason: string;
}

export interface CriticalLabResolutionView {
  readonly id: string;
  readonly criticalLabResultId: string;
  readonly resolution: CriticalLabResolutionKind;
  readonly matchedOrderId: string | null;
  readonly reason: string;
  readonly resolverMembershipId: string;
  readonly resolverDiscipline: string;
  readonly resolvedAt: string;
}

/** A ledger row as the queue shows it: ids, a LOINC code, a flag and instants — never a result value. */
export interface CriticalLabResultView {
  readonly id: string;
  readonly observationId: string;
  readonly patientId: string;
  readonly loincCode: string;
  readonly criticalFlag: "HH" | "LL";
  readonly disposition: "paged" | "quarantined_no_order";
  readonly receivedAt: string;
  readonly respondBy: string | null;
  readonly escalatedAt: string | null;
}

export interface CriticalLabResultDetail extends CriticalLabResultView {
  /** Null while the result is open. */
  readonly resolution: CriticalLabResolutionView | null;
}

export interface QuarantinedCriticalPage {
  readonly items: readonly CriticalLabResultView[];
  readonly nextCursor: string | null;
}

export interface CriticalLabResolutionDeps {
  readonly db: DbClient;
  readonly outbox: OrderWriteOutboxPort;
}

// ── keyset cursor over (respond_by, id) ──────────────────────────────────────────────────────────────────────────────

const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed keyset payload: `u` the microsecond `respond_by` instant, `i` the ledger row id. */
interface QueueCursor {
  readonly u: string;
  readonly i: string;
}

function isQueueCursor(value: unknown): value is QueueCursor {
  const v = value as Partial<QueueCursor> | null;
  return (
    typeof v?.u === "string" && typeof v.i === "string" && ISO_MICROS.test(v.u) && UUID.test(v.i)
  );
}

/** `respond_by` at MICROSECOND precision as an ISO string — a JS `Date` would truncate to ms and break the keyset. */
const respondByIso = sql<string>`to_char(${CLR.respondBy} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** SQL: a quarantined result with NO resolution row. Correlated on `critical_lab_result`. */
export function criticalLabOpen() {
  return and(
    eq(CLR.disposition, "quarantined_no_order"),
    sql`NOT EXISTS (
      SELECT 1 FROM ${RES}
       WHERE ${RES.organizationId} = ${CLR.organizationId}
         AND ${RES.criticalLabResultId} = ${CLR.id})`,
  );
}

type ResultRow = typeof CLR.$inferSelect;
type ResolutionRow = typeof RES.$inferSelect;

function toResultView(r: ResultRow): CriticalLabResultView {
  return {
    id: r.id,
    observationId: r.observationId,
    patientId: r.patientId,
    loincCode: r.loincCode,
    criticalFlag: r.criticalFlag,
    disposition: r.disposition,
    receivedAt: r.receivedAt.toISOString(),
    respondBy: r.respondBy?.toISOString() ?? null,
    escalatedAt: r.escalatedAt?.toISOString() ?? null,
  };
}

function toResolutionView(r: ResolutionRow): CriticalLabResolutionView {
  return {
    id: r.id,
    criticalLabResultId: r.criticalLabResultId,
    resolution: r.resolution,
    matchedOrderId: r.matchedOrderId ?? null,
    reason: r.reason,
    resolverMembershipId: r.resolverMembershipId,
    resolverDiscipline: r.resolverDiscipline,
    resolvedAt: r.resolvedAt.toISOString(),
  };
}

/** The patient a ledger row belongs to (org-scoped, RLS-backstopped) — the route's scope guard resolves through this. */
export async function criticalLabPatientId(
  deps: CriticalLabResolutionDeps,
  organizationId: string,
  resultId: string,
): Promise<string | null> {
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const [row] = await (scoped as unknown as DbClient)
      .select({ patientId: CLR.patientId })
      .from(CLR)
      .where(and(eq(CLR.id, resultId), eq(CLR.organizationId, organizationId)))
      .limit(1);
    return row?.patientId ?? null;
  });
}

/** The open quarantine queue, soonest response deadline first, narrowed to `patientIds` (null = org-wide). */
export async function listOpenQuarantinedCriticalLabs(
  deps: CriticalLabResolutionDeps,
  organizationId: string,
  opts: {
    readonly limit: number;
    readonly cursor?: string | undefined;
    readonly patientIds: readonly string[] | null;
  },
): Promise<QuarantinedCriticalPage> {
  if (opts.patientIds !== null && opts.patientIds.length === 0) {
    return { items: [], nextCursor: null };
  }
  const limit = Math.max(1, Math.min(opts.limit, 100));
  const after = decodeCursor(organizationId, opts.cursor, isQueueCursor);
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const rows = await (scoped as unknown as DbClient)
      .select({ row: CLR, respondByIso })
      .from(CLR)
      .where(
        and(
          eq(CLR.organizationId, organizationId),
          criticalLabOpen(),
          opts.patientIds === null ? undefined : inArray(CLR.patientId, [...opts.patientIds]),
          after === null
            ? undefined
            : sql`(${CLR.respondBy}, ${CLR.id}) > (${after.u}::timestamptz, ${after.i}::uuid)`,
        ),
      )
      .orderBy(asc(CLR.respondBy), asc(CLR.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toResultView(r.row)),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(organizationId, { u: last.respondByIso, i: last.row.id })
          : null,
    };
  });
}

/** One ledger row with its resolution (if any). 404 for an unknown, cross-tenant or off-scope row. */
export async function getCriticalLabResult(
  deps: CriticalLabResolutionDeps,
  organizationId: string,
  resultId: string,
  assertInScope: (patientId: string) => Promise<void>,
): Promise<CriticalLabResultDetail> {
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as unknown as DbClient;
    const [row] = await tx
      .select()
      .from(CLR)
      .where(and(eq(CLR.id, resultId), eq(CLR.organizationId, organizationId)))
      .limit(1);
    if (!row) throw new NotFoundError("critical lab result");
    await assertInScope(row.patientId);
    const [resolved] = await tx
      .select()
      .from(RES)
      .where(and(eq(RES.organizationId, organizationId), eq(RES.criticalLabResultId, resultId)))
      .limit(1);
    return { ...toResultView(row), resolution: resolved ? toResolutionView(resolved) : null };
  });
}

/**
 * Resolve a quarantined critical lab result. 403 for a non-prescriber, 404 for an unknown / cross-tenant / off-scope
 * result, 409 when the result is not quarantined or is already resolved (a result is resolved once; the original
 * resolution stands), 422 when the matched order is not a lab order of the same patient.
 */
export async function resolveCriticalLabResult(
  deps: CriticalLabResolutionDeps,
  organizationId: string,
  resultId: string,
  input: ResolveCriticalLabInput,
  actor: ResultReviewActor,
  assertInScope: (patientId: string) => Promise<void>,
): Promise<CriticalLabResolutionView> {
  const discipline = reviewerDisciplineOf(actor);
  if (discipline === null || actor.kind === "system" || !actor.membershipId) {
    throw new ForbiddenError("only a prescriber may resolve a critical lab result");
  }
  const reason = input.reason.trim();
  if (reason.length < CRITICAL_LAB_REASON_MIN_LENGTH) {
    throw new ValidationError("a reason is required", [
      {
        field: "reason",
        code: "too_short",
        message: `at least ${CRITICAL_LAB_REASON_MIN_LENGTH} characters`,
      },
    ]);
  }
  const matchedOrderId = input.matchedOrderId ?? null;
  if ((input.resolution === "matched_to_order") !== (matchedOrderId !== null)) {
    throw new ValidationError("matchedOrderId does not fit the resolution", [
      {
        field: "matchedOrderId",
        code: "resolution_mismatch",
        message: "required for matched_to_order and refused for reviewed_no_action",
      },
    ]);
  }
  return withOrgContext(
    deps.db,
    { organizationId, userId: actor.userId ?? "" },
    async (txRaw): Promise<CriticalLabResolutionView> => {
      const tx = txRaw as unknown as DbClient;
      // Lock the ledger row: two concurrent resolvers serialize, and the loser finds the winner's row below.
      const [row] = await tx
        .select()
        .from(CLR)
        .where(and(eq(CLR.id, resultId), eq(CLR.organizationId, organizationId)))
        .for("update")
        .limit(1);
      if (!row) throw new NotFoundError("critical lab result");
      await assertInScope(row.patientId);
      if (row.disposition !== "quarantined_no_order") {
        throw new ConflictError("only a quarantined (no-order) critical result can be resolved");
      }
      const [already] = await tx
        .select({ id: RES.id })
        .from(RES)
        .where(and(eq(RES.organizationId, organizationId), eq(RES.criticalLabResultId, resultId)))
        .limit(1);
      if (already) throw new ConflictError("this critical lab result is already resolved");
      if (matchedOrderId !== null) {
        const [order] = await tx
          .select({ id: ORDER.id })
          .from(ORDER)
          .where(
            and(
              eq(ORDER.id, matchedOrderId),
              eq(ORDER.organizationId, organizationId),
              eq(ORDER.patientId, row.patientId),
              eq(ORDER.kind, "lab"),
            ),
          )
          .limit(1);
        if (!order) {
          throw new ValidationError("the matched order is not a lab order of this patient", [
            {
              field: "matchedOrderId",
              code: "not_a_lab_order_of_patient",
              message: "unknown here, another patient's, or not a lab order",
            },
          ]);
        }
      }
      const [inserted] = await tx
        .insert(RES)
        .values({
          organizationId,
          providerEntityId: row.providerEntityId,
          locationId: row.locationId,
          patientId: row.patientId,
          criticalLabResultId: row.id,
          resolution: input.resolution,
          matchedOrderId,
          reason,
          resolverMembershipId: actor.membershipId,
          resolverDiscipline: discipline,
        })
        .returning();
      if (!inserted) throw new ConflictError("the resolution could not be recorded");
      // Ids and the decision only — never the reason. Same transaction: a refused publish rolls the resolution back.
      await deps.outbox.publish(tx, {
        eventName: CRITICAL_LAB_RESOLVED_EVENT,
        payload: {
          criticalLabResultId: row.id,
          organizationId,
          observationId: row.observationId,
          patientId: row.patientId,
          resolution: input.resolution,
          ...(matchedOrderId === null ? {} : { matchedOrderId }),
        },
        organizationId,
        aggregateKind: "critical_lab_result",
        aggregateId: row.id,
      });
      return toResolutionView(inserted);
    },
  );
}
