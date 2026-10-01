// apps/backend/src/modules/31-portal/jobs/post-discharge-grace-sweep.ts — M31 §4.8 `m31.post-discharge-grace.cron`
// / §7.6 (F-222, #248): the daily sweep that ENDS portal access for patients discharged alive whose grace
// window has elapsed. Replaces the never-built `m6.admission.discharged` (`reason!='death'`) push consumer
// (see `./queues.ts` for the sweep-vs-delayed-job decision).
//
// HOW IT DECIDES (no per-event state, nothing to cancel):
//   1. page through the org's ACTIVE care-time grants' distinct patient ids (M31-owned `portal_access_grant`,
//      keyset on patient_id; `bereaved_family` grants are NEVER touched — their end is M16's
//      `plan_closed_completed` / the 13-month window, not discharge);
//   2. ask M6 (org-explicit published read `portalDischargedPastGraceForOrg`, injected as a port — M31 takes
//      no M6 import) which of those patients have a latest completed NON-death discharge strictly older than
//      `today - graceDays` and NO open admission. A re-admitted patient is simply not returned;
//   3. revoke those patients' active care-time grants (`revoke_cascade_source='admission_discharged'`),
//      guarded by `revoked_at IS NULL` so a rerun (or an overlap with the m39/M16 cascades) matches nothing.
//
// GRACE FLOOR: `effectiveGraceDays` = max(30, tenant-configured). No tenant-config store for this knob exists
// yet, so the optional `graceDaysForOrg` port defaults to "none" => exactly the 30-day floor; a configured
// value BELOW the floor is ignored (clamped UP), never honoured.
//
// BOUNDED: at most `maxRevocationsPerOrgPerRun` PATIENTS are revoked per org per tick and at most
// `maxScanPerOrgPerRun` scanned. A first run on a deployment with a large discharged backlog therefore drains
// over following daily ticks (capped, oldest patient-id first) instead of mass-revoking in one pass; every
// capped tick reports `capped: true`. Revocation is correct-by-spec for every candidate (each already had
// >= 30 full days), so draining slowly is a safety valve, not a correctness requirement.
//
// TENANCY: a cron tick is not a request — the org list comes from the platform enumerator, and every read/write
// opens its own `withOrgContext` with an explicit `organization_id` filter. One org's failure never blocks the
// orgs after it (collected and rethrown together at the end so the job still fails loudly).
//
// NOT DONE HERE (reported in F-222): the spec also wants an M36 one-time notification on entering the grace
// window, an M39 consent-expiry signal and an M30 metric on revocation — each needs a catalogued `m31.*` emit
// or a new seam, and M31 emits ZERO `m31.*` events today (F-160's reasoning stands). The M4 write-audit trigger
// on `portal_access_grant` records every revocation. The write-side read-only rule during the grace window is
// already enforced live (`PATIENT_DISCHARGED_READ_ONLY`).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  M31_GRACE_SWEEP_MAX_REVOCATIONS_PER_ORG_PER_RUN,
  M31_GRACE_SWEEP_MAX_SCAN_PER_ORG_PER_RUN,
  M31_GRACE_SWEEP_SCAN_PAGE_SIZE,
  M31_POST_DISCHARGE_GRACE_FLOOR_DAYS,
  M31_WORKER_SYSTEM_USER_ID,
} from "./queues";

const PAG = schema.portalAccessGrants;
const MS_PER_DAY = 86_400_000;

/** The active-org fan-out source (structural twin of every module's `ActiveOrgListPort`). */
export interface M31ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/** M6's org-explicit published read, injected at the composition root (M31 imports no M6 code). */
export interface M31DischargeGracePort {
  portalDischargedPastGraceForOrg(
    organizationId: string,
    patientIds: readonly string[],
    cutoffDate: string,
  ): Promise<
    ReadonlyMap<string, { readonly patientId: string; readonly dischargeEventId: string }>
  >;
}

export interface PostDischargeGraceSweepDeps {
  readonly db: DbClient;
  readonly activeOrgs: M31ActiveOrgListPort;
  readonly m6: M31DischargeGracePort;
  /** Tenant-configured grace days; `null`/absent => the floor. A value below the floor is clamped UP. */
  readonly graceDaysForOrg?: (organizationId: string) => Promise<number | null>;
  readonly maxRevocationsPerOrgPerRun?: number;
  readonly maxScanPerOrgPerRun?: number;
  readonly scanPageSize?: number;
  readonly now?: () => Date;
}

export interface PostDischargeGraceOrgResult {
  readonly organizationId: string;
  readonly graceDays: number;
  readonly cutoffDate: string;
  readonly scannedPatients: number;
  readonly revokedPatients: number;
  readonly revokedGrants: number;
  /** True when the per-run revocation budget stopped the org early (the rest drains next tick). */
  readonly capped: boolean;
}

/** max(floor, configured) — a tenant may lengthen the grace window, never shorten it below 30 days. */
export function effectiveGraceDays(configured: number | null | undefined): number {
  if (configured === null || configured === undefined || !Number.isFinite(configured)) {
    return M31_POST_DISCHARGE_GRACE_FLOOR_DAYS;
  }
  return Math.max(M31_POST_DISCHARGE_GRACE_FLOOR_DAYS, Math.floor(configured));
}

