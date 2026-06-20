// @wardenx/mdm — platform-owned payer seed (M40-T08, spec §3.8).
//
// The §3.8 reference data the platform owns: Medicare (one canonical payer) + a per-state Medicaid
// placeholder for every US state + DC. Pure data — no DB import. The production seed loader writes
// these to the org-less `payer` canonical table via the `mdm_canonical_writer` role (M40-T03); the
// in-memory backend / tests project them through {@link toPayerCanonicalSeed}. `entity_relationship`
// is populated on demand and `mdm_baa_record` ships empty (tenants populate as they execute BAAs).

import type { PayerKind } from "../interfaces/kinds";

/** A platform payer seed row (the §3.8 canonical payer shape before id assignment). */
export interface PayerSeedRow {
  /** A stable seed key (e.g. `medicare`, `medicaid_or`) — the canonical id derives from it. */
  readonly seedKey: string;
  readonly kind: PayerKind;
  readonly name: string;
  /** The X12 payer id when the payer has a well-known one (Medicare); `null` for the placeholders. */
  readonly x12PayerId: string | null;
}

/** The 50 states + DC — the per-state Medicaid placeholder set (§3.8). */
export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
  "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM",
  "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
] as const;

/** Medicare — the one fully-specified canonical payer in the §3.8 seed. */
export const MEDICARE_SEED: PayerSeedRow = {
  seedKey: "medicare",
  kind: "medicare",
  name: "Medicare",
  x12PayerId: "MEDICARE",
};

/**
 * The full §3.8 payer seed: Medicare + a Medicaid placeholder per state/DC. Placeholders carry no
 * X12 id yet (each tenant's state intermediary fills it in via overlay/config as it onboards).
 */
export const MDM_PAYER_SEED: readonly PayerSeedRow[] = [
  MEDICARE_SEED,
  ...US_STATES.map((st): PayerSeedRow => ({
    seedKey: `medicaid_${st.toLowerCase()}`,
    kind: "medicaid",
    name: `${st} Medicaid`,
    x12PayerId: null,
  })),
];

/** The canonical-payer projection (§4.5 `CanonicalPayerFields` shape) for one seed row + its id. */
export interface SeededPayerCanonical {
  readonly id: string;
  readonly identifierType: "x12_payer_id";
  readonly identifierValue: string | null;
  readonly displayName: string;
  readonly x12PayerId: string | null;
}

/**
 * Project the seed into canonical-payer rows, deriving a deterministic id from each `seedKey`
 * (`payer_<seedKey>`) so the same seed is reproducible without a clock/RNG. The in-memory backend
 * and tests feed these as `SeedCanonical` rows; production assigns real uuids at insert time.
 */
export function toPayerCanonicalSeed(): readonly SeededPayerCanonical[] {
  return MDM_PAYER_SEED.map((p) => ({
    id: `payer_${p.seedKey}`,
    identifierType: "x12_payer_id",
    identifierValue: p.x12PayerId,
    displayName: p.name,
    x12PayerId: p.x12PayerId,
  }));
}
