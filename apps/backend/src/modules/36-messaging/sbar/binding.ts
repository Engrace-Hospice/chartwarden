// apps/backend/src/modules/36-messaging/sbar/binding.ts - WP 3.3: the composition-root binding for SBAR.
// The tenant flag `messaging.sbar` is read through the platform's FeatureFlagReaderPort (tenant row wins; absent = off,
// a kill switch = off), cached a few seconds per org like presence and clinical links.
import type { DbClient } from "@wardenx/db";
import { cacheFlagRead } from "../presence/binding";
import type { SbarRouteDeps } from "../routes/sbar-routes";
import { createDbSbarPolicyStore } from "./sbar-policy-store-db";

export const SBAR_FLAG_KEY = "messaging.sbar";

export interface SbarBindingInput {
  readonly db: DbClient;
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
}

export function buildSbarDeps(input: SbarBindingInput): SbarRouteDeps {
  const { flags } = input;
  return {
    isEnabled: cacheFlagRead(async (organizationId) =>
      flags ? (await flags.forOrg(organizationId))[SBAR_FLAG_KEY] === true : false,
    ),
    store: createDbSbarPolicyStore(input.db),
  };
}