/**
 * The `YYYY-MM-DD` cutoff handed to M6: the UTC calendar day `graceDays` before `now`. M6 revokes only when
 * `effective_at < cutoff` (strict), so a patient discharged on day D keeps access THROUGH day D+graceDays.
 */
export function graceCutoffDate(now: Date, graceDays: number): string {
  const startOfUtcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(startOfUtcDay - graceDays * MS_PER_DAY).toISOString().slice(0, 10);
}

async function sweepOrg(
  deps: PostDischargeGraceSweepDeps,
  organizationId: string,
  now: Date,
): Promise<PostDischargeGraceOrgResult> {
  const graceDays = effectiveGraceDays(
    deps.graceDaysForOrg ? await deps.graceDaysForOrg(organizationId) : null,
  );
  const cutoffDate = graceCutoffDate(now, graceDays);
  const budget = deps.maxRevocationsPerOrgPerRun ?? M31_GRACE_SWEEP_MAX_REVOCATIONS_PER_ORG_PER_RUN;
  const scanCeiling = deps.maxScanPerOrgPerRun ?? M31_GRACE_SWEEP_MAX_SCAN_PER_ORG_PER_RUN;
  const pageSize = deps.scanPageSize ?? M31_GRACE_SWEEP_SCAN_PAGE_SIZE;

  let cursor: string | null = null;
  let scanned = 0;
  let revokedPatients = 0;
  let revokedGrants = 0;
  let capped = false;

  while (scanned < scanCeiling && !capped) {
    // (1) one keyset page of distinct patients holding an ACTIVE care-time grant.
    const page: string[] = await withOrgContext(
      deps.db,
      { organizationId, userId: M31_WORKER_SYSTEM_USER_ID },
      async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const rows = await tx
          .selectDistinct({ patientId: PAG.patientId })
          .from(PAG)
          .where(
            and(
              eq(PAG.organizationId, organizationId),
              isNull(PAG.revokedAt),
              ne(PAG.grantKind, "bereaved_family"),
              ...(cursor === null ? [] : [gt(PAG.patientId, cursor)]),
            ),
          )
          .orderBy(asc(PAG.patientId))
          .limit(pageSize);
        return rows.map((r) => r.patientId);
      },
    );
    if (page.length === 0) break;
    scanned += page.length;
    cursor = page[page.length - 1] ?? cursor;

    // (2) M6 answers which of them are discharged-alive past the cutoff and not re-admitted.
    const pastGrace = await deps.m6.portalDischargedPastGraceForOrg(
      organizationId,
      page,
      cutoffDate,
    );
    let toRevoke = page.filter((p) => pastGrace.has(p));
    const remaining = budget - revokedPatients;
    if (toRevoke.length > remaining) {
      toRevoke = toRevoke.slice(0, remaining);
      capped = true;
    }

    // (3) revoke — idempotent (`revoked_at IS NULL`), one tenant tx per page.
    if (toRevoke.length > 0) {
      const revoked = await withOrgContext(
        deps.db,
        { organizationId, userId: M31_WORKER_SYSTEM_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const at = now;
          const rows = await tx
            .update(PAG)
            .set({
              revokedAt: at,
              revokeCascadeSource: "admission_discharged",
              version: sql`${PAG.version} + 1`,
              updatedAt: at,
            })
            .where(
              and(
                eq(PAG.organizationId, organizationId),
                inArray(PAG.patientId, toRevoke),
                ne(PAG.grantKind, "bereaved_family"),
                isNull(PAG.revokedAt),
              ),
            )
            .returning({ id: PAG.id, patientId: PAG.patientId });
          return rows;
        },
      );
      revokedGrants += revoked.length;
      revokedPatients += new Set(revoked.map((r) => r.patientId)).size;
    }
    if (revokedPatients >= budget) {
      // Budget spent exactly: more candidates MAY remain, so report capped only if we have not seen the end.
      capped = capped || page.length === pageSize;
      break;
    }
    if (page.length < pageSize) break;
  }

  return {
    organizationId,
    graceDays,
    cutoffDate,
    scannedPatients: scanned,
    revokedPatients,
    revokedGrants,
    capped,
  };
}

/**
 * One sweep tick over every active org (driven directly by tests; the BullMQ Worker calls it). Returns the
 * per-org results. An org that throws is collected and the rest still run; the failures are rethrown together
 * at the end so the job fails loudly (DLQ/alerting) without denying later tenants their sweep.
 */
export async function runPostDischargeGraceSweepOnce(
  deps: PostDischargeGraceSweepDeps,
): Promise<readonly PostDischargeGraceOrgResult[]> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const results: PostDischargeGraceOrgResult[] = [];
  const failures: { organizationId: string; error: unknown }[] = [];
  for (const { organizationId } of orgs) {
    try {
      results.push(await sweepOrg(deps, organizationId, now));
    } catch (error) {
      failures.push({ organizationId, error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `M31_POST_DISCHARGE_GRACE_SWEEP: ${failures.length} of ${orgs.length} org(s) failed — ${failures
        .map((f) => f.organizationId)
        .join(", ")}`,
    );
  }
  return results;
}
