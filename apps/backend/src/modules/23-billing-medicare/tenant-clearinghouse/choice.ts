// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/choice.ts — what an organization chose, and what the
// claims-billing gate makes of it (ADR-0053 amendment 2026-11-06; ADR-0108 repurposed).
//
//   TenantClearinghouseReader         the fact: the org's config row (or the platform-env fallback), read on the tenant pool
//                                     under the org's own RLS scope. No cache.
//   ClaimsBillingEntitlementReader    the decision the gate asks for: `stedi` / `claimmd` (or the fallback) in `active` status
//                                     may start new claims work; `outside`, nothing chosen, and a draft / verified config may not.
//                                     No fee, no add-on: only the choice.
// `CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS` names the organizations the platform's own env binding (CLEARINGHOUSE_VENDOR) keeps
// serving when they have no row (the demo tenant); every other org with no row has chosen nothing.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type ClaimsBillingEntitlement,
  type ClaimsBillingEntitlementReader,
  NO_CLEARINGHOUSE_CHOICE,
  type TenantClearinghouseChoice,
  type TenantClearinghouseMode,
  type TenantClearinghouseReader,
  type TenantClearinghouseStatus,
  type TenantClearinghouseVendor,
  transmitsThroughChartWarden,
} from "@chartwarden/types";
import { CLEARINGHOUSE_VENDOR_ENV, parseClearinghouseVendor } from "@chartwarden/x12-837-client";
import { eq } from "drizzle-orm";
import { clearinghouseUsageFromEnv } from "../jobs/clearinghouse-context";
import type { ConfigRow } from "./config-store";
import type { PlatformFallback } from "./service";

import { CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS_ENV } from "../../../bootstrap/env";

export { CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS_ENV };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FALLBACK_VENDORS: ReadonlySet<string> = new Set(["stedi", "claimmd", "direct_mac", "in_memory"]);

/** The organizations named in `CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS` (comma-separated uuids). A malformed id refuses boot. */
export function parseFallbackOrgIds(raw: string | undefined): ReadonlySet<string> {
  const ids = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const id of ids) {
    if (!UUID.test(id)) {
      throw new Error(`${CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS_ENV} must be a comma-separated list of organization uuids`);
    }
  }
  return new Set(ids.map((id) => id.toLowerCase()));
}

/**
 * The fallback lookup: an org named in the list is served by the platform's env binding (its vendor and the env usage), or
 * null. Naming orgs while no env vendor is bound is a deployment mistake that refuses boot (it would silently serve nothing).
 */
export function platformFallbackLookup(
  orgIds: ReadonlySet<string>,
  envVendor: string | null,
  envUsage: TenantClearinghouseMode,
): (organizationId: string) => PlatformFallback | null {
  if (orgIds.size > 0 && (envVendor === null || !FALLBACK_VENDORS.has(envVendor))) {
    throw new Error(
      `${CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS_ENV} names organizations but CLEARINGHOUSE_VENDOR is not bound to a vendor`,
    );
  }
  return (organizationId) =>
    envVendor !== null && orgIds.has(organizationId.toLowerCase())
      ? { vendor: envVendor as PlatformFallback["vendor"], mode: envUsage }
      : null;
}

type EnvMap = Readonly<Record<string, string | undefined>>;

/** The organizations the platform env binding serves and the lookup over them, from the process environment (one definition for boot, the seams and the resolver). */
export function platformFallbackFromEnv(env: EnvMap): {
  readonly orgIds: ReadonlySet<string>;
  readonly lookup: (organizationId: string) => PlatformFallback | null;
} {
  const orgIds = parseFallbackOrgIds(env[CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS_ENV]);
  const vendor = parseClearinghouseVendor(env[CLEARINGHOUSE_VENDOR_ENV], env.NODE_ENV === "production");
  return { orgIds, lookup: platformFallbackLookup(orgIds, vendor, clearinghouseUsageFromEnv(env)) };
}

/** The choice of an org from its row (or the fallback when it has none). */
export function choiceOf(
  row: ConfigRow | null,
  fallback: PlatformFallback | null,
): TenantClearinghouseChoice {
  if (row) {
    return {
      vendor: row.vendor as TenantClearinghouseVendor,
      status: row.status as TenantClearinghouseStatus,
      mode: row.mode as TenantClearinghouseMode | null,
      source: "tenant",
    };
  }
  if (fallback) {
    return { vendor: fallback.vendor, status: "active", mode: fallback.mode, source: "platform_env" };
  }
  return NO_CLEARINGHOUSE_CHOICE;
}

/** The gate's decision from a choice: pure. */
export function decideClaimsBilling(choice: TenantClearinghouseChoice): ClaimsBillingEntitlement {
  if (transmitsThroughChartWarden(choice)) return { entitled: true };
  if (choice.vendor === null) return { entitled: false, reason: "clearinghouse_not_chosen" };
  if (choice.vendor === "outside") return { entitled: false, reason: "clearinghouse_outside" };
  return { entitled: false, reason: "clearinghouse_not_active" };
}

export function createTenantClearinghouseReader(deps: {
  readonly db: DbClient;
  readonly platformFallback: (organizationId: string) => PlatformFallback | null;
}): TenantClearinghouseReader {
  const C = schema.tenantClearinghouseConfig;
  return {
    async choiceForOrg(organizationId) {
      const row = await withOrgContext(deps.db, { organizationId, userId: "" }, async (tx) => {
        const [found] = await (tx as unknown as DbClient)
          .select()
          .from(C)
          .where(eq(C.organizationId, organizationId))
          .limit(1);
        return found ?? null;
      });
      return choiceOf(row, deps.platformFallback(organizationId));
    },
  };
}

/** The gate's seam (`ClaimsBillingEntitlementReader`) over the choice reader. A failed read throws; new-work callers fail closed. */
export function createClaimsBillingEntitlementReader(
  reader: TenantClearinghouseReader,
): ClaimsBillingEntitlementReader {
  return {
    async entitlementForOrg(organizationId) {
      return decideClaimsBilling(await reader.choiceForOrg(organizationId));
    },
  };
}
