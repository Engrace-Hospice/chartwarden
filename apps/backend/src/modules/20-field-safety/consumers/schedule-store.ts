// apps/backend/src/modules/20-field-safety/consumers/schedule-store.ts — the WRITE half of M20-T04's
// visit bindings (§2.2.1, §7.1, D2).
//
// `./schedule-plan` defines a {@link SafetyScheduleMutation} as "one targeted write on a
// `safety_check_in_schedule` row (or one new row)", and the four deciders beside it return lists of them.
// Nothing executed one. This file is that executor, and it is the reason `safety_check_in_schedule` now
// has a producer at all: before it, the table was read by the §4.2 supervisor board, the §4.3 badge trio,
// the §4.8 overdue detector and the clinician's own `/me/today`, and written by exactly one UPDATE — the
// fulfilment flip in `../routes/write-service-drizzle.ts`, which can only close a row somebody else made.
// No INSERT existed anywhere in the repository, so every one of those readers has always been reading an
// empty set (F-043 / #103).
//
// THE POLICY VERSION IS SEEDED HERE FOR THE SAME REASON THE WRITE SERVICE SEEDS IT. Every row carries
// `safety_policy_version_id NOT NULL` with a real FK, and `SafetyPolicyProvider` answers a tenant with no
// policy row using the platform FLOOR under an EMPTY `versionId` — deliberately, because inventing an id
// would let a write snapshot a version that does not exist (`../seams/providers.ts`). A consumer that
// took that DTO at face value would insert an empty uuid and die on the FK inside a retry loop. So the
// materializer resolves the version the way the write service does: read the tenant's current version,
// and if there is none, materialize the floor as a real row first (§3.2 Phase E). Safe because the floor
// is the STRICTEST configuration — an agency that has never opened the policy editor gets the tightest
// watch, not the loosest.
//
// THE SEED CARRIES NO `created_by_membership_id`, AND THAT IS THE POINT. Both columns are nullable and
// §3.3's attribution rule is explicit that a system transition records no membership. A visit publishing
// at 06:00 is not an act of whoever happens to be logged in, and naming one would put a clinician's id on
// a policy row she never opened.
//
// AN UNKNOWN MUTATION KIND THROWS. Same argument as the effects runner's rules 2 and 5
// (`../routes/effects-runner.ts`): a decider's mutation list type-checks against this file not at all, so
// a silently-skipped member would be an obligation that was decided and never written — discovered in
// production, on the surface whose whole job is to notice that nobody has heard from a clinician.
import { type DbClient, schema } from "@wardenx/db";
import type { IsoInstant, OrgId, SafetyPolicyVersionId, VisitId } from "@wardenx/types";
import { and, desc, eq, isNull } from "drizzle-orm";
import { safetyPolicyFloorSeed } from "../lifecycle/policy";
import type {
  SafetyScheduleMutation,
  SafetyScheduleRetireReason,
  SafetyScheduleRowFacts,
} from "./schedule-plan";

const SCHEDULE = schema.safetyCheckInSchedule;
const POLICY = schema.safetyPolicy;
const POLICY_VERSION = schema.safetyPolicyVersion;

/** Any Drizzle handle inside an open transaction. */
type Tx = DbClient;

/** What one `applyScheduleMutations` call wrote, per kind — the consumers' delivery-log line. */
export interface SafetyScheduleMutationCounts {
  readonly inserted: number;
  readonly reanchored: number;
  readonly repointed: number;
  readonly retired: number;
  readonly markedOverdue: number;
}

const NO_WRITES: SafetyScheduleMutationCounts = {
  inserted: 0,
  reanchored: 0,
  repointed: 0,
  retired: 0,
  markedOverdue: 0,
};

/** A decider's mutation named a kind this executor does not know how to write. */
export class UnknownSafetyScheduleMutationError extends Error {
  readonly code = "M20_UNKNOWN_SCHEDULE_MUTATION";
  constructor(kind: string) {
    super(
      `m20: a consumer decided a '${kind}' schedule mutation, which the schedule store cannot write`,
    );
    this.name = "UnknownSafetyScheduleMutationError";
  }
}

