// @chartwarden/mdm — the `BaaStore` data port + an in-memory slice default (M40-T06, §4.6.2).
//
// The `BaaStatusProvider` seam (provider.ts) composes the pure {@link decideBaaStatus} engine over
// the rows this port returns. Production implements it over the `facility` / `mdm_baa_required` /
// `mdm_baa_record` Drizzle tables under `withPlatformContext` (the gate reads across the platform's
// canonical facilities, §4.6.2), plus the §4.6.2 60s Valkey cache; the in-memory store here keeps
// the boot slice + the W-M40-10/11 acceptance tests free of live infra. Data only — every gate
// decision lives in the engine.

import type { BaaEntityKind } from "../interfaces/baa-status-provider";
import type { BaaRecordRow } from "./gate";

/** The data-access boundary the {@link BaaStatusProvider} composes over. */
export interface BaaStore {
  /**
   * The `facility` canonical id whose `sending_facility_codes` contains `sendingFacility`
   * (case-insensitive, §7.9), or `null` when no facility matches. Reads across the platform's
   * canonical facilities (org-less), so production wraps it in `withPlatformContext`.
   */
  facilityIdBySendingFacility(sendingFacility: string): Promise<string | null>;

  /** This tenant's `mdm_baa_required.required` for a kind, or `null` when unconfigured (→ default). */
  isBaaRequired(orgId: string, kind: BaaEntityKind): Promise<boolean | null>;

  /** Every `mdm_baa_record` for (org, kind, canonicalId) — the engine selects the in-force one. */
  baaRecords(
    orgId: string,
    kind: BaaEntityKind,
    canonicalId: string,
  ): Promise<readonly BaaRecordRow[]>;
}

/** A facility seed row: its canonical id + the sending-facility codes it answers to. */
export interface SeedBaaFacility {
  readonly facilityId: string;
  readonly sendingFacilityCodes: readonly string[];
}

/** A per-(org,kind) BAA-required policy seed row. */
export interface SeedBaaRequired {
  readonly orgId: string;
  readonly kind: BaaEntityKind;
  readonly required: boolean;
}

/** A BAA record seed row, keyed by (org, kind, canonicalId). */
export interface SeedBaaRecord {
  readonly orgId: string;
  readonly kind: BaaEntityKind;
  readonly canonicalId: string;
  readonly record: BaaRecordRow;
}

/** Seed shape for {@link createInMemoryBaaStore} — all fields optional. */
export interface InMemoryBaaSeed {
  readonly facilities?: readonly SeedBaaFacility[];
  readonly required?: readonly SeedBaaRequired[];
  readonly records?: readonly SeedBaaRecord[];
}

/** Compound map key — space-joined. */
function key(...parts: string[]): string {
  return parts.join(" ");
}

/**
 * An in-memory {@link BaaStore} for the boot slice + the W-M40-10/11 acceptance tests.
 * Deterministic, no I/O. The sending-facility match is case-insensitive (§7.9). Production
 * replaces this with the Drizzle-backed store (T07).
 */
export function createInMemoryBaaStore(seed: InMemoryBaaSeed = {}): { store: BaaStore } {
  // sending facility code (upper) → facility id.
  const byCode = new Map<string, string>();
  for (const f of seed.facilities ?? []) {
    for (const code of f.sendingFacilityCodes) byCode.set(code.toUpperCase(), f.facilityId);
  }

  const required = new Map<string, boolean>();
  for (const r of seed.required ?? []) required.set(key(r.orgId, r.kind), r.required);

  const records = new Map<string, BaaRecordRow[]>();
  for (const r of seed.records ?? []) {
    const k = key(r.orgId, r.kind, r.canonicalId);
    (records.get(k) ?? records.set(k, []).get(k)!).push(r.record);
  }

  const store: BaaStore = {
    async facilityIdBySendingFacility(sendingFacility) {
      return byCode.get(sendingFacility.toUpperCase()) ?? null;
    },

    async isBaaRequired(orgId, kind) {
      const k = key(orgId, kind);
      return required.has(k) ? required.get(k)! : null;
    },

    async baaRecords(orgId, kind, canonicalId) {
      return records.get(key(orgId, kind, canonicalId)) ?? [];
    },
  };

  return { store };
}
