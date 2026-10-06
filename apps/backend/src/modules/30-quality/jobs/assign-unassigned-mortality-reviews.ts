// apps/backend/src/modules/30-quality/jobs/assign-unassigned-mortality-reviews.ts — M30 D9 backfill cron.
//
// Mortality reviews created before the Medical Director auto-assignment (or while no Medical Director was
// appointed) sit with `assigned_reviewer_membership_id IS NULL`; PATCH/complete are assignee-gated, so such a
// review is unworkable and there is deliberately no assign route. This nightly cron walks every ACTIVE org and
// assigns each open, unassigned review through the SAME resolver the death consumer uses
// (`buildMortalityReviewerResolver` -> `resolveMedicalDirectorForOrg`), so a Medical Director appointed LATER is
// picked up too.
//
// Properties: org-explicit (no ambient request context — a cron tick is not a request); RLS-scoped via
// `withOrgContext`; BOUNDED (at most `MORTALITY_BACKFILL_BATCH_SIZE` rows per org per tick, oldest death first —
// the rest drain on later ticks); IDEMPOTENT + OPTIMISTIC (`UPDATE ... WHERE assigned_reviewer_membership_id IS
// NULL`, so a human/consumer assignment racing the cron is never overwritten, and a re-run is a no-op); a
// per-org failure is logged and does not stop the other orgs.
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";

/** BullMQ queue name (no ':' — BullMQ reserves it in ids; hyphens are fine). */
export const M30_ASSIGN_UNASSIGNED_MORTALITY_QUEUE = "m30.assign-unassigned-mortality-reviews";

/** 05:00 UTC daily — after the 03:15 recompute and 04:00 risk-register crons, clear of the 09:00 SRA scan. */
export const M30_ASSIGN_UNASSIGNED_MORTALITY_SCHEDULE = "0 5 * * *";

/** Max reviews assigned per org per tick. */
export const MORTALITY_BACKFILL_BATCH_SIZE = 200;

/** The open statuses a review can still be worked in (`completed` is terminal and never re-assigned). */
const OPEN_STATUSES = ["pending", "in_progress", "overdue"] as const;

/** `withOrgContext` carries no acting human for a cron (the M4 audit trigger maps "" to NULL). */
const SYSTEM_USER_ID = "";

export interface AssignUnassignedMortalityDeps {
  readonly db: DbClient;
  readonly listActiveOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  /** The composition-root D9 resolver: Medical Director membership for (org, provider entity), or null. */
  readonly resolveMedicalDirectorForOrg: (
    organizationId: string,
    providerEntityId: string,
  ) => Promise<string | null>;
  readonly batchSize?: number;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

export interface AssignUnassignedMortalityResult {
  readonly orgsScanned: number;
  readonly assigned: number;
  /** Candidates left unassigned because no Medical Director resolved (retried next tick). */
  readonly unresolved: number;
  readonly failedOrgs: number;
}

interface Candidate {
  readonly id: string;
  readonly deathAt: string;
  readonly providerEntityId: string;
}

type Rows<T> = { rows?: T[] };

async function listCandidates(
  db: DbClient,
  organizationId: string,
  limit: number,
): Promise<readonly Candidate[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const res = await tx.execute(sql`
      SELECT id, death_at::text AS "deathAt", provider_entity_id AS "providerEntityId"
        FROM mortality_review
       WHERE organization_id = ${organizationId}::uuid
         AND assigned_reviewer_membership_id IS NULL
         AND status IN (${sql.join(
           OPEN_STATUSES.map((s) => sql`${s}::m30_mortality_review_status`),
           sql`, `,
         )})
       ORDER BY death_at, id
       LIMIT ${limit}`);
    const rows =
      (res as unknown as Rows<{ id: string; deathAt: string; providerEntityId: string }>).rows ??
      [];
    return rows.map((r) => ({
      id: r.id,
      deathAt: r.deathAt, // raw text: a Date round-trip truncates microseconds and the partition-key match would miss
      providerEntityId: r.providerEntityId,
    }));
  });
}

/** Optimistic assign; returns true only when THIS call set the reviewer. */
async function assignIfStillUnassigned(
  db: DbClient,
  organizationId: string,
  candidate: Candidate,
  reviewerMembershipId: string,
): Promise<boolean> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const res = await tx.execute(sql`
      UPDATE mortality_review
         SET assigned_reviewer_membership_id = ${reviewerMembershipId}::uuid,
             version = version + 1,
             updated_at = now()
       WHERE organization_id = ${organizationId}::uuid
         AND id = ${candidate.id}::uuid
         AND death_at = ${candidate.deathAt}::timestamptz
         AND assigned_reviewer_membership_id IS NULL
         AND status IN (${sql.join(
           OPEN_STATUSES.map((s) => sql`${s}::m30_mortality_review_status`),
           sql`, `,
         )})
      RETURNING id`);
    return ((res as unknown as Rows<{ id: string }>).rows ?? []).length === 1;
  });
}

async function backfillOrg(
  deps: AssignUnassignedMortalityDeps,
  organizationId: string,
): Promise<{ assigned: number; unresolved: number }> {
  const candidates = await listCandidates(
    deps.db,
    organizationId,
    deps.batchSize ?? MORTALITY_BACKFILL_BATCH_SIZE,
  );
  const reviewerByEntity = new Map<string, string | null>();
  let assigned = 0;
  let unresolved = 0;
  for (const candidate of candidates) {
    if (!reviewerByEntity.has(candidate.providerEntityId)) {
      reviewerByEntity.set(
        candidate.providerEntityId,
        await deps.resolveMedicalDirectorForOrg(organizationId, candidate.providerEntityId),
      );
    }
    const reviewer = reviewerByEntity.get(candidate.providerEntityId) ?? null;
    if (reviewer === null) {
      unresolved += 1;
      continue;
    }
    if (await assignIfStillUnassigned(deps.db, organizationId, candidate, reviewer)) assigned += 1;
  }
  return { assigned, unresolved };
}

/** One cron tick: backfill every active org; one org's failure never blocks the others. */
export async function assignUnassignedMortalityReviews(
  deps: AssignUnassignedMortalityDeps,
): Promise<AssignUnassignedMortalityResult> {
  const warn = deps.warn ?? ((message, context) => console.warn(message, context));
  const orgs = await deps.listActiveOrgs();
  let assigned = 0;
  let unresolved = 0;
  let failedOrgs = 0;
  for (const { organizationId } of orgs) {
    try {
      const r = await backfillOrg(deps, organizationId);
      assigned += r.assigned;
      unresolved += r.unresolved;
    } catch (err) {
      failedOrgs += 1;
      warn("m30.assign-unassigned-mortality-reviews: org backfill failed", {
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { orgsScanned: orgs.length, assigned, unresolved, failedOrgs };
}
