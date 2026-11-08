// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/credential-reservation.ts — one credential, one organization
// (owner decisions 2026-11-08). Every credential a tenant seals is reserved to it in `tenant_clearinghouse_credential_reservation`
// (migration 1404), whose partial unique index spans organizations; switching to `outside` or rotating keeps the old reservation, and
// only the platform-ops release frees it. The database index is the enforcement point: RLS hides the other organization's row, the
// index is checked regardless, and its unique violation becomes one typed 409 that never names the holder.
import { ChartWardenError } from "@chartwarden/types";
import type { TenantClearinghouseMode } from "@chartwarden/types";
import {
  type ConfigPatch,
  type ConfigRow,
  type ConfigStore,
  isUniqueViolation,
} from "./config-store";
import type { ClearinghouseSecretCipher, CredentialFingerprint } from "./secret-cipher";

/** The indexes that keep one credential to one organization: the current-credential one (1403) and the reservation one (1404). */
const FINGERPRINT_INDEXES: ReadonlySet<string> = new Set([
  "tenant_clearinghouse_config_fingerprint_uq",
  "tenant_clearinghouse_credential_reservation_held_uq",
]);

/**
 * How long after an organization's latest production submission a platform operator may not release its credentials: late
 * acknowledgments and remittances for those claims may still arrive on the vendor account.
 * ponytail: a fixed window over the attempt's reservation time (the only clock a `sent` attempt carries); replace with a per-claim
 * adjudication check when M23 records one.
 */
export const RELEASE_QUIET_DAYS = 90;
const DAY_MS = 86_400_000;

/**
 * How many distinct credentials an organization may hold unreleased (security review LOW-4): every key it ever saved stays reserved
 * until platform ops releases it, so an unbounded loop of saves would grow the table and its audit trail without end.
 */
export const MAX_HELD_CREDENTIALS = 20;

/** A fingerprint to reserve, with the public id of its key (null: recorded before migration 1405). */
export interface HeldFingerprint {
  readonly keyId: string | null;
  readonly fingerprint: string;
}

/** The codes of a refused credential: each leaves a `denied` audit row on its own transaction. */
export const CREDENTIAL_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "CLEARINGHOUSE_ACCOUNT_IN_USE",
  "CLEARINGHOUSE_CREDENTIAL_LIMIT",
]);

/**
 * One refusal for "another organization, or the platform, already holds this credential". Its body never says which. The timing
 * does differ: the platform-key refusal answers before any database write, the other after the insert's unique check and rollback;
 * only a caller that already holds the key can observe the difference.
 */
export const accountInUse = (): ChartWardenError =>
  new ChartWardenError(
    "CLEARINGHOUSE_ACCOUNT_IN_USE",
    "this vendor credential is already connected elsewhere; each organization needs its own account",
    409,
  );

/** True when `err` is a unique violation of a fingerprint index (the constraint name is on the error or its cause). */
export const isFingerprintViolation = (err: unknown): boolean => {
  if (!isUniqueViolation(err)) return false;
  const e = err as {
    constraint_name?: string;
    constraint?: string;
    cause?: { constraint_name?: string; constraint?: string };
  };
  const name = e.constraint_name ?? e.constraint ?? e.cause?.constraint_name ?? e.cause?.constraint;
  return name !== undefined && FINGERPRINT_INDEXES.has(name);
};

/**
 * Reserve a credential to the organization under every fingerprint key it was computed under (current first, then each retired
 * KEK's; migration 1405), refusing the platform's own keys first. Idempotent for a credential the organization already holds. Runs on
 * the put's transaction, so a refusal rolls the whole change back.
 *
 * The cross-organization unique index is the enforcement point: each insert is `ON CONFLICT DO NOTHING` on it, so a fingerprint
 * someone already holds inserts nothing. Two organizations saving the same key at once serialise on that index entry (the second
 * waits for the first to commit, then inserts nothing); the keys are inserted in the same order everywhere, so they cannot deadlock.
 * A conflict on this organization's own reservation is a concurrent save of the same credential (a version conflict, retried by the
 * caller), never a refusal.
 */
