// M34 tenant key ring (`tenant_key_ring`): the HIGHEST-RISK backfill. Every tenant's PHI is encrypted under the DEK that this
// row wraps, so a ring that no longer unwraps is an unreadable tenant. The sequence is therefore two-phase, and the row is
// replaced only by bytes that have already been proven:
//   1. COMPUTE  for the current DEK and every `prior_dek_versions` entry that still unwraps only under the legacy label:
//               unwrap it (both labels), wrap the same DEK under the new label with the SAME KEK, open that wrap under the new
//               label ALONE and compare (the adapter's `rewrapDek` refuses a wrap that does not round-trip). Nothing is written.
//   2. REPLACE  one UPDATE of the one row, compare-and-swapped on the old wrapped bytes (a concurrent DEK rotation makes it match
//               nothing), in one short transaction. It is atomic: a crash leaves the old row or the new, never a mix.
//   3. VERIFY   read the row back and unwrap EVERY entry under the new label alone; each DEK must equal the fingerprint taken in
//               phase 1. If any does not, the old row is written back (compare-and-swap on the new bytes) and the row is `failed`.
// The KEK is never changed (the new wrap uses the entry's own `kekId`), no plaintext DEK is held past its fingerprint, and the
// operator must pass `--i-have-a-backup`: a restorable backup of `tenant_key_ring` is the last line of defence.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import type { PlatformKekAdapter } from "../../../apps/backend/src/bootstrap/tenant-kek";
import { type RowClass, type Scan, type WriteResult, inOrg, rowsOf, tryOpen } from "./core";

export class BackupNotConfirmedError extends Error {
  constructor() {
    super(
      "refusing to re-wrap tenant key rings: pass --i-have-a-backup after taking a restorable backup of tenant_key_ring",
    );
    this.name = "BackupNotConfirmedError";
  }
}

/**
 * Restoring the old bytes after a failed read-back itself failed: the ring is in the NEW state, which was not proven. The run
 * stops here (it never carries on past a ring it could not put right). The message names no value.
 */
export class RingRestoreFailedError extends Error {
  constructor(readonly ringId: string) {
    super(
      `tenant_key_ring ${ringId}: the re-wrapped ring failed its read-back and the old bytes could NOT be restored; the ring holds the new, unproven wraps. Inspect it and restore from the backup if it does not unwrap.`,
    );
    this.name = "RingRestoreFailedError";
  }
}

/** What a test hook throws to simulate the process dying at that point; it escapes the scan instead of being counted. */
export class SimulatedCrash extends Error {
  constructor(readonly point: string) {
    super(`simulated crash at ${point}`);
    this.name = "SimulatedCrash";
  }
}

/** Test-only fault injection points; production passes none. A hook that throws SimulatedCrash simulates a crash there. */
export interface M34Hooks {
  /** All new wraps computed and verified, nothing written yet. */
  readonly afterCompute?: () => Promise<void> | void;
  /** The UPDATE has run inside its transaction, before COMMIT (a throw rolls it back). */
  readonly beforeCommit?: () => Promise<void> | void;
  /** COMMIT done, before the read-back verification. */
  readonly afterCommit?: () => Promise<void> | void;
  /** Just before the read-back query (a plain throw here is a transient read failure). */
  readonly beforeReadBack?: () => Promise<void> | void;
  /** Just before the old bytes are written back (a plain throw here is a failed restore). */
  readonly beforeRestore?: () => Promise<void> | void;
}

interface PriorEntry {
  readonly version: string;
  readonly kekWrappedCiphertext: string;
  readonly kekId: string;
  readonly [other: string]: unknown;
}

interface RingRow {
  readonly id: string;
  readonly organizationId: string;
  readonly currentCiphertext: Buffer | null;
  readonly currentKekId: string | null;
  readonly priors: readonly PriorEntry[];
}

const fingerprint = (dek: Buffer): string => createHash("sha256").update(dek).digest("hex");

/** Every wrapped entry of the ring as (label, wrapped bytes, kek id). */
function entriesOf(
  row: RingRow,
): Array<{ slot: "current" | number; wrapped: Buffer; kekId: string }> {
  const entries: Array<{ slot: "current" | number; wrapped: Buffer; kekId: string }> = [];
  if (row.currentCiphertext && row.currentKekId) {
    entries.push({ slot: "current", wrapped: row.currentCiphertext, kekId: row.currentKekId });
  }
  row.priors.forEach((prior, index) => {
    entries.push({
      slot: index,
      wrapped: Buffer.from(prior.kekWrappedCiphertext, "base64"),
      kekId: prior.kekId,
    });
  });
  return entries;
}

