// One place that renders an MRN with its label. Stored values vary ("MRN-E6FBB3B470FD", "123", "mrn 123"),
// so a caller that glues "MRN " onto the value shows "MRN MRN-E6FB..." (the label twice).

const LEADING_MRN_LABEL = /^\s*mrn(?![a-z0-9])[-:#.\s]*/i;

/** The identifier without any leading "MRN" label ("MRN-123" / "mrn: 123" / "123" -> "123"). Empty when nothing is left. */
export function mrnValue(raw: string | null | undefined): string {
  return (raw ?? "").replace(LEADING_MRN_LABEL, "").trim();
}

/** "MRN <value>" with the label exactly once; empty string when there is no value. */
export function formatMrn(raw: string | null | undefined): string {
  const value = mrnValue(raw);
  return value === "" ? "" : `MRN ${value}`;
}
