// @wardenx/mdm — platform-owned reference-data seed (M40-T08, §3.8).
// Medicare + per-state Medicaid placeholders; pure data the production loader writes to the
// org-less canonical `payer` table via `mdm_canonical_writer`.
export {
  MDM_PAYER_SEED,
  MEDICARE_SEED,
  US_STATES,
  toPayerCanonicalSeed,
  type PayerSeedRow,
  type SeededPayerCanonical,
} from "./payers";
