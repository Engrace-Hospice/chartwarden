// apps/backend/src/modules/18-evv/jobs/dek-rotation.ts — the §4.8 `m18.dek-rotation` worker: re-seal a tenant's
// EVV GPS coordinates under its CURRENT M34 DEK after a key-ring rotation.
//
// DIVISION OF LABOUR. M34 owns the rotation itself (`tenant.dek_rotate` mints + wraps the new DEK, keeps every
// prior version openable through `dekForOrgVersion`, emits `m34.tenant.dek_rotation_completed`). This worker
// owns only M18's ciphertext: every `evv_event.coords_cipher` whose `coords_dek_version` is not the current
// version is opened under the version its envelope names and sealed again under the current one; the
// `evv_geofence_evaluation.device_coords_cipher` snapshot carrying the same envelope moves in the same call.
//
// TRIGGERS. (1) On demand: an outbox consumer of `m34.tenant.dek_rotation_completed` re-seals that one tenant.
// (2) A daily cron sweep over every active org — the backstop for a run capped by `maxBatches`, a row that
// failed, or a rotation whose event was missed. Both drive the same org-explicit `resealOrgCoords`.
//
// THE WRITE PATH. `evv_event` is append-only (0047 §3.2 Phase C), so the app role cannot UPDATE the coordinate
// columns. Migration 0494 adds the one sanctioned path: the SECURITY DEFINER `evv_reseal_coords`, owned by the
// NOLOGIN `evv_coords_rekeyer`, which the append-only trigger lets rewrite exactly those two columns. It is a
// compare-and-swap on the old ciphertext, so a re-run or a concurrent run never double-writes.
//
// PROPERTIES. Org-explicit: each batch is its own `withOrgContext` transaction (a relay tick / cron tick is not
// a request). Bounded: `batchSize` rows per transaction, `maxBatches` per run (`complete: false` hands the rest
// to the next run). Resumable + idempotent: selection is "not under the current version", so progress is the
// data itself — no cursor is persisted; the in-run keyset cursor only exists to step PAST a row that failed.
// Fail loud: a row that cannot be opened (destroyed/unknown DEK version, tampered envelope) is skipped, every
// other row is still re-sealed, and the run then throws `EvvCoordsResealError` naming the event ids — so the
// job retries/DLQs and platform_ops sees it. Coordinates are never logged: errors carry ids only.
//
// LEGACY ROWS ('legacy-unencrypted', pre-GAP-133 base64) are NEVER re-sealed. They were never encrypted, the
// reader deliberately refuses to decode them (coords.ts), and prod is demo data fixed by reseeding — sealing
// them now would launder an unauthenticated value into a ciphertext the reader then trusts.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import {
  type EvvCoordsKeyProvider,
  LEGACY_COORDS_DEK_VERSION,
  createEvvCoordsCipher,
  isLegacyStoredCoords,
} from "../coords";

const EVENT = schema.evvEvent;

/** Rows re-sealed per transaction — one batch holds its tenant scope only this long. */
export const M18_DEK_ROTATION_BATCH_SIZE = 200;
/** Batches per run — bounds one tenant's share of a tick; the remainder is the next run's. */
export const M18_DEK_ROTATION_MAX_BATCHES = 500;

/** One row the selection returned: the event's key + what it is currently sealed as. */
export interface ResealCandidate {
  readonly eventId: string;
  readonly eventAt: Date;
  readonly coordsCipher: string;
  readonly coordsDekVersion: string;
}

/** The in-run keyset position (event_at, id) — only used to step past rows that failed. */
export interface ResealCursor {
  readonly eventAt: Date;
  readonly eventId: string;
}

/** What one tenant-scoped transaction can do. Org scope is the store's job (`inOrg`), never an argument. */
export interface EvvCoordsResealTx {
  /** This org's rows NOT sealed under `currentVersion` and not legacy, ordered by (event_at, id), after `after`. */
  staleBatch(query: {
    readonly currentVersion: string;
    readonly after: ResealCursor | null;
    readonly limit: number;
  }): Promise<readonly ResealCandidate[]>;
  /** Compare-and-swap re-seal of the event (and its geofence snapshot). False ⇒ the row had already moved. */
  reseal(write: {
    readonly eventId: string;
    readonly eventAt: Date;
    readonly expectedCipher: string;
    readonly cipher: string;
    readonly dekVersion: string;
  }): Promise<boolean>;
}

