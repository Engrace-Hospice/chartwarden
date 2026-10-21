// apps/backend/src/modules/19-oncall/jobs/reconcile.ts — the §4.5 path 1 org-wide reconciliation the
// `on_call_roster_sync_queue` drain worker (and, indirectly, the catch-up seeder) run per claimed row
// (m19 `handlers-unbound` group, #248; F-155's own finding, now built).
//
// THE PROVIDERENTITY ENUMERATOR IS `tenant_oncall_policy`, READ DIRECTLY — no seam, no cross-module read.
// `tenant_oncall_policy` is M19's OWN table (§3.3), one row per (org, ProviderEntity) — `policiesForOrg`
// below is the "which PEs does this org's roster sync cover" read the group's own standing reason named
// as missing, and it is simply "every PE with a policy row", the same relationship `createShift`'s D7
// guard already reads one row at a time.
//
// ONE M17 SEAM READ PER ORG, MANY PE-SCOPED DIFFS. `VisitAssignmentReader.tonightsOnCallRoster` is
// org-keyed (`shift-sync.ts`'s file-header point 1), so this reads it ONCE per reconciliation pass and
// reuses the same `OnCallRosterRead` for every ProviderEntity's `reconcileOnCallRoster` call — never a
// per-PE re-read of an org-wide fact.
//
// THE ROSTER READER IS AN INJECTED PORT, DEFAULTING TO THE REAL `readOnCallRoster`
// (`../consumers/trigger-context`) — not hardwired — for exactly one reason: M17's OWN
// `VisitAssignmentReader.tonightsOnCallRoster` now reads M17's own `oncall_rotation_entry` table
// (GAP-029). A tenant that has never entered a rotation row still resolves `readOnCallRoster` →
// `{kind: "unavailable"}` (`SchedulingOnCallRosterUnavailableError` — unreadable, deliberately NOT empty), and
// §2.7 class D-C is what the pure `reconcileOnCallRoster` planner does with that: an empty plan, existing
// `on_call_shift` rows preserved untouched, `degraded: true` reported — so a tenant that schedules shifts by
// hand is never silently emptied. The port stays injectable so the debounce/claim/apply machinery can be
// proven with a roster of the test's choosing.
import { type DbClient, schema } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import type { IsoInstant, OncallModel, OrgId } from "@chartwarden/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { readOnCallRoster } from "../consumers/trigger-context";
import type {
  ExistingOnCallShift,
  OnCallRosterRead,
  OnCallRosterSyncPlan,
} from "../roster/shift-sync";
import { reconcileOnCallRoster } from "../roster/shift-sync";

const POLICY = schema.tenantOncallPolicy;
const SHIFT = schema.onCallShift;

/** §3.3 — a machine-driven roster sync names no acting membership (the `m17-no-show`/`m36-delivery-failed`
 *  `CONSUMER_USER_ID` convention, restated locally per this directory's own files). */
const CONSUMER_USER_ID = "";

/** The port `reconcileOrgOnCallRoster` reads the roster through — defaults to the real
 *  `readOnCallRoster`. See the file header for why this stays injectable rather than a direct import. */
export type OrgRosterReadPort = (
  organizationId: OrgId,
  asOfIso: IsoInstant,
) => Promise<OnCallRosterRead>;

export interface ProviderEntityPolicyRow {
  readonly providerEntityId: string;
  readonly model: OncallModel;
  /** The whole `tenant_oncall_policy` row — pinned onto every `on_call_shift.policy_snapshot` this
   *  reconciliation creates, the same value `createShift`'s D7 guard pins (`write-service-drizzle.ts`). */
  readonly policySnapshot: unknown;
}

/** Every ProviderEntity this org's roster sync covers — one row per `tenant_oncall_policy` entry. Must
 *  run inside the caller's `withOrgContext` transaction. */
async function policiesForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<readonly ProviderEntityPolicyRow[]> {
  const rows = await tx.select().from(POLICY).where(eq(POLICY.organizationId, organizationId));
  return rows.map((row) => ({
    providerEntityId: row.providerEntityId,
    model: row.model as OncallModel,
    policySnapshot: row,
  }));
}

/** Every `scheduled`/`active` `on_call_shift` row for one PE — the only statuses `reconcileOnCallRoster`
 *  ever diffs or needs to report as `preserved` (a `completed`/`cancelled` row is history the sync never
 *  rewrites, per `shift-sync.ts`'s own file-header point 3, so it is out of scope for this read). Must run
 *  inside the caller's `withOrgContext` transaction. */
async function existingShiftsForProviderEntity(
  tx: DbClient,
  organizationId: string,
  providerEntityId: string,
): Promise<readonly ExistingOnCallShift[]> {
  const rows = await tx
    .select({
      shiftId: SHIFT.id,
      providerEntityId: SHIFT.providerEntityId,
      version: SHIFT.version,
      discipline: SHIFT.discipline,
      status: SHIFT.status,
      shiftStartsAt: SHIFT.shiftStartsAt,
      shiftEndsAt: SHIFT.shiftEndsAt,
      primaryOnCallMembershipId: SHIFT.primaryOnCallMembershipId,
      externalActorId: SHIFT.externalActorId,
      openedAt: SHIFT.openedAt,
      closedAt: SHIFT.closedAt,
    })
    .from(SHIFT)
    .where(
      and(
        eq(SHIFT.organizationId, organizationId),
        eq(SHIFT.providerEntityId, providerEntityId),
        inArray(SHIFT.status, ["scheduled", "active"] as never),
      ),
    );
  return rows.map((r) => ({
    shiftId: r.shiftId as never,
    providerEntityId: r.providerEntityId as never,
    status: r.status as never,
    version: r.version,
    shiftStartsAt: r.shiftStartsAt.toISOString() as IsoInstant,
    shiftEndsAt: r.shiftEndsAt.toISOString() as IsoInstant,
    discipline: r.discipline as never,
    primaryOnCallMembershipId: r.primaryOnCallMembershipId as never,
    externalActorId: r.externalActorId as never,
    openedAt: r.openedAt ? (r.openedAt.toISOString() as IsoInstant) : null,
    closedAt: r.closedAt ? (r.closedAt.toISOString() as IsoInstant) : null,
  }));
}

