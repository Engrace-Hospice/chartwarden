// apps/backend/src/modules/41-billing-commercial/services/enrollment-report-service.ts — ADVISORY clearinghouse enrollment
// reports (migration 1323, ADR-0100 note, ADR-0053 amendment D7).
//
// A report is what Claim.MD said about a provider entity's enrollment. It never changes a send gate: staff apply it through
// the EXISTING enrollments POST/PATCH (step-up, no AI actor, Idempotency-Key) and then resolve it `applied`, or dismiss it.
// Every call runs in `withOrgContext` (canonical app.org_id RLS; the write-audit trigger attributes the actor).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type ClearinghouseEnrollType,
  type CommercialEnrollmentReportState,
  ConflictError,
  NotFoundError,
} from "@chartwarden/types";
import { and, desc, eq, sql } from "drizzle-orm";

const R = schema.commercialEnrollmentReport;

/** The `reportedAt` text the vendor sent, read as UTC only when it is an unambiguous `YYYY-MM-DD HH:MM[:SS]`. */
const VENDOR_TIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/;
const PAYER_ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
const ENROLL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** The only vendor word mapped to a suggestion; every other word is shown, never interpreted. */
const ENROLLED_WORD = "enrolled";

export interface EnrollmentReportView {
  readonly id: string;
  readonly providerEntityId: string;
  readonly payerId: string | null;
  readonly clearinghouseKey: string;
  readonly clearinghousePayerId: string | null;
  readonly enrollType: ClearinghouseEnrollType;
  readonly vendorStatus: string;
  readonly suggestedStatus: "enrolled" | null;
  readonly vendorEnrollId: string | null;
  readonly reportedAt: string;
  readonly state: CommercialEnrollmentReportState;
  readonly resolvedAt: string | null;
}

/** The PHI-free `m23.clearinghouse.enrollment_reported` payload, as far as M41 reads it. */
export interface ReportedEnrollment {
  readonly sourceEventKey: string;
  readonly vendor: string;
  readonly providerEntityId: string;
  readonly enrollType: ClearinghouseEnrollType;
  readonly vendorStatus: string;
  readonly vendorEnrollId: string | null;
  readonly clearinghousePayerId: string | null;
  readonly reportedAt: string;
  readonly eventTime: string | null;
}

type Row = typeof R.$inferSelect;
const viewOf = (r: Row): EnrollmentReportView => ({
  id: r.id,
  providerEntityId: r.providerEntityId,
  payerId: r.payerId,
  clearinghouseKey: r.clearinghouseKey,
  clearinghousePayerId: r.clearinghousePayerId,
  enrollType: r.enrollType as ClearinghouseEnrollType,
  vendorStatus: r.vendorStatus,
  suggestedStatus: r.suggestedStatus === ENROLLED_WORD ? ENROLLED_WORD : null,
  vendorEnrollId: r.vendorEnrollId,
  reportedAt: r.reportedAt.toISOString(),
  state: r.state as CommercialEnrollmentReportState,
  resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
});

function reportedAtOf(report: ReportedEnrollment): Date {
  const m = report.eventTime ? VENDOR_TIME_RE.exec(report.eventTime) : null;
  const vendor = m ? new Date(`${m[1]}T${m[2]}Z`) : null; // zone not documented: read as UTC (ADR-0053 D7)
  return vendor && !Number.isNaN(vendor.getTime()) ? vendor : new Date(report.reportedAt);
}

/** Our payer when exactly one of the tenant's routes on this clearinghouse carries the reported payer id. */
async function payerFor(
  tx: DbClient,
  clearinghouseKey: string,
  payerId: string | null,
): Promise<string | null> {
  if (!payerId) return null;
  const res = (await tx.execute(sql`
    SELECT DISTINCT p.payer_id
    FROM commercial_payer_route r
    JOIN commercial_payer_plan p ON p.id = r.plan_id AND p.organization_id = r.organization_id
    WHERE r.clearinghouse_key = ${clearinghouseKey} AND r.clearinghouse_payer_id = ${payerId}
    LIMIT 2`)) as unknown as { rows: { payer_id: string }[] };
  return res.rows.length === 1 ? (res.rows[0]?.payer_id ?? null) : null;
}

/**
 * Record one report (the outbox consumer). Idempotent on (org, sourceEventKey). A newer report supersedes the open ones for the
 * same (provider entity, payer, enroll type); an older one arriving late is stored already superseded.
 */