export async function reserveCredential(
  store: ConfigStore,
  organizationId: string,
  vendor: string,
  fingerprints: readonly HeldFingerprint[],
  platformFingerprints: ReadonlySet<string> | undefined,
): Promise<void> {
  if (fingerprints.some((f) => platformFingerprints?.has(f.fingerprint))) throw accountInUse();
  const missing: HeldFingerprint[] = [];
  for (const f of fingerprints) {
    if (!(await store.holdsCredential(organizationId, f.fingerprint))) missing.push(f);
  }
  if (missing.length === 0) return;
  // ponytail: rows, not credentials (one row per key it was saved under); the cap scales with the configured keys. Concurrent saves
  // by one org serialise on its config row lock, except the very first save (a race that can overshoot by one).
  if (
    missing.length === fingerprints.length &&
    (await store.heldReservationCount(organizationId)) >= MAX_HELD_CREDENTIALS * fingerprints.length
  ) {
    throw new ChartWardenError(
      "CLEARINGHOUSE_CREDENTIAL_LIMIT",
      `this organization already holds ${MAX_HELD_CREDENTIALS} earlier clearinghouse credentials; ask platform support to release the ones it no longer uses`,
      409,
    );
  }
  for (const f of missing) {
    if (await store.reserveCredential(organizationId, vendor, f)) continue;
    if (await store.holdsCredential(organizationId, f.fingerprint)) {
      throw new ChartWardenError(
        "VERSION_CONFLICT",
        "the clearinghouse credential was saved concurrently; read the config and try again",
        412,
      );
    }
    throw accountInUse();
  }
}

/** The release refuses while vendor responses for the organization's production claims may still be arriving. */
export async function assertReleasable(
  store: ConfigStore,
  organizationId: string,
  now: Date,
): Promise<void> {
  const since = new Date(now.getTime() - RELEASE_QUIET_DAYS * DAY_MS);
  if (await store.hasRecentProductionAttempts(organizationId, since)) {
    throw new ChartWardenError(
      "CLEARINGHOUSE_RESPONSES_PENDING",
      `this organization sent production claims in the last ${RELEASE_QUIET_DAYS} days (or has one in flight); its vendor responses may still arrive, so its credentials stay reserved`,
      409,
    );
  }
}

/**
 * Keep the row's CURRENT credential reserved on every write that does not replace it.
 *   - A row sealed before migration 1403 has a credential and no fingerprint; 1404's CHECK refuses any write that keeps it that way.
 *     The write unseals it, fingerprints it under every configured key and reserves it (the same refusals as a fresh save).
 *   - A row whose fingerprint has no held reservation (written by a pre-1404 build during the `contract` halt window; security
 *     review LOW-1) has that fingerprint reserved again, under the key it was computed with.
 */
export async function backfillFingerprint(
  store: ConfigStore,
  row: ConfigRow,
  patch: ConfigPatch,
  cipherOf: () => ClearinghouseSecretCipher,
  platformFingerprints: ReadonlySet<string> | undefined,
): Promise<ConfigPatch> {
  if (patch.credentialFingerprint !== undefined || patch.secretCipher !== undefined) return patch;
  if (row.secretCipher === null) return patch;
  if (row.vendor !== "stedi" && row.vendor !== "claimmd") return patch;
  if (row.credentialFingerprint !== null) {
    await reserveCredential(
      store,
      row.organizationId,
      row.vendor,
      // null key id: recorded before 1405, under the KEK current then (no unseal needed to re-reserve it)
      [{ keyId: row.credentialFingerprintKeyId, fingerprint: row.credentialFingerprint }],
      platformFingerprints,
    );
    return patch;
  }
  if (row.mode !== "test" && row.mode !== "production") return patch;
  const cipher = cipherOf();
  let secret: string;
  try {
    secret = await cipher.decrypt(
      row.organizationId,
      { vendor: row.vendor, mode: row.mode as TenantClearinghouseMode },
      row.secretCipher,
    );
  } catch {
    throw new ChartWardenError(
      "CLEARINGHOUSE_SECRET_UNREADABLE",
      "the stored credential could not be opened; enter it again",
      409,
    );
  }
  const fingerprints = cipher.fingerprints(row.vendor, secret);
  await reserveCredential(
    store,
    row.organizationId,
    row.vendor,
    fingerprints,
    platformFingerprints,
  );
  const [current] = fingerprints as [CredentialFingerprint];
  return {
    ...patch,
    credentialFingerprint: current.fingerprint,
    credentialFingerprintKeyId: current.keyId,
  };
}
