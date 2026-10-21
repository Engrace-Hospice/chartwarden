// apps/backend/src/modules/20-field-safety/jobs/coverage-gap-watchdog.ts — M20 §4.8
// `m20.coverage-gap-watchdog.cron` (GAP-061; §7.8, D8). Hourly: every active field-eligible clinician must
// have at least one reachable supervisor subscription; a clinician nobody would be paged for is reported as
// the system-locked critical `m20.safety.coverage_gap_detected`.
//
// THE DECISION IS ALREADY WRITTEN AND SHARED. `SafetySupervisorProvider.coverageGapsForOrg` (the §4.3 seam,
// `../seams/providers.ts`) runs `detectCoverageGaps` over the live roster, so the watchdog and the §4.2
// board can never disagree about who is uncovered. This file is only the schedule + the publish.
//
// A STANDING GAP RE-FIRES EVERY HOUR, DELIBERATELY. The event carries no idempotency key and a gap that
// persists is a gap that still has no one to page; an alert the DON dismissed at 09:00 must not mean the
// 22:00 SOS still fans out to nobody. The cost is one critical event per uncovered clinician per hour, which
// is the nag §7.8 asks for.
//
// A PROVIDER FAILURE IS A FAILED TICK, NEVER "NO GAPS". The seam throws when it cannot read; swallowing that
// into `[]` would report a healthy org precisely when the roster could not be read.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import type { IsoInstant, OrgId } from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";
import { createSafetySupervisorProvider } from "../seams/providers";
import { buildDrizzleSafetySeamStore } from "../seams/store-drizzle";
import {
  type M20WorkerDeps,
  M20_WORKER_SYSTEM_USER_ID,
  activeOrgsOf,
  logM20Cron,
} from "./worker-support";

const MEMBERSHIP = schema.memberships;

/** One org's pass. Returns how many gap events were published. */
async function runOrg(deps: M20WorkerDeps, organizationId: string, now: Date): Promise<number> {
  const atIso = now.toISOString() as IsoInstant;
  const supervisors = createSafetySupervisorProvider(buildDrizzleSafetySeamStore(deps.db));
  const gaps = await supervisors.coverageGapsForOrg(organizationId as OrgId, atIso);
  if (gaps.length === 0) return 0;

  await withOrgContext(
    deps.db,
    { organizationId, userId: M20_WORKER_SYSTEM_USER_ID },
    async (handle) => {
      const tx = handle as DbClient;
      const rows = await tx
        .select({ id: MEMBERSHIP.id, providerEntityId: MEMBERSHIP.defaultProviderEntityId })
        .from(MEMBERSHIP)
        .where(
          and(
            eq(MEMBERSHIP.organizationId, organizationId),
            inArray(
              MEMBERSHIP.id,
              gaps.map((g) => g.clinicianMembershipId as string),
            ),
          ),
        );
      const providerEntityOf = new Map(rows.map((r) => [r.id, r.providerEntityId]));
      for (const gap of gaps) {
        const providerEntityId = providerEntityOf.get(gap.clinicianMembershipId);
        // The roster only carries clinicians with a provider entity; one that vanished mid-pass has no
        // tenancy anchor to publish under, so it is logged and picked up by the next hourly tick.
        if (!providerEntityId) {
          logM20Cron("m20.coverage-gap-watchdog: gap subject has no provider entity, skipped", {
            organizationId,
            clinicianMembershipId: gap.clinicianMembershipId,
          });
          continue;
        }
        await deps.outbox.publish(tx, {
          eventName: "m20.safety.coverage_gap_detected",
          organizationId,
          aggregateKind: "safety_coverage_gap",
          aggregateId: gap.clinicianMembershipId,
          payload: {
            orgId: organizationId,
            providerEntityId,
            occurredAt: atIso,
            clinicianMembershipId: gap.clinicianMembershipId,
            reason: gap.reason,
            detectedAt: atIso,
          },
        });
      }
    },
  );
  return gaps.length;
}

/** §4.8 `m20.coverage-gap-watchdog.cron` — every active org, hourly. One org's failure does not skip the
 *  rest; failures are re-thrown at the end so the tick is recorded as failed. */
export async function runCoverageGapWatchdogCron(
  deps: M20WorkerDeps,
): Promise<{ readonly organizations: number; readonly gaps: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  let gaps = 0;
  const failures: unknown[] = [];
  for (const { organizationId } of orgs) {
    try {
      gaps += await runWithRequestContext(
        { organizationId, userId: M20_WORKER_SYSTEM_USER_ID },
        () => runOrg(deps, organizationId, now),
      );
    } catch (err) {
      failures.push(err);
      logM20Cron("m20.coverage-gap-watchdog: org failed", {
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `M20_COVERAGE_GAP_WATCHDOG_PARTIAL_FAILURE: ${failures.length} org(s) failed (first: ${
        failures[0] instanceof Error ? failures[0].message : String(failures[0])
      })`,
    );
  }
  return { organizations: orgs.length, gaps };
}
