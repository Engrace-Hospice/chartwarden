// One place that renders an MRN with its label. Stored values vary ("MRN-E6FBB3B470FD", "123", "mrn 123"),
// so a caller that glues "MRN " onto the value shows "MRN MRN-E6FB..." (the label twice).

const LEADING_MRN_LABEL = /^\s*mrn(?![a-z0-9])[-:#.\s]*/i;

/** The identifier without any leading "MRN" label ("MRN-123" / "mrn: 123" / "123" -> "123"). Empty when nothing is left. */
export function mrnValue(raw: string | null | undefined): string {
  return (raw ?? "").replace(LEADING_MRN_LABEL, "").trim();
}

/**
 * The stored identifier verbatim ("MRN-E6FBB3B470FD" stays "MRN-E6FBB3B470FD"), so what is shown
 * matches what is stored and searched. A bare value ("123") gets the "MRN " label so the field is
 * still identifiable. The label never appears twice. Empty string when there is no value.
 */
export function formatMrn(raw: string | null | undefined): string {
  const value = mrnValue(raw);
  if (value === "") return "";
  const stored = (raw ?? "").trim();
  return LEADING_MRN_LABEL.test(stored) ? stored : `MRN ${value}`;
}
