// WP 2.7b C4 (ADR-0058 decisions 1-4) - the tenant's global search switch: read it (with the go-live checklist and the
// rebuild progress) and flip it.
//
//  * ON needs the whole checklist (prerequisites.ts); otherwise 409 `GLOBAL_SEARCH_PREREQUISITES_UNMET` naming each failing
//    check. OFF is always accepted and requests the purge (C2's sweep deletes the rows).
//  * The flip takes the setting row FOR UPDATE: the index writer holds it FOR SHARE for an insert and the purge holds it FOR
//    UPDATE, so an OFF->ON cannot interleave with either. No row yet means nothing to lock and nothing writing.
//  * ON also needs the current discoverability notice acknowledged (F5, notice.ts): 409 GLOBAL_SEARCH_NOTICE_NOT_ACKNOWLEDGED
//    (NOTICE_ACK_REQUIRED / NOTICE_ACK_STALE), checked before anything is read; the actor, time and version are stored.
//  * EVERY enabled flip sets `changed_at = now()` (C2's reconcile treats a `ready` index as trustworthy only while
//    `reconciled_at >= changed_at`) and `changed_by_user_id`. A repeat of the current value is not a flip: it writes nothing,
//    except that OFF always (re)requests the purge and ON records a newly acknowledged notice version. Audit is the write-audit trigger on the table (who/when/old/new).
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { WardenXError } from "@wardenx/types";
import { sql } from "drizzle-orm";
import { CURRENT_NOTICE, type GlobalSearchNotice } from "./notice";
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
  /** F5: the notice the enable PUT must acknowledge (`acknowledgedNoticeVersion` = `notice.version`). */
  readonly notice: GlobalSearchNotice;
  /** F5: who acknowledged which notice version when the tenant was last switched ON; null before the first ON. */
  readonly noticeAcknowledgement: {
    readonly version: string;
    readonly byUserId: string;
    readonly at: string;
  } | null;
}

export interface GlobalSearchSettingsService {
  get(organizationId: string): Promise<GlobalSearchSettingsView>;
  set(
    actor: { readonly organizationId: string; readonly userId: string },
    enabled: boolean,
    acknowledgedNoticeVersion?: string,
  ): Promise<GlobalSearchSettingsView>;
}

