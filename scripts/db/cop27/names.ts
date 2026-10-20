/**
 * COP27 demo patients' fictional legal names, keyed by scenario number. Distinct from every other seeded
 * patient, physician and staff persona (guarded by scripts/__tests__/seed-demo-names.test.ts). The
 * `DEMO-COP27-NN` marker is NOT a name: it is the referral's externalReferralId and a hospice_external
 * identifier, and is what a re-run uses to find a record again.
 */
export const COP27_NAMES: Readonly<Record<string, readonly [first: string, last: string]>> = {
  "01": ["Rhea", "Lindqvist"],
  "02": ["Ivy", "Castellan"],
  "03": ["Julian", "Aldridge"],
  "04": ["Nora", "Prescott"],
  "05": ["Otis", "Mbeki"],
  "06": ["Paula", "Voss"],
  "07": ["Quinn", "Halloran"],
  "08": ["Rosa", "Marchetti"],
  "09": ["Saul", "Ferreira"],
  "10": ["Tobias", "Wren"],
  "11": ["Uma", "Kowalski"],
  "12": ["Victor", "Albrecht"],
  "13": ["Wanda", "Ostrowski"],
};
