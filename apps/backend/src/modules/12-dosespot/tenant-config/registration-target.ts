// apps/backend/src/modules/12-dosespot/tenant-config/registration-target.ts — which DoseSpot clinic a tenant's registration names right now,
// and the lock that keeps a vendor round trip that began under one clinic from writing its ids after the registration moved to another
// (ADR-0111 D6).
//
// A registration move clears every id DoseSpot issued under the old clinic (`ConfigStore.clearVendorBindings`, in the PUT's own transaction).
// That alone does not cover a round trip already in flight: an enrolment call, a patient upsert or a prescription create that began under the
// old clinic and whose answer arrives AFTER the clear would write an old-clinic id back, where nothing clears it again (re-enrolment returns
// early for a linked prescriber). So each of those writes captured the target before its vendor call and, in the transaction that writes the
// id, asks {@link vendorWriteIsCurrent}: under a shared advisory lock that the clear takes exclusively, so the two can never interleave. The
// write sees either the old target (and runs first, so the clear then removes what it wrote) or the new one (and is dropped).
//
// The target is `<environment>:<clinic id>` for a tenant with a registration row, and `env` for one served by the env binding (no row): a row
// that takes over from the env binding is a different target, matching the clear's conservative rule. A move A -> B -> A inside one round trip
// reads as "unchanged" (ABA); the ids a trip under A wrote are valid under A, so nothing stale is written.
import { type DbClient, schema } from "@chartwarden/db";
import { DOSESPOT_ENV_BOUND_TARGET } from "@chartwarden/dosespot";
import { type SQLWrapper, eq, sql } from "drizzle-orm";

const R = schema.dosespotClinicRegistrations;

/** The target of an organization with no registration row (the env binding, or nothing, serves it). */
export const ENV_BOUND_TARGET = DOSESPOT_ENV_BOUND_TARGET;

/** The clinic a registration row names; {@link ENV_BOUND_TARGET} for no row. */
export function targetOfRegistration(
  row: { readonly environment: string; readonly clinicId: string | null } | null | undefined,
): string {
  return row ? `${row.environment}:${row.clinicId ?? ""}` : ENV_BOUND_TARGET;
}

/** The target the org's registration names now (a plain read in the caller's transaction). */
export async function readRegistrationTarget(
  tx: DbClient,
  organizationId: string,
): Promise<string> {
  const [row] = await tx
    .select({ environment: R.environment, clinicId: R.clinicId })
    .from(R)
    .where(eq(R.organizationId, organizationId))
    .limit(1);
  return targetOfRegistration(row);
}

/**
 * A fresh idempotency key derived from the old one (SQL, so it can ride the UPDATE that drops the old clinic's bindings). The key names an order at the
 * OLD clinic (it rides as the Idempotency-Key of the create and the send): if DoseSpot dedupes by key across clinics, the new clinic would answer with
 * the old prescription. Derived from the old key so it stays unique per order, with a random part so it never repeats; 64 hex characters like every
 * key the transmission row holds. Nothing reads a key back to compare it (the sign-time enqueue only runs for an order not yet queued).
 */
export const freshIdempotencyKey = (previousKey: SQLWrapper) =>
  sql`encode(sha256(convert_to(${previousKey} || ':retargeted:' || gen_random_uuid()::text, 'UTF8')), 'hex')`;

/** One advisory-lock key per organization; the clear holds it exclusively, every guarded vendor-id write holds it shared. */
const bindingsLockKey = (organizationId: string) =>
  sql`hashtextextended(${`dosespot:vendor-bindings:${organizationId}`}, 0)`;

/**
 * Taken by the registration change that clears the old clinic's ids, BEFORE it touches those rows, and held to the end of its transaction.
 * It waits for every guarded write already running (which commit first, so the clear removes what they wrote) and holds back every one that
 * starts later until the new target is committed.
 */
export async function lockVendorBindingsForClear(
  tx: DbClient,
  organizationId: string,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${bindingsLockKey(organizationId)})`);
}

/**
 * How long a guarded write waits for a registration change that holds the lock before it gives up and treats the registration as moved. The change
 * holds the lock only for its own transaction, so a wait of seconds means it is stuck (on a row lock, say): without a bound every guarded write behind
 * it, and so every later tenant's pass (the per-org passes run one after another), would stall with it.
 */
export const BINDINGS_LOCK_WAIT_MS = 5_000;
const BINDINGS_LOCK_POLL_MS = 100;

/** The shared lock, taken without ever blocking: polled until it is free or {@link BINDINGS_LOCK_WAIT_MS} has passed. */
async function acquireBindingsLockShared(tx: DbClient, organizationId: string): Promise<boolean> {
  // Wall time can jump backward and silently extend the transaction-held wait. This process clock is monotonic.
  const deadline = performance.now() + BINDINGS_LOCK_WAIT_MS;
  for (;;) {
    const answered = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock_shared(${bindingsLockKey(organizationId)}) AS locked`,
    );
    const rows = (answered as unknown as { rows?: Array<{ locked?: unknown }> }).rows ?? [];
    if (rows[0]?.locked === true) return true;
    if (performance.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, BINDINGS_LOCK_POLL_MS));
  }
}

/**
 * Is a vendor id obtained under `expectedTarget` still the right thing to write? Call it FIRST in the transaction that writes the id (before any
 * row lock of its own, so it cannot deadlock with the clear), and write only on `true`. On `false` the registration moved while the vendor
 * round trip ran, OR a registration change holds the lock and did not release it within {@link BINDINGS_LOCK_WAIT_MS} (it is in progress, which
 * is a move for this purpose: the exclusive lock is taken only by a change of clinic): either way drop the write, and a caller that settles
 * a call treats it as moved.
 */
export async function vendorWriteIsCurrent(
  tx: DbClient,
  organizationId: string,
  expectedTarget: string,
): Promise<boolean> {
  if (!(await acquireBindingsLockShared(tx, organizationId))) return false;
  return (await readRegistrationTarget(tx, organizationId)) === expectedTarget;
}
