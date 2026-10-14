// WP 2.7b C2 (ADR-0058 decision 1) - reads `tenant_messaging_search_setting` (M36-owned, org-scoped). No cache: a flip takes
// effect on the next call. A tenant with no row is OFF. The tx-scoped reader can lock the row: FOR SHARE for an index write
// (it blocks the admin's OFF update until it commits, so the purge starts after the last insert) and FOR UPDATE for the purge
// (taking SHARE and then upgrading would deadlock two replicas).
//
// C4 REQUIREMENT (tracked in docs/messaging-hub/03-phases-0-to-3.md under 2.7b): the settings route MUST set
// `changed_at = now()` on EVERY enabled flip (OFF->ON and ON->OFF). Reconcile treats a `ready` index as trustworthy only
// while `reconciled_at >= changed_at`; a flip that leaves `changed_at` alone is never re-verified before the 24 h recheck.
// (No migration: the column exists. `m36-global-search-writer.live.test.ts` pins both behaviours.)
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { eq } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";

const SETTING = schema.tenantMessagingSearchSettings;

export interface TenantSearchSetting {
  readonly enabled: boolean;
  readonly changedAt: Date | null;
  readonly purgeRequestedAt: Date | null;
  readonly purgeCompletedAt: Date | null;
  /** F5: the notice acknowledged at the last ON flip; all three null until the first ON. */
  readonly noticeAckVersion: string | null;
  readonly noticeAckByUserId: string | null;
  readonly noticeAckAt: Date | null;
}

const ABSENT: TenantSearchSetting = {
  enabled: false,
  changedAt: null,
  purgeRequestedAt: null,
  purgeCompletedAt: null,
  noticeAckVersion: null,
  noticeAckByUserId: null,
  noticeAckAt: null,
};

export async function readTenantSearchSettingInTx(
  tx: Tx,
  organizationId: string,
  opts: { readonly lock?: "share" | "update" } = {},
): Promise<TenantSearchSetting> {
  const base = tx
    .select({
      enabled: SETTING.enabled,
      changedAt: SETTING.changedAt,
      purgeRequestedAt: SETTING.purgeRequestedAt,
      purgeCompletedAt: SETTING.purgeCompletedAt,
      noticeAckVersion: SETTING.noticeAckVersion,
      noticeAckByUserId: SETTING.noticeAckByUserId,
      noticeAckAt: SETTING.noticeAckAt,
    })
    .from(SETTING)
    .where(eq(SETTING.organizationId, organizationId))
    .limit(1);
  const rows = await (opts.lock ? base.for(opts.lock) : base);
  return rows[0] ?? ABSENT;
}

export interface TenantSearchSettingStore {
  read(organizationId: string): Promise<TenantSearchSetting>;
}

export function createTenantSearchSettingStore(db: DbClient): TenantSearchSettingStore {
  return {
    read: (organizationId) =>
      withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        readTenantSearchSettingInTx(tx, organizationId),
      ),
  };
}