const CHECK_MESSAGES: Record<ChecklistFailureCode, string> = {
  PLATFORM_FLAG_OFF: "The platform has not enabled global search (leakage review not attested).",
  LEGACY_BODIES_PRESENT:
    "Some message bodies are still on the legacy envelope (key-ring migration incomplete).",
  ESCROW_NOT_ATTESTED: "The key escrow and restore drill are not on record.",
  LEAKAGE_NOT_ATTESTED: "The measured leakage experiment and its sign-off are not on record.",
  RATE_LIMIT_INACTIVE: "The per-route search rate limit is not active.",
  EXCLUDED_MEMBERS_PRESENT:
    "Some channels still have members holding a patient-family, external-auditor or platform-staff role; remove them first.",
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

/** F5: switching ON without acknowledging the CURRENT notice version. 409 so the UI re-reads the GET and shows the new text. */
export class NoticeNotAcknowledgedError extends WardenXError {
  constructor(code: "NOTICE_ACK_REQUIRED" | "NOTICE_ACK_STALE") {
    super(
      "GLOBAL_SEARCH_NOTICE_NOT_ACKNOWLEDGED",
      "Global search cannot be switched on until the current discoverability notice is acknowledged.",
      HTTP_CONFLICT,
      [
        {
          field: "acknowledgedNoticeVersion",
          code,
          message:
            code === "NOTICE_ACK_REQUIRED"
              ? "Send acknowledgedNoticeVersion with the notice version returned by GET."
              : `The notice changed; acknowledge version ${CURRENT_NOTICE.version}.`,
        },
      ],
    );
    this.name = "NoticeNotAcknowledgedError";
  }
}

function assertNoticeAcknowledged(version: string | undefined): void {
  if (version === undefined || version === "")
    throw new NoticeNotAcknowledgedError("NOTICE_ACK_REQUIRED");
  if (version !== CURRENT_NOTICE.version) throw new NoticeNotAcknowledgedError("NOTICE_ACK_STALE");
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
    notice: CURRENT_NOTICE,
    noticeAcknowledgement:
      setting.noticeAckVersion && setting.noticeAckByUserId && setting.noticeAckAt
        ? {
            version: setting.noticeAckVersion,
            byUserId: setting.noticeAckByUserId,
            at: new Date(setting.noticeAckAt).toISOString(),
          }
        : null,
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
        const excluded = await prerequisites.excludedMembersRemain(tx, organizationId);
        const rebuild = await readRebuildProgress(
          tx,
          organizationId,
          setting,
          attestations.platformUpdatedAt,
        );
        return toView(setting, toChecklist(attestations, legacy, excluded), rebuild);
      });
    },

    async set({ organizationId, userId }, enabled, acknowledgedNoticeVersion) {
      if (enabled) assertNoticeAcknowledged(acknowledgedNoticeVersion);
      const attestations = await prerequisites.readAttestations(organizationId);
      return withOrgContext(db, { organizationId, userId }, async (tx) => {
        const current = await readTenantSearchSettingInTx(tx, organizationId, { lock: "update" });
        const legacy = await prerequisites.legacyBodiesRemain(tx, organizationId);
        const excluded = await prerequisites.excludedMembersRemain(tx, organizationId);
        const checklist = toChecklist(attestations, legacy, excluded);
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
          // Not a flip (nothing else changes), but a newer notice version acknowledged here must still be recorded (L4).
          if (current.noticeAckVersion !== acknowledgedNoticeVersion) {
            await tx.execute(sql`
              UPDATE tenant_messaging_search_setting
                 SET notice_ack_version = ${acknowledgedNoticeVersion}, notice_ack_by_user_id = ${userId}::uuid, notice_ack_at = now()
               WHERE organization_id = ${organizationId}`);
          }
          const same = await readTenantSearchSettingInTx(tx, organizationId);
          const rebuild = await readRebuildProgress(
            tx,
            organizationId,
            same,
            attestations.platformUpdatedAt,
          );
          return toView(same, checklist, rebuild);
        }
        // OFF (re)requests the purge and re-opens `purge_completed_at` so the sweep runs; ON leaves the purge columns alone.
        // ON records the acknowledgement (F5); OFF leaves the last one in place.
        const ackVersion = enabled ? acknowledgedNoticeVersion : null;
        await tx.execute(sql`
          INSERT INTO tenant_messaging_search_setting
            (organization_id, enabled, changed_by_user_id, changed_at, purge_requested_at, purge_completed_at,
             notice_ack_version, notice_ack_by_user_id, notice_ack_at)
          VALUES (${organizationId}, ${enabled}, ${userId}, now(),
                  ${enabled ? null : sql`now()`}::timestamptz, NULL,
                  ${ackVersion}, ${ackVersion ? userId : null}::uuid, ${ackVersion ? sql`now()` : null}::timestamptz)
          ON CONFLICT (organization_id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            changed_by_user_id = EXCLUDED.changed_by_user_id,
            changed_at = CASE WHEN tenant_messaging_search_setting.enabled IS DISTINCT FROM EXCLUDED.enabled
                              THEN now() ELSE tenant_messaging_search_setting.changed_at END,
            purge_requested_at = CASE WHEN EXCLUDED.enabled
                                      THEN tenant_messaging_search_setting.purge_requested_at ELSE now() END,
            purge_completed_at = CASE WHEN EXCLUDED.enabled
                                      THEN tenant_messaging_search_setting.purge_completed_at ELSE NULL END,
            notice_ack_version = COALESCE(EXCLUDED.notice_ack_version, tenant_messaging_search_setting.notice_ack_version),
            notice_ack_by_user_id = CASE WHEN EXCLUDED.notice_ack_version IS NULL
                                         THEN tenant_messaging_search_setting.notice_ack_by_user_id
                                         ELSE EXCLUDED.notice_ack_by_user_id END,
            notice_ack_at = CASE WHEN EXCLUDED.notice_ack_version IS NULL
                                 THEN tenant_messaging_search_setting.notice_ack_at
                                 ELSE EXCLUDED.notice_ack_at END`);
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
