// apps/backend/src/modules/36-messaging/governance/staff-name-port.ts - the by-id staff display-name lookup the governance surfaces need
// ("placed by", redaction requester and approver). M36 reads no identity table for it: the composition root binds M2's directory reader
// (02-identity/staff-names.ts) and this module declares the shape it needs, structurally. Runs in the caller's tenant transaction.
import type { DbClient } from "@chartwarden/db";

export type StaffNamePort = (
  tx: DbClient,
  organizationId: string,
  userIds: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

/** The name for `userId`, or null when the directory has none (an unknown id, another tenant's user, an empty name). */
export const nameOrNull = (
  names: ReadonlyMap<string, string>,
  userId: string | null,
): string | null => (userId ? (names.get(userId) ?? null) : null);

/** Resolve names for the ids a response carries; a missing port yields an empty map (every name null, the id is still shown). */
export async function resolveNames(
  port: StaffNamePort | undefined,
  tx: DbClient,
  organizationId: string,
  userIds: readonly (string | null)[],
): Promise<ReadonlyMap<string, string>> {
  if (!port) return new Map();
  return port(
    tx,
    organizationId,
    userIds.filter((id): id is string => id !== null && id !== ""),
  );
}
