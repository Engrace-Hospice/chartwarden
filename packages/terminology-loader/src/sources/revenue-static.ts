// @wardenx/terminology-loader — the UB-04 revenue-code static seed (M38 §3.1 `revenue-codes.ts`: "static seed;
// manual update on revision"). Only the hospice-relevant subset is bundled; the complete NUBC list is an admin
// upload of a normalized CSV. Descriptions follow the standard UB-04 titles.

/** [code, display] pairs. */
export const REVENUE_HOSPICE_SUBSET: readonly (readonly [string, string])[] = [
  ["0250", "General classification - pharmacy"],
  ["0651", "Hospice service - routine home care"],
  ["0652", "Hospice service - continuous home care"],
  ["0655", "Hospice service - inpatient respite care"],
  ["0656", "Hospice service - general inpatient care (non-respite)"],
  ["0657", "Hospice service - physician services"],
];

/** The subset as normalized-CSV bytes, parsed by the same pipeline as an operator upload. */
export function revenueStaticSeedBytes(): Uint8Array {
  const lines = ["code,display", ...REVENUE_HOSPICE_SUBSET.map(([c, d]) => `${c},"${d}"`)];
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}
