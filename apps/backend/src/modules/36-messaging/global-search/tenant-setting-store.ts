// WP 2.7b C2 (ADR-0058 decision 1) - reads `tenant_messaging_search_setting` (M36-owned, org-scoped). No cache: a flip takes
// effect on the next call. A tenant with no row is OFF. The tx-scoped reader can take a FOR SHARE lock on the row so an
// in-flight index write blocks the admin's OFF update until it commits (the purge then starts after the last insert).
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
}

const ABSENT: TenantSearchSetting = {
  enabled: false,
  changedAt: null,
  purgeRequestedAt: null,
  purgeCompletedAt: null,
};

export async function readTenantSearchSettingInTx(
  tx: Tx,
  organizationId: string,
  opts: { readonly lockShare?: boolean } = {},
): Promise<TenantSearchSetting> {
  const base = tx
    .select({
      enabled: SETTING.enabled,
      changedAt: SETTING.changedAt,
      purgeRequestedAt: SETTING.purgeRequestedAt,
      purgeCompletedAt: SETTING.purgeCompletedAt,
    })
    .from(SETTING)
    .where(eq(SETTING.organizationId, organizationId))
    .limit(1);
  const rows = await (opts.lockShare ? base.for("share") : base);
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
