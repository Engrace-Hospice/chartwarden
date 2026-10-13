// WP 2.7b C4 (ADR-0058 "Enablement and kill switches" decision 3) - the go-live checklist behind turning a tenant's global
// search ON, as ONE port so the route never learns where each fact comes from.
//
//   (a) platform flag on        - ops attests the leakage review by turning `messaging.global_search_platform_enabled` on
//   (b) P1 done                 - no `message` / `message_revision` body on the legacy envelope (version byte 1), AND the key
//                                 escrow + restore drill on record (platform flag `messaging.global_search_escrow_attested`)
//   (c) P2 deployed             - the per-route rate limit is active (`rateLimitActive`, injected by the composition root)
//   (d) rebuild complete        - NOT checked here: a tenant must be ON for the rebuild to run at all, so it is enforced by the
//                                 query path (closed until the index is `ready`) and reported by GET as `rebuild`
//
// Both flags are read from the org-NULL platform row only (`readPlatformGlobalFlag`), never through `forOrg`: a tenant-scoped
// `feature_flag` row for either key can never satisfy a check. A read error THROWS (the route answers 5xx, never "ON").
import type { DbClient } from "@wardenx/db";
import { sql } from "drizzle-orm";
import { readPlatformGlobalFlag } from "../../../bootstrap/feature-flag-store";
import type { Tx } from "../messaging-write-core";
import { createPlatformSearchFlag } from "./platform-flag";

export const GLOBAL_SEARCH_ESCROW_FLAG_KEY = "messaging.global_search_escrow_attested";

/** The envelope version byte of the pre-key-ring (HKDF-from-one-KEK) body format; see `packages/messaging` body-crypto. */
const LEGACY_ENVELOPE_VERSION = 1;

export type ChecklistFailureCode =
  | "PLATFORM_FLAG_OFF"
  | "LEGACY_BODIES_PRESENT"
  | "ESCROW_NOT_ATTESTED"
  | "RATE_LIMIT_INACTIVE";

export interface GlobalSearchChecklist {
  readonly platformEnabled: boolean;
  readonly legacyBodiesMigrated: boolean;
  readonly escrowAttested: boolean;
  readonly rateLimitActive: boolean;
}

export interface GlobalSearchAttestations {
  readonly platformEnabled: boolean;
  readonly escrowAttested: boolean;
  readonly rateLimitActive: boolean;
}

export interface GlobalSearchPrerequisites {
  /** Facts that need no tenant lock (own connections: call BEFORE opening the flip transaction). */
  readAttestations(organizationId: string): Promise<GlobalSearchAttestations>;
  /** True while any `message` or `message_revision` body of the org is still on the legacy envelope. */
  legacyBodiesRemain(tx: Tx, organizationId: string): Promise<boolean>;
}

export function toChecklist(
  attestations: GlobalSearchAttestations,
  legacyBodiesRemain: boolean,
): GlobalSearchChecklist {
  return { ...attestations, legacyBodiesMigrated: !legacyBodiesRemain };
}

/** The failing checks, in a stable order; empty means the tenant may be switched ON. */
export function failedChecks(checklist: GlobalSearchChecklist): ChecklistFailureCode[] {
  const failed: ChecklistFailureCode[] = [];
  if (!checklist.platformEnabled) failed.push("PLATFORM_FLAG_OFF");
  if (!checklist.legacyBodiesMigrated) failed.push("LEGACY_BODIES_PRESENT");
  if (!checklist.escrowAttested) failed.push("ESCROW_NOT_ATTESTED");
  if (!checklist.rateLimitActive) failed.push("RATE_LIMIT_INACTIVE");
  return failed;
}

export interface PrerequisiteWiring {
  readonly db: DbClient;
  /** True only once the per-route Valkey rate limit (ADR-0058 P2) is deployed for the search routes. Default false. */
  readonly rateLimitActive?: boolean;
}

export function createGlobalSearchPrerequisites(
  wiring: PrerequisiteWiring,
): GlobalSearchPrerequisites {
  const platform = createPlatformSearchFlag(wiring.db);
  return {
    async readAttestations(organizationId) {
      const [platformFlag, escrowFlag] = await Promise.all([
        platform.read(organizationId),
        readPlatformGlobalFlag(wiring.db, organizationId, GLOBAL_SEARCH_ESCROW_FLAG_KEY),
      ]);
      return {
        platformEnabled: platformFlag.enabled,
        escrowAttested: escrowFlag.enabled,
        rateLimitActive: wiring.rateLimitActive === true,
      };
    },
    // ponytail: a full scan per org when everything is migrated (nothing indexes the version byte); this is an admin-only
    // screen and flip, so add a partial index only if a tenant's history makes it measurable.
    async legacyBodiesRemain(tx, organizationId) {
      const result = await tx.execute<{ legacy: boolean }>(sql`
        SELECT (
          EXISTS (SELECT 1 FROM message
                   WHERE organization_id = ${organizationId}
                     AND length(body_cipher) > 0 AND get_byte(body_cipher, 0) = ${LEGACY_ENVELOPE_VERSION})
          OR EXISTS (SELECT 1 FROM message_revision
                      WHERE organization_id = ${organizationId}
                        AND length(body_cipher) > 0 AND get_byte(body_cipher, 0) = ${LEGACY_ENVELOPE_VERSION})
        ) AS legacy`);
      return result.rows[0]?.legacy === true;
    },
  };
}