export async function recordEnrollmentReport(
  db: DbClient,
  organizationId: string,
  report: ReportedEnrollment,
): Promise<"recorded" | "duplicate"> {
  return withOrgContext(db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as unknown as DbClient;
    const clearinghouseKey = report.vendor;
    const payerPart =
      report.clearinghousePayerId && PAYER_ID_RE.test(report.clearinghousePayerId)
        ? report.clearinghousePayerId
        : null;
    const payerId = await payerFor(tx, clearinghouseKey, payerPart);
    const reportedAt = reportedAtOf(report);
    // Serialize reports for the same anchor so two arrivals cannot both stay open.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`m41.enroll_report:${organizationId}:${report.providerEntityId}:${payerId ?? payerPart ?? "-"}:${report.enrollType}`}))`,
    );
    const sameAnchor = and(
      eq(R.organizationId, organizationId),
      eq(R.providerEntityId, report.providerEntityId),
      payerId === null ? sql`${R.payerId} IS NULL` : eq(R.payerId, payerId),
      payerId === null && payerPart !== null ? eq(R.clearinghousePayerId, payerPart) : sql`true`,
      eq(R.enrollType, report.enrollType),
    );
    const [newer] = await tx
      .select({ id: R.id })
      .from(R)
      .where(and(sameAnchor, sql`${R.reportedAt} > ${reportedAt}`, sql`${R.state} <> 'superseded'`))
      .limit(1);
    const inserted = await tx
      .insert(R)
      .values({
        organizationId,
        providerEntityId: report.providerEntityId,
        payerId,
        clearinghouseKey,
        clearinghousePayerId: payerPart,
        enrollType: report.enrollType,
        vendorStatus: report.vendorStatus,
        suggestedStatus: report.vendorStatus === ENROLLED_WORD ? ENROLLED_WORD : null,
        vendorEnrollId:
          report.vendorEnrollId && ENROLL_ID_RE.test(report.vendorEnrollId)
            ? report.vendorEnrollId
            : null,
        sourceEventKey: report.sourceEventKey,
        reportedAt,
        state: newer ? "superseded" : "open",
      })
      .onConflictDoNothing({ target: [R.organizationId, R.sourceEventKey] })
      .returning({ id: R.id });
    const id = inserted[0]?.id;
    if (!id) return "duplicate";
    if (!newer) {
      await tx
        .update(R)
        .set({ state: "superseded", updatedAt: new Date() })
        .where(and(sameAnchor, eq(R.state, "open"), sql`${R.id} <> ${id}`));
    }
    return "recorded";
  });
}

export interface EnrollmentReportService {
  list(
    scope: { organizationId: string; userId: string },
    filter: { providerEntityId: string; state?: CommercialEnrollmentReportState; limit: number },
  ): Promise<EnrollmentReportView[]>;
  resolve(
    scope: { organizationId: string; userId: string },
    input: { providerEntityId: string; id: string; resolution: "applied" | "dismissed" },
  ): Promise<EnrollmentReportView>;
}

export function buildEnrollmentReportService(db: DbClient): EnrollmentReportService {
  const inOrg = <T>(
    scope: { organizationId: string; userId: string },
    fn: (tx: DbClient) => Promise<T>,
  ) => withOrgContext(db, scope, (tx) => fn(tx as unknown as DbClient));
  return {
    list: (scope, filter) =>
      inOrg(scope, async (tx) =>
        (
          await tx
            .select()
            .from(R)
            .where(
              and(
                eq(R.organizationId, scope.organizationId),
                eq(R.providerEntityId, filter.providerEntityId),
                filter.state ? eq(R.state, filter.state) : sql`true`,
              ),
            )
            .orderBy(desc(R.reportedAt))
            .limit(filter.limit)
        ).map(viewOf),
      ),

    // Idempotent: resolving again the same way answers the row as it is; the other way, or a superseded report, is a 409.
    resolve: (scope, input) =>
      inOrg(scope, async (tx) => {
        const [row] = await tx
          .select()
          .from(R)
          .where(
            and(
              eq(R.id, input.id),
              eq(R.organizationId, scope.organizationId),
              eq(R.providerEntityId, input.providerEntityId),
            ),
          )
          .limit(1)
          .for("update");
        if (!row) throw new NotFoundError("enrollment report", input.id);
        if (row.state === input.resolution) return viewOf(row);
        if (row.state !== "open") {
          throw new ConflictError(`the enrollment report is already ${row.state}`);
        }
        const now = new Date();
        const [updated] = await tx
          .update(R)
          .set({
            state: input.resolution,
            resolvedAt: now,
            resolvedByUserId: scope.userId,
            updatedAt: now,
          })
          .where(eq(R.id, row.id))
          .returning();
        return viewOf(updated as Row);
      }),
  };
}
