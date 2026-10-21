// WP 2.7b C2 (ADR-0058 "Enablement and kill switches" decision 5) - the ops-owned platform kill switch
// `messaging.global_search_platform_enabled`, read ONLY from the platform-global feature_flag row (organization_id IS NULL).
//
// NEVER through `FeatureFlagReaderPort.forOrg`: that merges the org's own rows over the global one (a tenant row wins), so a
// tenant-scoped row written by a seed, a migration or plain SQL could turn search ON while ops had it OFF. The row read lives
// in bootstrap (`readPlatformGlobalFlag`: M36 may not touch the M1-owned `feature_flag` table, `arch:tables`); it selects the
// org-NULL row alone and resolves that single row through `resolveFeatureFlags`, so kill-switch/expiry semantics are those
// of every other flag. Absent row or false = OFF. A read error THROWS (the caller fails closed); never mapped to "off".
import type { DbClient } from "@chartwarden/db";
import { readPlatformGlobalFlag } from "../../../bootstrap/feature-flag-store";

export const GLOBAL_SEARCH_PLATFORM_FLAG_KEY = "messaging.global_search_platform_enabled";

export interface PlatformSearchFlagState {
  readonly enabled: boolean;
  /** `updated_at` of the platform row (null when absent): a later flip invalidates a prior reconciliation. */
  readonly updatedAt: Date | null;
}

export interface PlatformSearchFlag {
  read(organizationId: string): Promise<PlatformSearchFlagState>;
}

export function createPlatformSearchFlag(db: DbClient): PlatformSearchFlag {
  return {
    read: (organizationId) =>
      readPlatformGlobalFlag(db, organizationId, GLOBAL_SEARCH_PLATFORM_FLAG_KEY),
  };
}