/**
 * The visit's current obligations, as the deciders' {@link SafetyScheduleRowFacts}.
 *
 * A DIFFERENT PROJECTION FROM `SafetySeamStore.scheduleFactsForVisit`, on purpose: that one feeds the
 * §4.3 badge trio and deliberately carries no row id and no clinician, because a consumer of the badge
 * has no business addressing a row. A decider must address rows — every mutation but `insert` names one —
 * so it needs the id and, for the reassignment rule, the name currently on it.
 */
export async function scheduleRowsForVisit(
  tx: Tx,
  organizationId: OrgId,
  visitId: VisitId,
): Promise<readonly SafetyScheduleRowFacts[]> {
  const rows = await tx
    .select({
      scheduleId: SCHEDULE.id,
      kind: SCHEDULE.kind,
      state: SCHEDULE.state,
      expectedAt: SCHEDULE.expectedAt,
      windowMinutes: SCHEDULE.windowMinutes,
      clinicianMembershipId: SCHEDULE.clinicianMembershipId,
    })
    .from(SCHEDULE)
    .where(and(eq(SCHEDULE.organizationId, organizationId), eq(SCHEDULE.visitId, visitId)))
    .orderBy(SCHEDULE.expectedAt);

  return rows.map((row) => ({
    scheduleId: row.scheduleId as SafetyScheduleRowFacts["scheduleId"],
    kind: row.kind as SafetyScheduleRowFacts["kind"],
    state: row.state as SafetyScheduleRowFacts["state"],
    expectedAt: row.expectedAt.toISOString() as IsoInstant,
    windowMinutes: row.windowMinutes,
    clinicianMembershipId:
      row.clinicianMembershipId as SafetyScheduleRowFacts["clinicianMembershipId"],
  }));
}

/**
 * The tenant's current `safety_policy_version.id`, seeding the §3.2 Phase E floor row when there is none.
 *
 * Returns the id rather than the DTO because that is the only part an obligation pins: the thresholds the
 * deciders compute with come from `SafetyPolicyProvider.effectivePolicy`, which merges the floor under
 * whatever the tenant has configured and needs no row to answer.
 */
export async function ensurePolicyVersionForConsumer(
  tx: Tx,
  organizationId: OrgId,
  at: Date,
): Promise<SafetyPolicyVersionId> {
  const [current] = await tx
    .select({ id: POLICY_VERSION.id })
    .from(POLICY_VERSION)
    .where(
      and(eq(POLICY_VERSION.organizationId, organizationId), isNull(POLICY_VERSION.effectiveTo)),
    )
    .orderBy(desc(POLICY_VERSION.effectiveFrom))
    .limit(1);
  if (current) return current.id as SafetyPolicyVersionId;

  const [existingPolicy] = await tx
    .select({ id: POLICY.id })
    .from(POLICY)
    .where(eq(POLICY.organizationId, organizationId))
    .limit(1);

  let policyId = existingPolicy?.id;
  if (policyId === undefined) {
    const [created] = await tx
      .insert(POLICY)
      // No `created_by_membership_id`: see the header — a system materialization names no actor.
      .values({ organizationId })
      .returning({ id: POLICY.id });
    policyId = (created as { id: string }).id;
  }

  const floor = safetyPolicyFloorSeed();
  const [seeded] = await tx
    .insert(POLICY_VERSION)
    .values({
      organizationId,
      safetyPolicyId: policyId,
      ...floor,
      oshaReportableAutoFlagCategories: floor.oshaReportableAutoFlagCategories as never,
      effectiveFrom: at,
      effectiveTo: null,
      editReason: null,
    })
    .returning({ id: POLICY_VERSION.id });
  const versionId = (seeded as { id: string }).id;
  await tx
    .update(POLICY)
    .set({ currentVersionId: versionId, updatedAt: at })
    .where(eq(POLICY.id, policyId));
  return versionId as SafetyPolicyVersionId;
}

