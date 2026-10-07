// apps/backend/src/modules/40-mdm/jobs/nppes-fallback.ts — M40 §4.3 `mdm.nppes_nightly_delta` (02:00, FALLBACK-ONLY)
// and `mdm.nppes_weekly_full` (Sun 03:00) production ports (GAP-173). The decision logic (`runNppesNightlyDelta` /
// `runNppesWeeklyFull`, `detectNppesDrift`) shipped and was unit-tested in `@wardenx/mdm` since M40-T08; what never
// existed was anything to bind its ports to.
//
// WHY BOTH, WHEN M29 SYNCS: M29's D11 platform sync is the AUTHORITATIVE path (GAP-099 delivers its events to the
// §4.7 appliers). The nightly delta runs only when M29's last completed sync is older than 25 h (the processor's own
// gate, fed by `m29LastSyncCompletedAt`), and the weekly full sweep reconciles whatever either path missed.
//
// THE TWO INJECTIONS, and why they are not imported: the NPPES HTTP client and M29's `nppes_sync_run` read belong to
// M29, and M40 must not import M29 or read its table (`arch:tables`). The composition root hands in
// `fetchProvider` (one NPI → fresh record, or null when NPPES has nothing) and `m29LastSyncCompletedAt`.
//
// WRITES go through the migration-0202 `mdm_canonical_writer_*` functions (never a direct table write), the run is
// recorded through the migration-0473 `mdm_canonical_writer_record_nppes_sync`, and provenance is stamped
// `m40_legacy_nightly` so a reader can tell a fallback write from an M29 one. A per-NPI fetch failure is counted,
// not fatal; if EVERY fetch failed the run is recorded `failed` and the job throws (BullMQ retries / DLQ alert).
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import {
  type NppesFreshRecord,
  type NppesKnownPhysician,
  type NppesNightlyPorts,
  type NppesNightlyResult,
  runNppesNightlyDelta,
  runNppesWeeklyFull,
} from "@wardenx/mdm";
import { and, asc, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  type M40ActiveOrgPort,
  type M40AlertPort,
  buildNppesConsumerPorts,
} from "../outbox-consumers/nppes-consumer-ports";

const PHYSICIAN = schema.externalPhysicians;

/** The nightly delta only re-checks canonicals not synced in the last day, capped so one night stays bounded. */
const DELTA_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DELTA_BATCH_LIMIT = 2_000;

export interface NppesFallbackDeps {
  readonly db: DbClient;
  readonly alerts: M40AlertPort;
  readonly orgs: M40ActiveOrgPort;
  /** One NPI → its fresh NPPES record (individual NPI-1), or null (not found / organization / invalid). */
  readonly fetchProvider: (npi: string) => Promise<NppesFreshRecord | null>;
  /** When M29's platform sync last COMPLETED (null if never). */
  readonly m29LastSyncCompletedAt: () => Promise<Date | null>;
  readonly now?: () => Date;
}

type Mode = "nightly_delta" | "weekly_full";

interface RunStats {
  looked: number;
  fetchErrors: number;
  changed: number;
}

