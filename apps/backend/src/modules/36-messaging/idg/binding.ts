// apps/backend/src/modules/36-messaging/idg/binding.ts - WP 3.6: the composition-root binding for IDG discussions.
//
// The surface is ON only when BOTH tenant flags are on: `messaging.idg` (this feature) and `messaging.clinical_links`
// (an IDG discussion is anchored by an `idg_meeting` clinical link, so without links there is nothing to list). Absent =
// off, a kill switch = off, a throw reads as off (fail closed). Cached a few seconds per org like presence.
import type { DbClient } from "@chartwarden/db";
import { CLINICAL_LINKS_FLAG_KEY } from "../clinical-link/clinical-link-service";
import type { MessageBodyCipher } from "../messaging-write-core";
import { cacheFlagRead } from "../presence/binding";
import type { IdgDiscussionRouteDeps } from "../routes/idg-discussion-routes";
import { createDbIdgDiscussionStore } from "./idg-discussion-store-db";

export const IDG_FLAG_KEY = "messaging.idg";

export interface IdgDiscussionBindingInput {
  readonly db: DbClient;
  /** Injectable for tests; defaults to the process-wide lazy cipher, exactly as the message route service. */
  readonly cipher?: MessageBodyCipher;
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
}

export function buildIdgDiscussionDeps(
  input: IdgDiscussionBindingInput,
): Omit<IdgDiscussionRouteDeps, "canViewChannel"> {
  const { flags } = input;
  return {
    isEnabled: cacheFlagRead(async (organizationId) => {
      if (!flags) return false;
      const all = await flags.forOrg(organizationId);
      return all[IDG_FLAG_KEY] === true && all[CLINICAL_LINKS_FLAG_KEY] === true;
    }),
    store: createDbIdgDiscussionStore({
      db: input.db,
      ...(input.cipher ? { cipher: input.cipher } : {}),
    }),
  };
}
