// apps/backend/src/modules/39-consent/jobs/housekeeping.ts — M39 §4.9 `m39.renewal_cycle_close` (nightly 3 AM) and
// `m39.draft_auto_expire` (daily 4 AM) cron bodies (GAP-171). Neither existed, so an open renewal cycle outlived
// the consent it was renewing (the renewal worklist grew forever with dead cycles) and abandoned drafts accumulated
// without bound.
//
// RELAY/CRON TICKS ARE NOT REQUESTS: org-explicit, one `withOrgContext` transaction per page (the `expiration.ts`
// precedent); the fan-out over orgs is the caller's audited active-org enumerator. Both are idempotent: a closed
// cycle is no longer `open`, a discarded draft no longer exists, so a second run finds nothing.
//
// RENEWAL-CYCLE CLOSE. An `open` cycle is closed when its SOURCE consent can no longer be renewed in place:
//   source `expired`    -> `closed_expired`            (the spec's case: expired without renewal)
//   source `revoked`    -> `closed_revoked`            (a revoked consent is not renewed; it is re-captured)
//   source `superseded` -> `closed_no_longer_applicable` (a newer record already replaced it)
// A cycle whose source is still `active` is left alone (including a lapsed-but-not-yet-flipped one: the hourly
// `consent_expiration` cron flips the source first, and this runs the next night).
//
// DRAFT AUTO-EXPIRE. Housekeeping TTL only (M39-F13): unsigned drafts older than 30 days are deleted through the
// migration-0472 SECURITY DEFINER function — `wardenx_app` has no DELETE on consent tables, and the function can
// only ever remove `status='draft' AND signed_at IS NULL` rows. Not a retention commitment (§2.2.1).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, asc, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { M39_CRON_BOUNDS } from "./index";

const CRC = schema.consentRenewalCycle;
const CR = schema.consentRecord;

/** Empty, not a UUID: reads back as SQL NULL, which the audit trigger's actor FK accepts (see `expiration.ts`). */
const M39_HOUSEKEEPING_USER_ID = "";

/** §4.9 / M39-F13: drafts older than this are discarded. */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type RenewalCycleCloseStatus =
  | "closed_expired"
  | "closed_revoked"
  | "closed_no_longer_applicable";

export interface RenewalCycleClosePlan {
  readonly status: RenewalCycleCloseStatus;
  readonly reason: string;
}

/** Pure: how an open cycle closes given its source consent's status; `null` leaves it open. */
export function planRenewalCycleClose(sourceStatus: string): RenewalCycleClosePlan | null {
  switch (sourceStatus) {
    case "expired":
      return { status: "closed_expired", reason: "source_expired_without_renewal" };
    case "revoked":
      return { status: "closed_revoked", reason: "source_revoked" };
    case "superseded":
      return { status: "closed_no_longer_applicable", reason: "source_superseded" };
    default:
      return null;
  }
}

/** Pure: the cutoff before which an unsigned draft is discarded. */
export const draftCutoff = (now: Date): Date => new Date(now.getTime() - DRAFT_TTL_MS);

export interface M39HousekeepingDeps {
  readonly db: DbClient;
  readonly now?: () => Date;
}

export interface HousekeepingActiveOrgPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

const CLOSABLE_SOURCE_STATUSES = ["expired", "revoked", "superseded"] as const;

/** Close up to one page of open cycles whose source is expired/revoked/superseded, for ONE org. */
async function closeOnePage(
  deps: M39HousekeepingDeps,
  organizationId: string,
  now: Date,
): Promise<number> {
  return withOrgContext(
    deps.db,
    { organizationId, userId: M39_HOUSEKEEPING_USER_ID },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const rows = await tx
        .select({ id: CRC.id, sourceStatus: CR.status })
        .from(CRC)
        .innerJoin(CR, eq(CR.id, CRC.sourceConsentRecordId))
        .where(
          and(
            eq(CRC.organizationId, organizationId),
            eq(CRC.status, "open"),
            inArray(CR.status, [...CLOSABLE_SOURCE_STATUSES]),
          ),
        )
        .orderBy(asc(CRC.cycleStartedAt), asc(CRC.id))
        .limit(M39_CRON_BOUNDS.pageSize)
        .for("update", { of: CRC, skipLocked: true });
      let closed = 0;
      for (const row of rows) {
        const plan = planRenewalCycleClose(row.sourceStatus);
        if (plan === null) continue;
        const [updated] = await tx
          .update(CRC)
          .set({ status: plan.status, closedAt: now, closedReason: plan.reason })
          .where(and(eq(CRC.id, row.id), eq(CRC.status, "open")))
          .returning({ id: CRC.id });
        if (updated) closed += 1;
      }
      return closed;
    },
  );
}

/** `m39.renewal_cycle_close` for ONE org: bounded pages. Returns how many cycles were closed. */
export async function runRenewalCycleCloseForOrg(
  deps: M39HousekeepingDeps,
  organizationId: string,
): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  let total = 0;
  for (let page = 0; page < M39_CRON_BOUNDS.maxPagesPerOrg; page += 1) {
    const n = await closeOnePage(deps, organizationId, now);
    total += n;
    if (n < M39_CRON_BOUNDS.pageSize) break;
  }
  return total;
}

/** Discard up to one page of expired unsigned drafts for ONE org through the 0472 function. */
async function discardOnePage(
  deps: M39HousekeepingDeps,
  organizationId: string,
  now: Date,
): Promise<number> {
  return withOrgContext(
    deps.db,
    { organizationId, userId: M39_HOUSEKEEPING_USER_ID },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const result = await tx.execute(
        sql`SELECT consent_record_id FROM consent_draft_discard_expired(${organizationId}::uuid, ${draftCutoff(now).toISOString()}::timestamptz, ${M39_CRON_BOUNDS.pageSize})`,
      );
      const rows = (result as unknown as { rows?: readonly unknown[] }).rows ?? [];
      return rows.length;
    },
  );
}

/** `m39.draft_auto_expire` for ONE org: bounded pages. Returns how many drafts were discarded. */
export async function runDraftAutoExpireForOrg(
  deps: M39HousekeepingDeps,
  organizationId: string,
): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  let total = 0;
  for (let page = 0; page < M39_CRON_BOUNDS.maxPagesPerOrg; page += 1) {
    const n = await discardOnePage(deps, organizationId, now);
    total += n;
    if (n < M39_CRON_BOUNDS.pageSize) break;
  }
  return total;
}

async function fanOut(
  orgs: HousekeepingActiveOrgPort,
  perOrg: (organizationId: string) => Promise<number>,
  label: string,
): Promise<number> {
  const list = await orgs.listActiveOrgs();
  let total = 0;
  const errors: unknown[] = [];
  for (const { organizationId } of list) {
    try {
      total += await perOrg(organizationId);
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    // Surface (BullMQ retries / DLQ alert) AFTER every org was attempted — never silently swallowed.
    throw new AggregateError(errors, `M39 ${label} failed for ${errors.length} org(s)`);
  }
  return total;
}

export const runRenewalCycleCloseCron = (
  deps: M39HousekeepingDeps & { readonly activeOrgs: HousekeepingActiveOrgPort },
): Promise<number> =>
  fanOut(deps.activeOrgs, (org) => runRenewalCycleCloseForOrg(deps, org), "renewal-cycle-close");

export const runDraftAutoExpireCron = (
  deps: M39HousekeepingDeps & { readonly activeOrgs: HousekeepingActiveOrgPort },
): Promise<number> =>
  fanOut(deps.activeOrgs, (org) => runDraftAutoExpireForOrg(deps, org), "draft-auto-expire");
