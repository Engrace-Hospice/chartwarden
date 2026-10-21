// @chartwarden/billing — the claim's UB-04 Type of Admission (FL 14 / 837I CL101) and Point of Origin (FL 15 / CL102),
// taken from the M6 admission. PURE. A value outside the NUBC set is dropped to null (never forwarded to a federal
// claim) so the `admission_codes_present` rule blocks instead of a payer rejecting.
import { isAdmissionSourceCode, isAdmissionTypeCode } from "@chartwarden/types";

export interface ClaimAdmissionCodes {
  readonly admissionTypeCode: string | null;
  readonly admissionSourceCode: string | null;
}

export interface AdmissionCodeFacts {
  readonly admissionTypeCode?: string | null;
  readonly admissionSourceCode?: string | null;
}

export function claimAdmissionCodes(facts: AdmissionCodeFacts): ClaimAdmissionCodes {
  const type = facts.admissionTypeCode;
  const source = facts.admissionSourceCode;
  return {
    admissionTypeCode: type != null && isAdmissionTypeCode(type) ? type : null,
    admissionSourceCode: source != null && isAdmissionSourceCode(source) ? source : null,
  };
}
