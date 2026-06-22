// @wardenx/mdm — MDM job processors (M40-T08, spec §4.3, §7.5).
//
// The pure, infra-free logic the §4.3 workers run, each a function over injected ports — the same
// pattern as the M38 terminology / M4 audit jobs: unit-tested against in-memory ports, with the
// production NPPES-fetch / `mdm_canonical_writer` Drizzle / M36-alert adapters bound to the
// identical port shapes at app boot. T08 ships the headline `nppes_nightly_delta` (the Phase-1
// authoritative sync path until M29 lands, §4.3 fallback-only); the other §4.3 workers are pure
// descriptors in queues.ts whose processors land with their consumers (merge/repoint with T07's
// service, BAA/license/provisional scans with T10's alert wiring).
//
// No clock/RNG/I/O in this module — the clock is an injected `now()` port so a run's effects (the
// 25h fallback gate, the sync-log stamp) are deterministic and assertable.

import {
  type NppesDriftEvent,
  type NppesFreshRecord,
  type NppesKnownPhysician,
  detectNppesDrift,
} from "./drift";
import { M29_FALLBACK_THRESHOLD_HOURS } from "./queues";

const MS_PER_HOUR = 3_600_000;

/** A recorded `nppes_sync_log` run (§4.3 / §7.5). */
export interface NppesSyncLogEntry {
  readonly mode: "nightly_delta";
  readonly outcome: "success" | "skipped" | "failure";
  readonly driftCount: number;
  readonly deactivations: number;
}

/** Ports the nightly-delta processor binds (NPPES fetch + canonical writer + M36 alert + log). */
export interface NppesNightlyPorts {
  /** Injected clock — `now()` decides the 25h fallback gate + stamps the run. */
  now(): Date;
  /** When M29's platform sync (T-29.09) last completed, or `null` if it never has (§4.3). */
  m29LastSyncCompletedAt(): Promise<Date | null>;
  /** The canonical physicians MDM currently knows (the prior side of the §7.5 diff). */
  loadKnownPhysicians(): Promise<readonly NppesKnownPhysician[]>;
  /** Fetch fresh NPPES records for the given NPIs (the NPPES API adapter; out of M40's codePath). */
  fetchNppesDelta(npis: readonly string[]): Promise<readonly NppesFreshRecord[]>;
  /** Flip a canonical physician to `deactivated` (via `mdm_canonical_writer`, M40-T03). */
  applyDeactivation(canonicalId: string): Promise<void>;
  /** Apply changed demographic fields to a canonical physician (minimum-update, §7.11 discipline). */
  applyAttributeUpdate(event: NppesDriftEvent, fresh: NppesFreshRecord): Promise<void>;
  /** The orgs to alert for a deactivated physician — `is_preferred=true` or attached to an active
   *  patient (§7.5). Org-scoped consumers, read by the writer with platform context. */
  tenantsToAlert(canonicalId: string): Promise<readonly string[]>;
  /** Emit the M36 deactivation alert to an org (the next morning brief, §7.5). */
  emitDeactivationAlert(orgId: string, canonicalId: string, npi: string): Promise<void>;
  /** Record the run on `nppes_sync_log` (§7.5 `outcome='success'`). */
  recordSyncLog(entry: NppesSyncLogEntry): Promise<void>;
}

/** What the nightly delta reported. */
export interface NppesNightlyResult {
  /** False when skipped because M29's sync is recent (the §4.3 fallback gate held). */
  readonly ran: boolean;
  readonly skippedReason?: "m29_recent";
  readonly driftCount: number;
  readonly deactivations: number;
  readonly outcome: "success" | "skipped";
}

/**
 * Run the §4.3 NPPES nightly delta (the §7.5 drift path). FALLBACK-ONLY: if M29's platform sync
 * completed within {@link M29_FALLBACK_THRESHOLD_HOURS}, skip (M29 is the authoritative path) and
 * record nothing but the decision. Otherwise diff known canonical physicians against fresh NPPES
 * records via {@link detectNppesDrift}; for each deactivation flip the canonical to `deactivated`
 * and alert every affected tenant; apply attribute changes; then stamp `nppes_sync_log` success.
 * Deactivations are applied newest-NPI-deterministic (the engine sorts), so a partial failure is
 * reproducible.
 */
export async function runNppesNightlyDelta(ports: NppesNightlyPorts): Promise<NppesNightlyResult> {
  const last = await ports.m29LastSyncCompletedAt();
  if (last !== null) {
    const hoursSince = (ports.now().getTime() - last.getTime()) / MS_PER_HOUR;
    if (hoursSince < M29_FALLBACK_THRESHOLD_HOURS) {
      // M29 ran recently → the nightly is a no-op fallback. Don't double-sync (§7.11 coordination).
      return {
        ran: false,
        skippedReason: "m29_recent",
        driftCount: 0,
        deactivations: 0,
        outcome: "skipped",
      };
    }
  }

  const known = await ports.loadKnownPhysicians();
  const freshRecords = await ports.fetchNppesDelta(known.map((k) => k.npi));
  const freshByNpi = new Map(freshRecords.map((r) => [r.npi, r]));
  const drift = detectNppesDrift(known, freshByNpi);

  let deactivations = 0;
  for (const event of drift) {
    if (event.kind === "deactivated") {
      await ports.applyDeactivation(event.canonicalId);
      deactivations += 1;
      // Page every tenant who cares (is_preferred or active patient) — the §7.5 morning brief.
      const orgs = await ports.tenantsToAlert(event.canonicalId);
      for (const orgId of orgs)
        await ports.emitDeactivationAlert(orgId, event.canonicalId, event.npi);
    } else if (event.kind === "attribute_changed") {
      const fresh = freshByNpi.get(event.npi);
      if (fresh !== undefined) await ports.applyAttributeUpdate(event, fresh);
    }
    // `reactivated` flips back to active in production; modelled as an attribute path here (T09/T10).
  }

  await ports.recordSyncLog({
    mode: "nightly_delta",
    outcome: "success",
    driftCount: drift.length,
    deactivations,
  });

  return { ran: true, driftCount: drift.length, deactivations, outcome: "success" };
}