/**
 * Execute a decision's mutation list inside the caller's transaction.
 *
 * EVERY WRITE IS SCOPED BY `organization_id` AS WELL AS BY ID. RLS already pins the tenant — the caller
 * opens `withOrgContext` — and the redundant predicate is the ADR-0010 D3 belt-and-braces the rest of this
 * module writes: a schedule id is an opaque uuid arriving from a decision made about an event payload, and
 * a write path that would address a row across tenants if the session variable were ever unset is one
 * deployment mistake away from doing so.
 *
 * `insert` is `ON CONFLICT DO NOTHING`, which is what makes redelivery a no-op rather than a driver-level
 * unique violation inside a worker retry loop: `scis_visit_kind_expected_uniq` is
 * `(visit_id, kind, expected_at)`, and `planVisitCadence` is already idempotent against the rows it can
 * SEE — this covers the race where two deliveries of one publication interleave between the read and the
 * write.
 */
export async function applyScheduleMutations(
  tx: Tx,
  organizationId: OrgId,
  mutations: readonly SafetyScheduleMutation[],
  at: Date,
): Promise<SafetyScheduleMutationCounts> {
  if (mutations.length === 0) return NO_WRITES;
  const counts: { -readonly [K in keyof SafetyScheduleMutationCounts]: number } = { ...NO_WRITES };
  const bump = (key: keyof SafetyScheduleMutationCounts, by: number): void => {
    counts[key] += by;
  };
  const byId = (scheduleId: string) =>
    and(eq(SCHEDULE.id, scheduleId), eq(SCHEDULE.organizationId, organizationId));

  for (const mutation of mutations) {
    switch (mutation.kind) {
      case "insert": {
        const written = await tx
          .insert(SCHEDULE)
          .values({
            organizationId: mutation.row.organizationId,
            providerEntityId: mutation.row.providerEntityId,
            locationId: mutation.row.locationId,
            visitId: mutation.row.visitId,
            clinicianMembershipId: mutation.row.clinicianMembershipId,
            kind: mutation.row.kind as never,
            expectedAt: new Date(mutation.row.expectedAt),
            windowMinutes: mutation.row.windowMinutes,
            safetyPolicyVersionId: mutation.row.safetyPolicyVersionId,
          })
          .onConflictDoNothing()
          .returning({ id: SCHEDULE.id });
        bump("inserted", written.length);
        break;
      }

      case "reanchor": {
        const written = await tx
          .update(SCHEDULE)
          .set({
            expectedAt: new Date(mutation.expectedAt),
            windowMinutes: mutation.windowMinutes,
            updatedAt: at,
          })
          .where(byId(mutation.scheduleId))
          .returning({ id: SCHEDULE.id });
        bump("reanchored", written.length);
        break;
      }

      case "repoint": {
        const written = await tx
          .update(SCHEDULE)
          .set({ clinicianMembershipId: mutation.clinicianMembershipId, updatedAt: at })
          .where(byId(mutation.scheduleId))
          .returning({ id: SCHEDULE.id });
        bump("repointed", written.length);
        break;
      }

      case "retire": {
        // A DELETE, and `./schedule-plan` argues why: no member of `safety_check_in_state` can say "this
        // plan was invalidated" without lying, and the M4 write-audit trigger keeps the retirement — and
        // its reason, below — on the record.
        const written = await tx
          .delete(SCHEDULE)
          .where(byId(mutation.scheduleId))
          .returning({ id: SCHEDULE.id });
        bump("retired", written.length);
        break;
      }

      case "mark_overdue": {
        // `m20_scis_overdue_stamped` refuses `state='overdue'` without the instant, so the flip and the
        // stamp are one SET — the constraint is what makes "overdue since unknown" unrepresentable.
        const written = await tx
          .update(SCHEDULE)
          .set({
            state: "overdue" as never,
            overdueDetectedAt: new Date(mutation.overdueDetectedAt),
            updatedAt: at,
          })
          .where(byId(mutation.scheduleId))
          .returning({ id: SCHEDULE.id });
        bump("markedOverdue", written.length);
        break;
      }

      default:
        throw new UnknownSafetyScheduleMutationError(
          (mutation as { kind: string }).kind ?? "undefined",
        );
    }
  }
  return counts;
}

/** The retire reasons a consumer may record — re-exported so a caller need not reach into schedule-plan. */
export type { SafetyScheduleRetireReason };
