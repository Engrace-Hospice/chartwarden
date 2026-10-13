// WP 2.7b C4 (ADR-0058 decisions 1-4) - the tenant's global search switch: read it (with the go-live checklist and the
// rebuild progress) and flip it.
//
//  * ON needs the whole checklist (prerequisites.ts); otherwise 409 `GLOBAL_SEARCH_PREREQUISITES_UNMET` naming each failing
//    check. OFF is always accepted and requests the purge (C2's sweep deletes the rows).
//  * The flip takes the setting row FOR UPDATE: the index writer holds it FOR SHARE for an insert and the purge holds it FOR
//    UPDATE, so an OFF->ON cannot interleave with either. No row yet means nothing to lock and nothing writing.
//  * EVERY enabled flip sets `changed_at = now()` (C2's reconcile treats a `ready` index as trustworthy only while
//    `reconciled_at >= changed_at`) and `changed_by_user_id`. A repeat of the current value is not a flip: it writes nothing,
//    except that OFF always (re)requests the purge. Audit is the write-audit trigger on the table (who/when/old/new).
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { WardenXError } from "@wardenx/types";
import { sql } from "drizzle-orm";
import {
  type ChecklistFailureCode,
  type GlobalSearchChecklist,
  type GlobalSearchPrerequisites,
  failedChecks,
  toChecklist,
} from "./prerequisites";
import { type TenantSearchSetting, readTenantSearchSettingInTx } from "./tenant-setting-store";

const HTTP_CONFLICT = 409;

export interface RebuildProgress {
  readonly keyVersion: string;
  readonly status: "building" | "ready" | "stale";
  readonly checkpointCreatedAt: string | null;
  readonly reconciledAt: string | null;
  /** When the tenant flag last flipped; a `ready` index is only trustworthy if reconciled at or after this. */
  readonly changedAt: string | null;
  /** `status === "ready"` AND reconciled at/after both the tenant flip and the platform flag's last change. */
  readonly effectiveReady: boolean;
}

export interface GlobalSearchSettingsView {
  readonly enabled: boolean;
  readonly changedAt: string | null;
  readonly purgeRequestedAt: string | null;
  readonly purgeCompletedAt: string | null;
  readonly checklist: GlobalSearchChecklist;
  readonly rebuild: RebuildProgress | null;
}

export interface GlobalSearchSettingsService {
  get(organizationId: string): Promise<GlobalSearchSettingsView>;
  set(
    actor: { readonly organizationId: string; readonly userId: string },
    enabled: boolean,
  ): Promise<GlobalSearchSettingsView>;
}

const CHECK_MESSAGES: Record<ChecklistFailureCode, string> = {
  PLATFORM_FLAG_OFF: "The platform has not enabled global search (leakage review not attested).",
  LEGACY_BODIES_PRESENT:
    "Some message bodies are still on the legacy envelope (key-ring migration incomplete).",
  ESCROW_NOT_ATTESTED: "The key escrow and restore drill are not on record.",
  RATE_LIMIT_INACTIVE: "The per-route search rate limit is not active.",
  PURGE_IN_PROGRESS:
    "The purge started by the last switch-off has not finished; wait for it to complete.",
};

export class PrerequisitesUnmetError extends WardenXError {
  constructor(codes: readonly ChecklistFailureCode[]) {
    super(
      "GLOBAL_SEARCH_PREREQUISITES_UNMET",
      "Global search cannot be switched on until the go-live checklist is satisfied.",
      HTTP_CONFLICT,
      codes.map((code) => ({ field: "enabled", code, message: CHECK_MESSAGES[code] })),
    );
    this.name = "PrerequisitesUnmetError";
  }
}

const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

async function readRebuildProgress(
  tx: Parameters<typeof readTenantSearchSettingInTx>[0],
  organizationId: string,
  setting: TenantSearchSetting,
  platformUpdatedAt: Date | null,
): Promise<RebuildProgress | null> {
  // The driver may hand timestamptz back as text, and a JS Date would truncate microseconds, so freshness is decided in SQL.
  const result = await tx.execute<{
    key_version: string;
    status: RebuildProgress["status"];
    checkpoint_created_at: Date | string | null;
    reconciled_at: Date | string | null;
    fresh: boolean;
  }>(sql`
    SELECT key_version, status, checkpoint_created_at, reconciled_at,
           (reconciled_at IS NOT NULL
            AND reconciled_at >= COALESCE((SELECT changed_at FROM tenant_messaging_search_setting
                                            WHERE organization_id = ${organizationId}), '-infinity'::timestamptz)
            AND reconciled_at >= COALESCE(${platformUpdatedAt?.toISOString() ?? null}::timestamptz, '-infinity'::timestamptz)
           ) AS fresh
      FROM message_search_index_state
     WHERE organization_id = ${organizationId}
     ORDER BY updated_at DESC LIMIT 1`);
  const row = result.rows[0];
  if (!row) return null;
  return {
    keyVersion: row.key_version,
    status: row.status,
    checkpointCreatedAt: iso(row.checkpoint_created_at),
    reconciledAt: iso(row.reconciled_at),
    changedAt: iso(setting.changedAt),
    effectiveReady: row.status === "ready" && row.fresh === true,
  };
}