/** Apply one PE's plan: insert every `creates` draft, cancel every `cancels` target. Both are
 *  re-derivable from current state (§2.6) — a re-run against an unchanged DB produces an empty plan, so
 *  neither write needs an `onConflict` guard of its own; `cancels`' own `WHERE status = 'scheduled'`
 *  conjunct is what keeps a lost race (the row already left `scheduled` some other way) a silent no-op
 *  rather than a stale-version throw, matching this plan's own "diff against a snapshot read in the same
 *  transaction" contract. */
async function applyPlan(
  tx: DbClient,
  organizationId: string,
  plan: OnCallRosterSyncPlan,
  at: Date,
): Promise<void> {
  for (const draft of plan.creates) {
    await tx.insert(SHIFT).values({
      organizationId,
      providerEntityId: draft.providerEntityId,
      shiftStartsAt: new Date(draft.shiftStartsAt),
      shiftEndsAt: new Date(draft.shiftEndsAt),
      discipline: draft.discipline,
      primaryOnCallMembershipId: draft.primaryOnCallMembershipId,
      backupMembershipId: null,
      externalActorId: null,
      externalActorLabel: null,
      // m17VisitAssignmentRef stays null — M17's roster entry carries no visit id (shift-sync.ts's own
      // `OnCallRosterEntry` shape is membership/discipline/window, never a visit), so there is nothing
      // honest to stamp there.
      policySnapshot: draft.policySnapshot,
      status: "scheduled",
      createdAt: at,
      updatedAt: at,
    });
  }
  for (const cancel of plan.cancels) {
    await tx
      .update(SHIFT)
      .set({
        status: "cancelled",
        cancellationReason: cancel.reason,
        version: sql`${SHIFT.version} + 1`,
        updatedAt: at,
      })
      .where(
        and(
          eq(SHIFT.id, cancel.shiftId),
          eq(SHIFT.organizationId, organizationId),
          eq(SHIFT.status, "scheduled"),
        ),
      );
  }
}

export interface OrgReconcileResult {
  readonly providerEntitiesReconciled: number;
  readonly created: number;
  readonly cancelled: number;
  /** True if ANY of the org's PE passes came back degraded (§2.7 D-C) — i.e. M17's roster read was
   *  unavailable. Since GAP-029 that is only a tenant with no `oncall_rotation_entry` rows. */
  readonly degraded: boolean;
}

/**
 * §4.5 path 1 — reconcile every ProviderEntity in one org against M17's on-call roster, in ONE
 * `withOrgContext` transaction: read the org's `tenant_oncall_policy` rows, read M17's roster once,
 * then per-PE read the existing `on_call_shift` rows, run the pure `reconcileOnCallRoster` planner, and
 * apply its plan. An org with no `tenant_oncall_policy` row anywhere is a clean no-op — there is nothing
 * to reconcile FOR, the same "no policy, no shift" precondition `createShift`'s D7 guard already enforces
 * one row at a time.
 */
export async function reconcileOrgOnCallRoster(
  db: DbClient,
  organizationId: string,
  asOfIso: IsoInstant,
  at: Date,
  rosterReader: OrgRosterReadPort = readOnCallRoster,
): Promise<OrgReconcileResult> {
  // `readOnCallRoster` → M17's `VisitAssignmentReader` seam may open its own `withOrgContextFromRequest`
  // (the `readTriggerVisit` precedent this file's header cites), which throws outside a request scope — a
  // relay/cron tick is not a request, so this establishes the scope the same way `consumers/bindings.ts`
  // and M20's `runSosSlaWatchdogCron`/`processOneAlert` pair do (`runWithRequestContext` wrapping
  // `withOrgContext`, both pinned to the same organizationId).
  return runWithRequestContext({ organizationId, userId: CONSUMER_USER_ID }, () =>
    withOrgContext(db, { organizationId, userId: CONSUMER_USER_ID }, async (handle) => {
      const tx = handle as DbClient;
      const policies = await policiesForOrg(tx, organizationId);
      if (policies.length === 0) {
        return { providerEntitiesReconciled: 0, created: 0, cancelled: 0, degraded: false };
      }

      const rosterRead = await rosterReader(organizationId as OrgId, asOfIso);

      let created = 0;
      let cancelled = 0;
      let degraded = false;
      for (const policy of policies) {
        const existingShifts = await existingShiftsForProviderEntity(
          tx,
          organizationId,
          policy.providerEntityId,
        );
        const plan = reconcileOnCallRoster({
          providerEntityId: policy.providerEntityId as never,
          model: policy.model,
          rosterRead,
          existingShifts,
          policySnapshot: policy.policySnapshot,
        });
        degraded = degraded || plan.degraded;
        await applyPlan(tx, organizationId, plan, at);
        created += plan.creates.length;
        cancelled += plan.cancels.length;
      }
      return { providerEntitiesReconciled: policies.length, created, cancelled, degraded };
    }),
  );
}
