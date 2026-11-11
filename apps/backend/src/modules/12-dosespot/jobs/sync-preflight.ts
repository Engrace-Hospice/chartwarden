// apps/backend/src/modules/12-dosespot/jobs/sync-preflight.ts — the per-org question the `dosespot_sync_queue` drain asks BEFORE it claims a row:
// may this org's rows be sent to DoseSpot right now?
//
//   - a tenant WITH a registration row whose config is not live (draft, registered, verified-but-not-active, deactivated, rotating its key,
//     or its config could not be read): its rows are not claimed at all. They stay `pending`, untouched, and no sync failure is recorded
//     (ADR-0111 D6: "queued ones wait"). Claiming them only to put them back would write two audit rows per row on every tick.
//   - a tenant with NO registration row and no env binding keeps the old path: its rows are claimed and fail as "not enabled".
//     Leaving every such row pending forever would queue demographics of every patient of every tenant that does not use DoseSpot,
//     for the day it is switched on.
// Org-scoped read (`withOrgContext`, RLS): it names the registration's existence only, never a credential.
import { type DbClient, schema } from "@chartwarden/db";
import type { DoseSpotTenantConfigResolver } from "@chartwarden/dosespot";
import { CONSUMER_USER_ID } from "@chartwarden/shared/route-kit";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";

const R = schema.dosespotClinicRegistrations;

export interface SyncPreflightDeps {
  readonly db: DbClient;
  /** The same resolver the client reads. Absent = every org is drained (the previous behaviour; a test double). */
  readonly config?: Pick<DoseSpotTenantConfigResolver, "configFor">;
}

export type SyncPreflight =
  | { readonly drain: true; readonly orgHasRegistration: boolean }
  /** Not live (or unreadable) for a tenant that registered: its rows wait. `fault` is the resolver's error, when that is why. */
  | { readonly drain: false; readonly orgHasRegistration: true; readonly fault: unknown };

async function hasRegistrationRow(db: DbClient, organizationId: string): Promise<boolean> {
  return withOrgContext(db, { organizationId, userId: CONSUMER_USER_ID }, async (tx) => {
    const [row] = await (tx as DbClient)
      .select({ id: R.id })
      .from(R)
      .where(eq(R.organizationId, organizationId))
      .limit(1);
    return row !== undefined;
  });
}

export async function syncPreflight(
  deps: SyncPreflightDeps,
  organizationId: string,
): Promise<SyncPreflight> {
  const orgHasRegistration = await hasRegistrationRow(deps.db, organizationId);
  if (!deps.config || !orgHasRegistration) return { drain: true, orgHasRegistration };
  try {
    const live = await deps.config.configFor(organizationId, "operate");
    return live === null
      ? { drain: false, orgHasRegistration, fault: null }
      : { drain: true, orgHasRegistration };
  } catch (fault) {
    return { drain: false, orgHasRegistration, fault: fault ?? new Error("unknown") };
  }
}
