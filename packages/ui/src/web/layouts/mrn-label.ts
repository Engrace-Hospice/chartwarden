// The patient banner prints its own "MRN" label, so the value beside it is the identifier WITHOUT a leading label: the patient service
// stores "MRN-FB250B6C6A8A", and "MRN MRN-FB250B6C6A8A" reads as the label twice. The stored value is never changed (search and lookup
// still match it either way); only what the banner shows after its label.
//
// The same rule as `mrnValue` in packages/types/src/mrn.ts. @chartwarden/ui is a leaf with no workspace dependency, so it keeps this
// one-line copy; apps/web/src/shell/mrn-display.dom.test.tsx pins the two equal, so they cannot drift apart unseen.
import type { ReactNode } from "react";

const LEADING_MRN_LABEL = /^\s*mrn(?![a-z0-9])[-:#.\s]*/i;

/** A string MRN without its leading "MRN" label ("MRN-123" / "mrn: 123" -> "123"); anything else (an element) is passed through. */
export function withoutMrnLabel(mrn: ReactNode): ReactNode {
  return typeof mrn === "string" ? mrn.replace(LEADING_MRN_LABEL, "").trim() : mrn;
}