async function readRing(
  platformDb: DbClient,
  organizationId: string,
  id: string,
): Promise<RingRow | undefined> {
  return inOrg(platformDb, organizationId, async (tx) => {
    const r = rowsOf<{
      id: string;
      organization_id: string;
      current_dek_kek_wrapped_ciphertext: Buffer | null;
      current_dek_kek_id: string | null;
      prior_dek_versions: PriorEntry[] | null;
    }>(
      await tx.execute(sql`
        SELECT id::text AS id, organization_id::text AS organization_id,
               current_dek_kek_wrapped_ciphertext, current_dek_kek_id, prior_dek_versions
          FROM tenant_key_ring WHERE organization_id = ${organizationId} AND id = ${id}::uuid`),
    )[0];
    return r && toRing(r);
  });
}

const toRing = (r: {
  id: string;
  organization_id: string;
  current_dek_kek_wrapped_ciphertext: Buffer | null;
  current_dek_kek_id: string | null;
  prior_dek_versions: PriorEntry[] | null;
}): RingRow => ({
  id: r.id,
  organizationId: r.organization_id,
  currentCiphertext: r.current_dek_kek_wrapped_ciphertext,
  currentKekId: r.current_dek_kek_id,
  priors: r.prior_dek_versions ?? [],
});

export function m34KeyRingScan(
  deps: {
    readonly platformDb: DbClient;
    readonly kek: PlatformKekAdapter;
    /** The operator's `--i-have-a-backup`. Required before any write. */
    readonly backupConfirmed: boolean;
    readonly hooks?: M34Hooks;
  },
  organizationId: string,
): Scan<RingRow> {
  const { platformDb, kek, hooks } = deps;
  const unwrapEntry = (
    row: RingRow,
    entry: { wrapped: Buffer; kekId: string },
    onlyGeneration?: "current" | "legacy",
  ) =>
    kek.unwrap({
      organizationId: row.organizationId,
      kekWrappedCiphertext: entry.wrapped,
      kekId: entry.kekId,
      ...(onlyGeneration ? { onlyGeneration } : {}),
    });

  return {
    module: "m34",
    table: "tenant_key_ring",
    organizationId,
    idOf: (row) => row.id,
    async page(after, limit) {
      return inOrg(platformDb, organizationId, async (tx) =>
        rowsOf<Parameters<typeof toRing>[0]>(
          await tx.execute(sql`
            SELECT id::text AS id, organization_id::text AS organization_id,
                   current_dek_kek_wrapped_ciphertext, current_dek_kek_id, prior_dek_versions
              FROM tenant_key_ring
             WHERE organization_id = ${organizationId} AND destroyed_at IS NULL
               AND (${after}::uuid IS NULL OR id > ${after}::uuid)
             ORDER BY id
             LIMIT ${limit}`),
        ).map(toRing),
      );
    },
    async classify(row): Promise<RowClass> {
      const entries = entriesOf(row);
      if (entries.length === 0) return "ignore";
      let anyLegacy = false;
      let anyUnreadable = false;
      for (const entry of entries) {
        const asCurrent = await tryOpen(() => unwrapEntry(row, entry, "current"));
        if (asCurrent) {
          asCurrent.fill(0);
          continue;
        }
        const asLegacy = await tryOpen(() => unwrapEntry(row, entry, "legacy"));
        if (!asLegacy) {
          anyUnreadable = true;
          continue;
        }
        asLegacy.fill(0);
        anyLegacy = true;
      }
      // Entries are judged one by one: an unreadable prior version never hides a legacy current DEK (the work is done on the
      // readable ones), and once nothing legacy is left the ring is "unreadable" until the operator resolves that entry.
      return anyLegacy ? "legacy" : anyUnreadable ? "unreadable" : "current";
    },
    async reseal(row): Promise<WriteResult> {
      if (!deps.backupConfirmed) throw new BackupNotConfirmedError();
      try {
        // ── Phase 1: compute and prove every new wrap; nothing is written. ──
        const expected = new Map<"current" | number, string>();
        let newCurrent: Buffer | null = row.currentCiphertext;
        const newPriors: PriorEntry[] = [...row.priors];
        let unreadableEntries = 0;
        let rewrappedEntries = 0;
        for (const entry of entriesOf(row)) {
          const dek = await tryOpen(() => unwrapEntry(row, entry));
          if (!dek) {
            unreadableEntries += 1; // reported below; it does not stop the readable entries
            continue;
          }
          expected.set(entry.slot, fingerprint(dek));
          dek.fill(0);
          const alreadyCurrent = await tryOpen(() => unwrapEntry(row, entry, "current"));
          if (alreadyCurrent) {
            alreadyCurrent.fill(0);
            continue;
          }
          const rewrapped = await kek.rewrapDek({
            organizationId: row.organizationId,
            kekWrappedCiphertext: entry.wrapped,
            kekId: entry.kekId,
          });
          rewrappedEntries += 1;
          const bytes = Buffer.from(rewrapped.wrappedCiphertextB64, "base64");
          if (entry.slot === "current") newCurrent = bytes;
          else {
            newPriors[entry.slot] = {
              ...(row.priors[entry.slot] as PriorEntry),
              kekWrappedCiphertext: rewrapped.wrappedCiphertextB64,
            };
          }
        }
        await hooks?.afterCompute?.();
        if (rewrappedEntries === 0) return unreadableEntries > 0 ? "failed" : "skipped";

        // ── Phase 2: replace the row atomically, only if nobody changed it since it was read. ──
        const replaced = await inOrg(platformDb, organizationId, async (tx) => {
          const swapped = rowsOf<{ id: string }>(
            await tx.execute(sql`
              UPDATE tenant_key_ring
                 SET current_dek_kek_wrapped_ciphertext = ${newCurrent}::bytea,
                     prior_dek_versions = ${JSON.stringify(newPriors)}::jsonb
               WHERE organization_id = ${organizationId} AND id = ${row.id}::uuid
                 AND current_dek_kek_wrapped_ciphertext IS NOT DISTINCT FROM ${row.currentCiphertext}::bytea
                 AND prior_dek_versions = ${JSON.stringify(row.priors)}::jsonb
              RETURNING id`),
          );
          await hooks?.beforeCommit?.();
          return swapped.length === 1;
        });
        if (!replaced) return "skipped";
        await hooks?.afterCommit?.();

        // ── Phase 3: read back and prove every entry opens under the NEW label alone, to the same DEK. ──
        let after: RingRow | undefined;
        try {
          await hooks?.beforeReadBack?.();
          after = await readRing(platformDb, organizationId, row.id);
        } catch (error) {
          if (error instanceof SimulatedCrash) throw error;
          return "unverified"; // committed, but the read-back could not be taken
        }
        if (after) {
          // Someone else (a DEK rotation, a shred) changed the ring after our commit: what we wrote is no longer there to
          // judge, and rolling it back would undo their work. The next run looks at the ring as it is.
          const wrote = entriesOf({ ...row, currentCiphertext: newCurrent, priors: newPriors });
          const read = entriesOf(after);
          const unchanged =
            wrote.length === read.length &&
            wrote.every(
              (w, i) => w.slot === read[i]?.slot && w.wrapped.equals(read[i]?.wrapped as Buffer),
            );
          if (!unchanged) return "skipped";
        }
        let ok = after !== undefined;
        if (after) {
          for (const entry of entriesOf(after)) {
            if (!expected.has(entry.slot)) continue; // the unreadable entry has no fingerprint; it is reported, not judged
            const dek = await tryOpen(() => unwrapEntry(after, entry, "current"));
            if (!dek || fingerprint(dek) !== expected.get(entry.slot)) ok = false;
            dek?.fill(0);
          }
        }
        // An entry that could not be read at all is a problem the operator must resolve: the gate stays red (failed).
        if (ok) return unreadableEntries > 0 ? "failed" : "resealed";
        try {
          await hooks?.beforeRestore?.();
          await restore(platformDb, organizationId, row, newCurrent, newPriors);
        } catch (error) {
          if (error instanceof SimulatedCrash) throw error;
          throw new RingRestoreFailedError(row.id);
        }
        return "failed";
      } catch (error) {
        if (
          error instanceof BackupNotConfirmedError ||
          error instanceof SimulatedCrash ||
          error instanceof RingRestoreFailedError
        )
          throw error;
        return "failed";
      }
    },
  };
}

/** Put the pre-run bytes back, but only over the exact bytes this run wrote (never over a later rotation). */
async function restore(
  platformDb: DbClient,
  organizationId: string,
  original: RingRow,
  writtenCurrent: Buffer | null,
  writtenPriors: readonly PriorEntry[],
): Promise<void> {
  await inOrg(platformDb, organizationId, async (tx) => {
    await tx.execute(sql`
      UPDATE tenant_key_ring
         SET current_dek_kek_wrapped_ciphertext = ${original.currentCiphertext}::bytea,
             prior_dek_versions = ${JSON.stringify(original.priors)}::jsonb
       WHERE organization_id = ${organizationId} AND id = ${original.id}::uuid
         AND current_dek_kek_wrapped_ciphertext IS NOT DISTINCT FROM ${writtenCurrent}::bytea
         AND prior_dek_versions = ${JSON.stringify(writtenPriors)}::jsonb`);
  });
}
