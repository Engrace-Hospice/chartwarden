// @wardenx/mdm — the pure NPPES drift-detection engine (M40-T08, spec §7.5).
//
// Given the canonical physician state MDM last knew + the fresh records NPPES now publishes, compute
// what DRIFTED: a deactivated NPI (the §7.5 headline — must be caught within 24h), a reactivation,
// or a changed demographic attribute (name / specialty / address). PURE and DB-agnostic — the
// nightly processor (processors.ts) supplies prior state from the canonical table and fresh records
// from the NPPES adapter, applies the deactivations via `mdm_canonical_writer`, and emits the M36
// alerts. This engine only decides WHAT changed, so the §7.5 detection has exactly one home.

/** The canonical physician state MDM last recorded (the prior side of the diff). */
export interface NppesKnownPhysician {
  readonly npi: string;
  readonly canonicalId: string;
  readonly status: "active" | "deactivated";
  readonly lastName: string;
  readonly specialtyTaxonomy: string | null;
}

/** A fresh NPPES record (the current side of the diff). */
export interface NppesFreshRecord {
  readonly npi: string;
  readonly status: "active" | "deactivated";
  readonly lastName: string;
  readonly specialtyTaxonomy: string | null;
}

/** The kind of drift detected for an NPI (§7.5). */
export type NppesDriftKind = "deactivated" | "reactivated" | "attribute_changed";

/** One drift event — the canonical row to update + which fields changed (for the §8.1 provenance). */
export interface NppesDriftEvent {
  readonly npi: string;
  readonly canonicalId: string;
  readonly kind: NppesDriftKind;
  /** The changed demographic fields (empty for a pure status flip). */
  readonly changedFields: readonly string[];
}

/** The demographic fields the nightly diff compares (status is handled separately). */
const ATTRIBUTE_FIELDS = ["lastName", "specialtyTaxonomy"] as const;

/** Which {@link ATTRIBUTE_FIELDS} differ between the known canonical and the fresh NPPES record. */
function changedAttributes(known: NppesKnownPhysician, fresh: NppesFreshRecord): string[] {
  return ATTRIBUTE_FIELDS.filter((f) => known[f] !== fresh[f]);
}

/**
 * Diff the known canonical physicians against the fresh NPPES records (§7.5). For each known NPI
 * with a fresh record:
 *   • active → deactivated  ⇒ `deactivated` (the §7.5 case that pages affected tenants)
 *   • deactivated → active  ⇒ `reactivated`
 *   • same status, changed name/specialty ⇒ `attribute_changed` (with the changed field list)
 * An NPI absent from `fresh` (NPPES returned nothing for it) is NOT drift — a delta sync simply did
 * not include it; only a present record that differs is a change. Results are ordered by NPI so a
 * run's effects are deterministic.
 */
export function detectNppesDrift(
  known: readonly NppesKnownPhysician[],
  fresh: ReadonlyMap<string, NppesFreshRecord>,
): NppesDriftEvent[] {
  const events: NppesDriftEvent[] = [];
  for (const k of known) {
    const f = fresh.get(k.npi);
    if (f === undefined) continue;
    if (k.status === "active" && f.status === "deactivated") {
      events.push({ npi: k.npi, canonicalId: k.canonicalId, kind: "deactivated", changedFields: [] });
    } else if (k.status === "deactivated" && f.status === "active") {
      events.push({ npi: k.npi, canonicalId: k.canonicalId, kind: "reactivated", changedFields: [] });
    } else {
      const changedFields = changedAttributes(k, f);
      if (changedFields.length > 0) {
        events.push({ npi: k.npi, canonicalId: k.canonicalId, kind: "attribute_changed", changedFields });
      }
    }
  }
  return events.sort((a, b) => (a.npi < b.npi ? -1 : a.npi > b.npi ? 1 : 0));
}