export interface EvvCoordsResealStore {
  /** Run `fn` in ONE transaction scoped to `organizationId` (RLS via `app.org_id`). */
  inOrg<T>(organizationId: string, fn: (tx: EvvCoordsResealTx) => Promise<T>): Promise<T>;
}

export interface DekRotationDeps {
  readonly store: EvvCoordsResealStore;
  /** M34's key ring (the composition root binds `getTenantKeyProvider()`, lazily). */
  readonly keys: EvvCoordsKeyProvider;
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

export interface DekRotationResult {
  readonly organizationId: string;
  readonly currentVersion: string;
  /** Rows the selection returned. */
  readonly scanned: number;
  /** Rows this run moved to the current version. */
  readonly resealed: number;
  /** Rows another run moved first (the compare-and-swap lost) — already handled, not a failure. */
  readonly raced: number;
  /** False when `maxBatches` stopped the run before the selection was exhausted. */
  readonly complete: boolean;
}

/** Raised AFTER a run when some rows could not be re-sealed. Carries event ids only — never a coordinate. */
export class EvvCoordsResealError extends Error {
  readonly failedEventIds: readonly string[];
  constructor(
    readonly organizationId: string,
    failures: readonly { readonly eventId: string; readonly reason: string }[],
    readonly result: DekRotationResult,
  ) {
    super(
      `m18.dek-rotation: ${failures.length} coordinate row(s) in org ${organizationId} could not be re-sealed ` +
        `under ${result.currentVersion} (${result.resealed} re-sealed): ${failures
          .map((f) => `${f.eventId} (${f.reason})`)
          .join(", ")}`,
    );
    this.name = "EvvCoordsResealError";
    this.failedEventIds = failures.map((f) => f.eventId);
  }
}

/** True when a row is a real envelope sealed under a version other than `currentVersion`. */
export function needsReseal(
  row: Pick<ResealCandidate, "coordsCipher" | "coordsDekVersion">,
  currentVersion: string,
): boolean {
  if (row.coordsDekVersion === LEGACY_COORDS_DEK_VERSION) return false;
  if (isLegacyStoredCoords(row.coordsCipher)) return false;
  return row.coordsDekVersion !== currentVersion;
}

/** A failure reason safe to log: the error's class/message from crypto or the DB, never row content. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
}

interface BatchOutcome {
  readonly scanned: number;
  readonly resealed: number;
  readonly raced: number;
  readonly last: ResealCursor | null;
  readonly failures: readonly { readonly eventId: string; readonly reason: string }[];
}

/** One tenant-scoped transaction: select a batch, re-seal each row, report. */
async function resealBatch(
  deps: DekRotationDeps,
  organizationId: string,
  currentVersion: string,
  after: ResealCursor | null,
  limit: number,
): Promise<BatchOutcome> {
  const cipher = createEvvCoordsCipher(deps.keys);
  return deps.store.inOrg(organizationId, async (tx) => {
    const rows = await tx.staleBatch({ currentVersion, after, limit });
    let resealed = 0;
    let raced = 0;
    const failures: { eventId: string; reason: string }[] = [];
    for (const row of rows) {
      if (!needsReseal(row, currentVersion)) continue;
      // Only the KEY work is per-row recoverable. A DB error is not caught: it aborts the transaction, and
      // swallowing it would let the batch "commit" (really roll back) while counting rows as re-sealed.
      let sealed: { cipher: string; dekVersion: string };
      try {
        const coords = await cipher.open(organizationId, row.coordsCipher);
        if (!coords) throw new Error("envelope opened to no coordinate");
        sealed = await cipher.seal(organizationId, coords);
      } catch (error) {
        failures.push({ eventId: row.eventId, reason: reasonOf(error) });
        continue;
      }
      const moved = await tx.reseal({
        eventId: row.eventId,
        eventAt: row.eventAt,
        expectedCipher: row.coordsCipher,
        cipher: sealed.cipher,
        dekVersion: sealed.dekVersion,
      });
      if (moved) resealed += 1;
      else raced += 1;
    }
    const tail = rows[rows.length - 1];
    return {
      scanned: rows.length,
      resealed,
      raced,
      last: tail ? { eventAt: tail.eventAt, eventId: tail.eventId } : null,
      failures,
    };
  });
}

/**
 * Re-seal one org's coordinates under its current DEK. Org-explicit (a worker is not a request). Throws
 * {@link EvvCoordsResealError} after the run when any row failed; every other row is still re-sealed.
 */
export async function resealOrgCoords(
  deps: DekRotationDeps,
  organizationId: string,
): Promise<DekRotationResult> {
  const batchSize = deps.batchSize ?? M18_DEK_ROTATION_BATCH_SIZE;
  const maxBatches = deps.maxBatches ?? M18_DEK_ROTATION_MAX_BATCHES;
  const { version: currentVersion } = await deps.keys.dekForOrg(organizationId);

  let after: ResealCursor | null = null;
  let scanned = 0;
  let resealed = 0;
  let raced = 0;
  let complete = false;
  const failures: { eventId: string; reason: string }[] = [];
  for (let batch = 0; batch < maxBatches; batch++) {
    const outcome = await resealBatch(deps, organizationId, currentVersion, after, batchSize);
    scanned += outcome.scanned;
    resealed += outcome.resealed;
    raced += outcome.raced;
    failures.push(...outcome.failures);
    after = outcome.last;
    if (outcome.scanned < batchSize) {
      complete = true;
      break;
    }
  }
  const result: DekRotationResult = {
    organizationId,
    currentVersion,
    scanned,
    resealed,
    raced,
    complete,
  };
  if (failures.length > 0) throw new EvvCoordsResealError(organizationId, failures, result);
  return result;
}

/** The production store: Drizzle + RLS, every write through migration 0494's `evv_reseal_coords`. */
export function createDrizzleCoordsResealStore(db: DbClient): EvvCoordsResealStore {
  return {
    inOrg(organizationId, fn) {
      return withOrgContext(db, { organizationId, userId: "" }, async (raw) => {
        const tx = raw as DbClient;
        return fn({
          async staleBatch({ currentVersion, after, limit }) {
            const rows = await tx
              .select({
                eventId: EVENT.id,
                eventAt: EVENT.eventAt,
                coordsCipher: EVENT.coordsCipher,
                coordsDekVersion: EVENT.coordsDekVersion,
              })
              .from(EVENT)
              .where(
                and(
                  eq(EVENT.organizationId, organizationId),
                  ne(EVENT.coordsDekVersion, currentVersion),
                  ne(EVENT.coordsDekVersion, LEGACY_COORDS_DEK_VERSION),
                  after
                    ? sql`(${EVENT.eventAt}, ${EVENT.id}) > (${after.eventAt.toISOString()}::timestamptz, ${after.eventId}::uuid)`
                    : undefined,
                ),
              )
              .orderBy(asc(EVENT.eventAt), asc(EVENT.id))
              .limit(limit);
            return rows;
          },
          async reseal({ eventId, eventAt, expectedCipher, cipher, dekVersion }) {
            const result = await tx.execute(
              sql`SELECT evv_reseal_coords(${eventId}::uuid, ${eventAt.toISOString()}::timestamptz, ${expectedCipher}, ${cipher}, ${dekVersion}) AS moved`,
            );
            const rows = Array.isArray(result)
              ? (result as { moved: number }[])
              : ((result as unknown as { rows?: { moved: number }[] }).rows ?? []);
            return Number(rows[0]?.moved ?? 0) > 0;
          },
        });
      });
    },
  };
}

export const M18_DEK_ROTATION_CONSUMER = {
  eventName: "m34.tenant.dek_rotation_completed",
  consumerName: "m18.dek-rotation",
} as const;

/** The on-demand trigger. The tenant is the envelope's `organizationId`, cross-checked against the payload. */
export function buildM18DekRotationConsumer(deps: DekRotationDeps) {
  return {
    consumerName: M18_DEK_ROTATION_CONSUMER.consumerName,
    consumerModule: "m18" as const,
    eventTypes: [M18_DEK_ROTATION_CONSUMER.eventName],
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const orgId = (event.payload as Record<string, unknown> | null)?.orgId;
      if (orgId !== event.organizationId) {
        throw new Error(
          `${M18_DEK_ROTATION_CONSUMER.consumerName}: payload orgId does not match the event's organization`,
        );
      }
      await resealOrgCoords(deps, event.organizationId);
    },
  };
}