/** Build the processor ports for one run; `stats` is read back to write the sync-log counters. */
export function buildNppesFallbackPorts(
  deps: NppesFallbackDeps,
  mode: Mode,
): { readonly ports: NppesNightlyPorts; readonly stats: RunStats } {
  const now = deps.now ?? (() => new Date());
  const stats: RunStats = { looked: 0, fetchErrors: 0, changed: 0 };
  // The §4.7 appliers' own ports: reused for the minimum-update door and the "tenants that care" fan-out so the
  // fallback and M29 paths cannot drift apart on who gets alerted.
  const consumer = buildNppesConsumerPorts({
    db: deps.db,
    outbox: { publish: async () => undefined }, // the fallback emits its own events below
    alerts: deps.alerts,
    orgs: deps.orgs,
    now,
  }).ports;

  const ports: NppesNightlyPorts = {
    now,
    m29LastSyncCompletedAt: deps.m29LastSyncCompletedAt,

    async loadKnownPhysicians(): Promise<readonly NppesKnownPhysician[]> {
      const staleBefore = new Date(now().getTime() - DELTA_STALE_AFTER_MS);
      const base = and(isNotNull(PHYSICIAN.npi), ne(PHYSICIAN.status, "merged"));
      const where =
        mode === "weekly_full"
          ? base
          : and(
              base,
              or(isNull(PHYSICIAN.nppesLastSyncedAt), lt(PHYSICIAN.nppesLastSyncedAt, staleBefore)),
            );
      const rows = await deps.db
        .select({
          id: PHYSICIAN.id,
          npi: PHYSICIAN.npi,
          status: PHYSICIAN.status,
          lastName: PHYSICIAN.lastName,
          specialtyTaxonomy: PHYSICIAN.specialtyTaxonomy,
        })
        .from(PHYSICIAN)
        .where(where)
        .orderBy(asc(PHYSICIAN.nppesLastSyncedAt), asc(PHYSICIAN.id))
        .limit(mode === "weekly_full" ? 100_000 : DELTA_BATCH_LIMIT);
      return rows.flatMap((r) =>
        r.npi !== null && (r.status === "active" || r.status === "deactivated")
          ? [
              {
                npi: r.npi,
                canonicalId: r.id,
                status: r.status,
                lastName: r.lastName,
                specialtyTaxonomy: r.specialtyTaxonomy,
              },
            ]
          : [],
      );
    },

    async fetchNppesDelta(npis) {
      const fresh: NppesFreshRecord[] = [];
      for (const npi of npis) {
        stats.looked += 1;
        try {
          const record = await deps.fetchProvider(npi);
          if (record !== null) fresh.push(record);
        } catch {
          // Counted, not fatal: one flaky lookup must not abandon the other 1,999. Retries live in the client.
          stats.fetchErrors += 1;
        }
      }
      if (npis.length > 0 && stats.fetchErrors === npis.length) {
        await recordRun(deps, mode, stats, 0, "failed");
        throw new Error(`M40 NPPES ${mode}: every one of ${npis.length} NPPES lookups failed`);
      }
      return fresh;
    },

    async applyDeactivation(canonicalId) {
      const provenance = {
        lastSyncedAt: now().toISOString(),
        lastSyncSource: "m40_legacy_nightly",
        lastChangedFields: ["status"],
        deactivationSource: "m40_legacy_nightly",
      };
      await deps.db.execute(
        sql`SELECT mdm_canonical_writer_deactivate_physician(${canonicalId}, ${JSON.stringify(provenance)}::jsonb) AS applied`,
      );
    },

    async applyAttributeUpdate(event, fresh) {
      const updates: Record<string, unknown> = {};
      if (event.changedFields.includes("lastName")) updates.lastName = fresh.lastName;
      if (event.changedFields.includes("specialtyTaxonomy")) {
        updates.specialtyTaxonomy = fresh.specialtyTaxonomy;
      }
      await consumer.applyCanonicalUpdate(event.canonicalId, updates);
      stats.changed += 1;
    },

    tenantsToAlert: (canonicalId) => consumer.tenantsToAlert(canonicalId),

    async emitDeactivationAlert(orgId, canonicalId, npi) {
      await deps.alerts.emit(orgId, {
        eventType: "mdm.physician_deactivated",
        payload: { canonicalId, npi, kind: "physician" },
        severity: "warn",
        correlationId: `m40-nppes-deactivation:${canonicalId}`,
      });
    },

    async recordSyncLog(entry) {
      await recordRun(deps, entry.mode, stats, entry.deactivations, entry.outcome);
    },
  };
  return { ports, stats };
}

/** Write the `nppes_sync_log` row through the 0473 definer function. */
async function recordRun(
  deps: NppesFallbackDeps,
  mode: Mode,
  stats: RunStats,
  deactivated: number,
  outcome: "success" | "failure" | "failed" | "skipped",
): Promise<void> {
  const logged =
    outcome === "failed" || outcome === "failure"
      ? "failed"
      : stats.fetchErrors > 0
        ? "partial"
        : "success";
  await deps.db.execute(sql`
    SELECT mdm_canonical_writer_record_nppes_sync(
      ${mode}, ${stats.looked}, ${stats.changed}, ${deactivated}, ${stats.fetchErrors},
      ${logged}, ${stats.fetchErrors > 0 ? JSON.stringify({ fetchErrors: stats.fetchErrors }) : null}::jsonb
    )
  `);
}

/** `mdm.nppes_nightly_delta` — fallback-only (skips when M29 synced within 25 h). */
export function runNppesNightlyDeltaJob(deps: NppesFallbackDeps): Promise<NppesNightlyResult> {
  return runNppesNightlyDelta(buildNppesFallbackPorts(deps, "nightly_delta").ports);
}

/** `mdm.nppes_weekly_full` — the full reconcile sweep, never fallback-gated. */
export function runNppesWeeklyFullJob(deps: NppesFallbackDeps): Promise<NppesNightlyResult> {
  return runNppesWeeklyFull(buildNppesFallbackPorts(deps, "weekly_full").ports);
}
