// @chartwarden/billing — the physician NPIs an 837I carries (UB-04 FL 76 attending, FL 78 certifying; CGS/FISS
// "Hospice Medicare Billing Codes Sheet", footnote 6: the certifying physician is only completed when different
// from the attending). Provider identifiers, not patient data. An unresolved or malformed NPI is `null`, never a
// guess. PURE.
import type { MdmResolution } from "../rules/types";

export interface ClaimPhysicianNpis {
  readonly attendingPhysicianNpi: string | null;
  readonly certifyingPhysicianNpi: string | null;
}

const NPI_PATTERN = /^[0-9]{10}$/;

const validNpi = (npi: string | undefined): string | null =>
  npi !== undefined && NPI_PATTERN.test(npi) ? npi : null;

/** Derive the claim's attending / certifying NPIs from the M40 clinical-participant resolution. */
export function claimPhysicianNpis(mdm: MdmResolution): ClaimPhysicianNpis {
  const attending = validNpi(mdm.attending?.npi);
  const hospice = validNpi(mdm.hospicePhysician?.npi);
  return {
    attendingPhysicianNpi: attending,
    certifyingPhysicianNpi: hospice !== null && hospice !== attending ? hospice : null,
  };
}