function toView(
  setting: TenantSearchSetting,
  checklist: GlobalSearchChecklist,
  rebuild: RebuildProgress | null,
): GlobalSearchSettingsView {
  return {
    enabled: setting.enabled,
    changedAt: iso(setting.changedAt),
    purgeRequestedAt: iso(setting.purgeRequestedAt),
    purgeCompletedAt: iso(setting.purgeCompletedAt),
    checklist,
    rebuild,
  };
}

export function createGlobalSearchSettingsService(deps: {
  readonly db: DbClient;
  readonly prerequisites: GlobalSearchPrerequisites;
}): GlobalSearchSettingsService {
  const { db, prerequisites } = deps;

  return {
    async get(organizationId) {
      const attestations = await prerequisites.readAttestations(organizationId);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const setting = await readTenantSearchSettingInTx(tx, organizationId);
        const legacy = await prerequisites.legacyBodiesRemain(tx, organizationId);
        const rebuild = await readRebuildProgress(
          tx,
          organizationId,
          setting,
          attestations.platformUpdatedAt,
        );
        return toView(setting, toChecklist(attestations, legacy), rebuild);
      });
    },

    async set({ organizationId, userId }, enabled) {
      const attestations = await prerequisites.readAttestations(organizationId);
      return withOrgContext(db, { organizationId, userId }, async (tx) => {
        const current = await readTenantSearchSettingInTx(tx, organizationId, { lock: "update" });
        const legacy = await prerequisites.legacyBodiesRemain(tx, organizationId);
        const checklist = toChecklist(attestations, legacy);
        if (enabled && !current.enabled) {
          // The purge only runs while OFF and the serve gate refuses while it is pending, so ON now would stay stuck closed.
          const purgePending =
            current.purgeRequestedAt !== null && current.purgeCompletedAt === null;
          const failed: ChecklistFailureCode[] = [
            ...failedChecks(checklist),
            ...(purgePending ? (["PURGE_IN_PROGRESS"] as const) : []),
          ];
          if (failed.length > 0) throw new PrerequisitesUnmetError(failed);
        }
        if (enabled === current.enabled && enabled) {
          const rebuild = await readRebuildProgress(
            tx,
            organizationId,
            current,
            attestations.platformUpdatedAt,
          );
          return toView(current, checklist, rebuild);
        }
        // OFF (re)requests the purge and re-opens `purge_completed_at` so the sweep runs; ON leaves the purge columns alone.
        await tx.execute(sql`
          INSERT INTO tenant_messaging_search_setting
            (organization_id, enabled, changed_by_user_id, changed_at, purge_requested_at, purge_completed_at)
          VALUES (${organizationId}, ${enabled}, ${userId}, now(),
                  ${enabled ? null : sql`now()`}::timestamptz, NULL)
          ON CONFLICT (organization_id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            changed_by_user_id = EXCLUDED.changed_by_user_id,
            changed_at = CASE WHEN tenant_messaging_search_setting.enabled IS DISTINCT FROM EXCLUDED.enabled
                              THEN now() ELSE tenant_messaging_search_setting.changed_at END,
            purge_requested_at = CASE WHEN EXCLUDED.enabled
                                      THEN tenant_messaging_search_setting.purge_requested_at ELSE now() END,
            purge_completed_at = CASE WHEN EXCLUDED.enabled
                                      THEN tenant_messaging_search_setting.purge_completed_at ELSE NULL END`);
        const next = await readTenantSearchSettingInTx(tx, organizationId);
        const rebuild = await readRebuildProgress(
          tx,
          organizationId,
          next,
          attestations.platformUpdatedAt,
        );
        return toView(next, checklist, rebuild);
      });
    },
  };
}
