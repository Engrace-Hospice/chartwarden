// apps/backend/src/modules/36-messaging/death-notification/recipient-hash.ts - the keyed digest of a funeral-home notice's recipient address.
// HMAC-SHA256 under a server-side per-tenant key (the ring-derived K_search, the same key material the global search uses), with a domain label so the
// digest cannot be confused with any other use of that key. An unkeyed or merely salted hash of an email address is brute-forceable from a
// dictionary; with the key held outside the database, a stolen row alone is not. The address itself is never stored.
import { createHmac } from "node:crypto";
import type { SearchKeyProvider } from "@chartwarden/messaging";

const DOMAIN = "death-notification-recipient:v1:";

export const hmacRecipient = (key: Buffer, normalizedEmail: string): string =>
  createHmac("sha256", key).update(`${DOMAIN}${normalizedEmail}`, "utf8").digest("hex");

/** Throws when the tenant key is unavailable (the service then refuses the send before minting a link). */
export const ringRecipientHasher =
  (keys: Pick<SearchKeyProvider, "activeVersion" | "tagKey">) =>
  async (orgId: string, normalizedEmail: string): Promise<string> =>
    hmacRecipient(await keys.tagKey(orgId, await keys.activeVersion(orgId)), normalizedEmail);
