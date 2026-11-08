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
import type { ClearinghouseSecretCipher } from "./secret-cipher";

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
 * Reserve `fingerprint` to the organization, refusing the platform's own keys first. Idempotent for a credential the organization
 * already holds. Runs on the put's transaction, so a refusal rolls the whole change back.
 */
export async function reserveCredential(
  store: ConfigStore,
  organizationId: string,
  vendor: string,
  fingerprint: string,
  platformFingerprints: ReadonlySet<string> | undefined,
): Promise<void> {
  if (platformFingerprints?.has(fingerprint)) throw accountInUse();
  if (await store.holdsCredential(organizationId, fingerprint)) return;
  try {
    await store.reserveCredential(organizationId, vendor, fingerprint);
  } catch (err) {
    if (isFingerprintViolation(err)) throw accountInUse();
    throw err;
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
 * A row sealed before migration 1403 has a credential and no fingerprint; migration 1404's CHECK refuses any write that keeps it
 * that way. The first write that does not replace the credential unseals it, fingerprints it and reserves it (the same refusals as
 * a fresh save: the platform's own key, or a key another organization holds).
 */
export async function backfillFingerprint(
  store: ConfigStore,
  row: ConfigRow,
  patch: ConfigPatch,
  cipherOf: () => ClearinghouseSecretCipher,
  platformFingerprints: ReadonlySet<string> | undefined,
): Promise<ConfigPatch> {
  if (patch.credentialFingerprint !== undefined || patch.secretCipher !== undefined) return patch;
  if (row.secretCipher === null || row.credentialFingerprint !== null) return patch;
  if (row.vendor !== "stedi" && row.vendor !== "claimmd") return patch;
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
  const credentialFingerprint = cipher.fingerprint(row.vendor, secret);
  await reserveCredential(
    store,
    row.organizationId,
    row.vendor,
    credentialFingerprint,
    platformFingerprints,
  );
  return { ...patch, credentialFingerprint };
}
