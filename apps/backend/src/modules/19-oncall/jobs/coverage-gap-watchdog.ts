// apps/backend/src/modules/19-oncall/jobs/coverage-gap-watchdog.ts — the §4.8 Tier-1
// `m19.coverage-gap-watchdog.cron` (GAP-057): every 30 minutes, walk the next 24 hours and, for every watched
// ProviderEntity with an uncovered `clinical_rn` stretch, publish `m19.oncall_shift.coverage_gap` — which M36
// turns into the system-locked `critical` `m19.oncall.coverage_gap_detected` page (`36-messaging/
// outbox-consumers/oncall-alerts.ts`). Until now the only producer was the REACTIVE D10 inbound-trigger arm
// (`consumers/bindings.ts`): a gap nobody phoned into was never found, and a CoP 418.100(c)(2) hole at 2 a.m.
// was discovered by the patient.
//
// WHICH PROVIDER ENTITIES. Active ProviderEntities (narrowed through M1's injected `FoundationSiteReader` —
// M19 reads no `provider_entity` row itself) that have a `tenant_oncall_policy` row with model `direct` or
// `hybrid`. The spec says "any active ProviderEntity"
// and is silent on the rest; the conservative reading (fewest false critical pages) is:
//   • no policy row  = after-hours on-call was never configured for that CCN, so a shift could not even open
//                      (D7 needs the policy) — there is no coverage promise to break;
//   • `centralized`  = the vendor covers the whole window with `external` shifts and the agency has no
//                      `clinical_rn` shift by design, so a perpetual gap would train the DON to ignore the
//                      alert that is locked precisely so it cannot be ignored.
//
// A STANDING GAP RE-FIRES EVERY TICK, DELIBERATELY (the M20 coverage-gap precedent): the event carries no
// idempotency key and an unfilled hole is still a hole; M36 collapses the pages to one per ProviderEntity per
// hour (correlation key on the event's hour), which is the "two check opportunities per hour" the spec wants
// without a page storm. One org's failure never stops the others.
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { ONCALL_COVERAGE_LOOKAHEAD_HOURS } from "@wardenx/types";
import type { IsoInstant } from "@wardenx/types";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import type { FoundationSiteReader } from "../../../bootstrap/foundation-site-reader";
import { firstRnCoverageGap } from "../roster/coverage-gap";
import type { WriteOutboxPort } from "../routes/write-service";
import { M19_SHIFT_CRON_USER_ID } from "./shift-cron";
import type { ActiveOrgListPort } from "./worker";

const SHIFT = schema.onCallShift;
const POLICY = schema.tenantOncallPolicy;

const MS_PER_HOUR = 3_600_000;

export interface M19CoverageGapDeps {
  readonly db: DbClient;
  readonly activeOrgs: ActiveOrgListPort;
  /** The real catalog-validating publisher (`callerModule` pinned to `m19`). */
  readonly outbox: WriteOutboxPort;
  /** M1's owner reader (`buildFoundationSiteReader()`), injected by the composition root. */
  readonly providerEntities: Pick<FoundationSiteReader, "activeProviderEntityIds">;
  now?: () => Date;
}

/** One org's pass inside ONE org-scoped transaction (read + publish commit together). Returns gaps found. */
async function checkOrg(
  deps: M19CoverageGapDeps,
  organizationId: string,
  now: Date,
): Promise<number> {
  const from = now.toISOString() as IsoInstant;
  const to = new Date(now.getTime() + ONCALL_COVERAGE_LOOKAHEAD_HOURS * MS_PER_HOUR);
  const toIso = to.toISOString() as IsoInstant;

  return withOrgContext(
    deps.db,
    { organizationId, userId: M19_SHIFT_CRON_USER_ID },
    async (handle) => {
      const tx = handle as DbClient;
      const policies = await tx
        .select({ providerEntityId: POLICY.providerEntityId })
        .from(POLICY)
        .where(
          and(
            eq(POLICY.organizationId, organizationId),
            inArray(POLICY.model, ["direct", "hybrid"]),
          ),
        );
      const watched = (
        await deps.providerEntities.activeProviderEntityIds(
          tx,
          policies.map((p) => p.providerEntityId),
        )
      ).map((id) => ({ id }));
      if (watched.length === 0) return 0;

      const shifts = await tx
        .select({
          providerEntityId: SHIFT.providerEntityId,
          shiftStartsAt: SHIFT.shiftStartsAt,
          shiftEndsAt: SHIFT.shiftEndsAt,
        })
        .from(SHIFT)
        .where(
          and(
            eq(SHIFT.organizationId, organizationId),
            eq(SHIFT.discipline, "clinical_rn"),
            inArray(SHIFT.status, ["scheduled", "active"]),
            lt(SHIFT.shiftStartsAt, to),
            gt(SHIFT.shiftEndsAt, now),
          ),
        );

      let gaps = 0;
      for (const { id: providerEntityId } of watched) {
        const windows = shifts
          .filter((s) => s.providerEntityId === providerEntityId)
          .map((s) => ({
            shiftStartsAt: s.shiftStartsAt.toISOString() as IsoInstant,
            shiftEndsAt: s.shiftEndsAt.toISOString() as IsoInstant,
          }));
        const gap = firstRnCoverageGap(windows, from, toIso);
        if (!gap) continue;
        gaps++;
        await deps.outbox.publish(tx, {
          eventName: "m19.oncall_shift.coverage_gap",
          organizationId,
          aggregateKind: "on_call_shift",
          // No shift exists — that IS the finding; the ProviderEntity is what the gap is about.
          aggregateId: providerEntityId,
          payload: {
            organizationId,
            providerEntityId,
            gapStartsAt: gap.gapStartsAt,
            gapEndsAt: gap.gapEndsAt,
            discipline: "clinical_rn",
          },
        });
      }
      return gaps;
    },
  );
}

/** §4.8 `m19.coverage-gap-watchdog.cron` — every active org; returns gaps published per org. */
export async function runCoverageGapWatchdogTick(
  deps: M19CoverageGapDeps,
): Promise<ReadonlyMap<string, number>> {
  const now = (deps.now ?? (() => new Date()))();
  const results = new Map<string, number>();
  const failures: unknown[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      results.set(organizationId, await checkOrg(deps, organizationId, now));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `M19_COVERAGE_GAP_WATCHDOG: ${failures.length} org failure(s)`,
    );
  }
  return results;
}
