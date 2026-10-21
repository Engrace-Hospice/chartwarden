// apps/backend/src/modules/35-subscription/pseudonym-key-provider.ts — the first real implementation of
// `PseudonymKeyProvider.activeKey()` (F-172, #248). `patient_pseudonym_key` is PLATFORM-ONLY (0143: RLS
// enabled + FORCEd, GRANT ALL to `chartwarden_admin` alone, no `chartwarden_app` grant at all) — this file is
// therefore always driven over the PLATFORM pool (`DATABASE_PLATFORM_URL`), the exact `platformDb` shape
// M34's `keyRingDb` already uses for its own platform-only `tenant_key_ring` (`bootstrap/tenant-kek.ts`),
// never the tenant-scoped `db` every other M35 route runs `withOrgContext` over.
//
// MINT-ON-FIRST-USE, RACE-SAFE. Unlike M34's tenant DEKs (minted explicitly at `tenant.provision`, one
// per org, on demand), there is exactly ONE platform-wide pseudonym key epoch and nothing analogous to a
// provisioning workflow ever creates it — so `activeKey()` itself is where the platform's first epoch
// comes into existence, idempotently, the first time ANY caller needs one. Race-safety is the DATABASE's
// job, not this file's: `patient_pseudonym_key_one_active_uq` (a partial unique index on `is_active WHERE
// is_active = true`) means two processes racing to mint the first epoch on cold boot can insert at most
// ONE row between them — the loser's INSERT hits `ON CONFLICT DO NOTHING` and falls through to re-SELECT
// the winner's row, never invents a second "active" epoch. The raw key bytes are `randomBytes(32)`
// (`mintPseudonymKeyMaterial`) — a CSPRNG mint, the identical mechanism `tenant-kek.ts#mintAndWrapDek`
// already uses for every tenant DEK on this platform; no human chooses or reviews the bytes, only the
// KEK that wraps them is operator-configured (`M35_PSEUDONYM_KEY_KEK`).
import { type DbClient, schema } from "@chartwarden/db";
import {
  PseudonymKekError,
  type PseudonymKekRing,
  type PseudonymKeyProvider,
  mintPseudonymKeyMaterial,
  openPseudonymKeyMaterial,
  sealPseudonymKeyMaterial,
} from "@chartwarden/subscription-billing";
import { eq } from "drizzle-orm";

const PPK = schema.patientPseudonymKey;

/** `epoch-<UTC-ISO-minute>-<4 hex>` — human-legible (the `patient_active_period.pseudonym_key_epoch`
 *  column is read by ops during the §annual-key-rotation runbook) and, with the trailing entropy, unique
 *  enough that two processes minting within the same minute do not collide on `key_epoch`'s OWN unique
 *  index before the `is_active` partial index even gets a chance to arbitrate. */
function freshEpochId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
    .slice(0, 13); // YYYYMMDDTHHmm
  const suffix = Math.random().toString(16).slice(2, 6);
  return `epoch-${stamp}-${suffix}`;
}

/**
 * Build the real `PseudonymKeyProvider`. `platformDb` MUST be a connection carrying the platform
 * credential's grants (never the tenant `chartwarden_app` pool, which 0143 refuses SELECT/INSERT on this
 * table outright — the M34 `tenant_key_ring` precedent, §3.10/M34-F02, applied to this table too).
 */
export function createDrizzlePseudonymKeyProvider(
  platformDb: DbClient,
  ring: PseudonymKekRing,
  now: () => Date = () => new Date(),
): PseudonymKeyProvider {
  async function readActiveRow() {
    const [row] = await platformDb.select().from(PPK).where(eq(PPK.isActive, true)).limit(1);
    return row ?? null;
  }

  async function mintFirstEpoch(): Promise<void> {
    const plaintext = mintPseudonymKeyMaterial();
    try {
      const keyEpoch = freshEpochId(now());
      const sealed = sealPseudonymKeyMaterial(ring, keyEpoch, plaintext);
      await platformDb
        .insert(PPK)
        .values({
          keyEpoch,
          keyMaterialCiphertext: sealed.ciphertextB64,
          keyKmsRef: sealed.kekId,
          isActive: true,
          activatedAt: now(),
        })
        // Bare (no target) — the `system-dashboard-seeder.ts` (F-116) precedent for an idempotent-seed
        // insert against a partial unique index: ANY conflict here (the `is_active WHERE is_active = true`
        // partial index — a concurrent winner already minted the epoch this process was about to insert —
        // or the near-impossible `key_epoch` collision) means "there is already an active epoch", and the
        // correct outcome for either is the same no-op, not a retry.
        .onConflictDoNothing();
    } finally {
      plaintext.fill(0);
    }
  }

  return {
    async activeKey(): Promise<{ keyEpoch: string; keyMaterial: string }> {
      let row = await readActiveRow();
      if (!row) {
        await mintFirstEpoch();
        row = await readActiveRow();
      }
      if (!row) {
        // Only reachable if the mint's own re-read raced a RETIREMENT (a rotation) in the same instant —
        // report it rather than mint a SECOND epoch, which would silently produce two "first" epochs.
        throw new PseudonymKekError(
          "patient_pseudonym_key: no active epoch after mint — a concurrent rotation may have retired it; retry",
        );
      }
      const plaintext = openPseudonymKeyMaterial(
        ring,
        row.keyKmsRef,
        row.keyEpoch,
        row.keyMaterialCiphertext,
      );
      try {
        return { keyEpoch: row.keyEpoch, keyMaterial: plaintext.toString("hex") };
      } finally {
        plaintext.fill(0);
      }
    },
  };
}

/**
 * §annual-key-rotation (module spec §14.3 / D6 rejected-alternative note: "the old key is retired…
 * remains in the table for forensic re-pseudonymization"). Retires the current active epoch and mints a
 * fresh one under the ring's ACTIVE kek. Not wired to an HTTP admin route in this pass — `key-rotator.ts`
 * (module spec T-12) is the named future home for the operator-facing surface; this is the callable core
 * a future route/cron would drive, proven directly by the live suite instead of through a route contract
 * that does not exist yet.
 */
export async function rotatePseudonymKey(
  platformDb: DbClient,
  ring: PseudonymKekRing,
  now: () => Date = () => new Date(),
): Promise<{ readonly retiredEpoch: string | null; readonly newEpoch: string }> {
  const [current] = await platformDb.select().from(PPK).where(eq(PPK.isActive, true)).limit(1);
  const at = now();
  if (current) {
    await platformDb
      .update(PPK)
      .set({ isActive: false, retiredAt: at })
      .where(eq(PPK.id, current.id));
  }
  const plaintext = mintPseudonymKeyMaterial();
  let newEpoch: string;
  try {
    newEpoch = freshEpochId(at);
    const sealed = sealPseudonymKeyMaterial(ring, newEpoch, plaintext);
    await platformDb.insert(PPK).values({
      keyEpoch: newEpoch,
      keyMaterialCiphertext: sealed.ciphertextB64,
      keyKmsRef: sealed.kekId,
      isActive: true,
      activatedAt: at,
    });
  } finally {
    plaintext.fill(0);
  }
  return { retiredEpoch: current?.keyEpoch ?? null, newEpoch };
}
