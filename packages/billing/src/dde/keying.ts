// @chartwarden/billing — the DDE "keying sheet" (ADR-0052 amendment 2026-10). PURE: no DB, no clock.
//
// DDE (FISS) is a green-screen, per-user-credentialed terminal with no API, so the queue's job is to hand the human
// operator everything M23 knows that they must key, and nothing they must not see. The sheet carries identifiers and
// dates the notice / claim row already stores. It NEVER carries an MBI (ADR-0052 D7: the operator reveals it from the
// M5 chart under existing controls) and never free text. Provider CCN / NPI come from the read-only provider-identifier
// seam (#765) when the composition root binds it; unbound or unresolved, the two fields are simply absent.
import type { DdeItemType } from "../machines/dde-work-item";

export interface DdeKeyingField {
  readonly label: string;
  readonly value: string;
}

export interface DdeKeyingReasonCode {
  readonly code: string;
  /** Plain-language meaning, or null when we cannot state one with confidence (look it up in DDE). */
  readonly meaning: string | null;
}

export interface DdeKeyingSheet {
  /** Where to work in FISS: a hint to confirm against the MAC's DDE guide, never an instruction to automate. */
  readonly screenHint: string;
  readonly fields: DdeKeyingField[];
  readonly rejectionCodes: DdeKeyingReasonCode[];
}

/** The provider entity's public identifiers (ADR-0052 amendment, #765). Never a beneficiary identifier. */
export interface DdeKeyingProvider {
  readonly ccn: string;
  readonly npi: string;
}

export interface DdeKeyingNotice {
  readonly kind: "noe" | "notr";
  readonly controlNumber: string;
  readonly payerControlNumber: string | null;
  /** NOE election effective date, or NOTR effective end date. */
  readonly effectiveDate: string;
  readonly windowTargetAt: string;
  readonly rejectionCodes: readonly string[];
}

export interface DdeKeyingClaim {
  readonly tob: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly controlNumber: string;
  readonly payerControlNumber: string | null;
  readonly patientStatusCode: string | null;
  readonly admissionTypeCode: string | null;
  readonly admissionSourceCode: string | null;
  /** Sanitised X12 277CA status codes from the latest payer-stage rejection (`A7:21`). */
  readonly rejectionCodes: readonly string[];
}

/** X12 277CA claim status CATEGORY codes whose meaning is standard. Anything else is left to the DDE screen. */
const STATUS_CATEGORY_MEANING: Readonly<Record<string, string>> = {
  A0: "Acknowledgement forwarded to another entity",
  A1: "Acknowledgement receipt: claim received",
  A2: "Acknowledgement accepted for processing",
  A3: "Returned as unprocessable claim",
  A4: "Not found: claim not found on the payer's system",
  A6: "Rejected for missing information",
  A7: "Rejected for invalid information",
  A8: "Rejected for a relational field in error",
};

/** Plain-language meaning of one sanitised ack code (`A7:21` or a bare category). Null when not confidently known. */
export function explainAckCode(code: string): DdeKeyingReasonCode {
  const category = code.split(":")[0]?.toUpperCase() ?? "";
  return { code, meaning: STATUS_CATEGORY_MEANING[category] ?? null };
}

const SCREEN_HINT: Readonly<Record<DdeItemType, string>> = {
  noe: "FISS DDE hospice NOE entry (claims menu options 28 / 49 per ADR-0052). Key the election date and TOB 81A; the MAC's acceptance date is what stops the 5-day clock.",
  notr: "FISS DDE hospice NOTR entry (claims menu options 28 / 49 per ADR-0052). Key the effective end date and TOB 81B.",
  claim_entry:
    "FISS DDE hospice claim entry (claims menu). Key the claim header, then the revenue lines.",
  rtp_correction:
    "FISS DDE claim inquiry, then correction: find the claim at status/location T B9997 (returned to provider), fix the reason shown, and resubmit. A correction receives a new receipt date.",
  adjustment: "FISS DDE claim adjustment on the paid or rejected claim (claims menu).",
  cancel: "FISS DDE claim cancel on the paid claim (claims menu).",
  adr_response:
    "Respond to the additional documentation request through the MAC's ADR channel; DDE shows the ADR status on the claim.",
};

export function buildDdeKeyingSheet(
  itemType: DdeItemType,
  subject: {
    readonly notice?: DdeKeyingNotice;
    readonly claim?: DdeKeyingClaim;
    readonly provider?: DdeKeyingProvider | null;
  },
): DdeKeyingSheet {
  const screenHint = SCREEN_HINT[itemType];
  const { notice, claim, provider } = subject;
  const providerFields: DdeKeyingField[] = provider
    ? [
        { label: "Provider CCN", value: provider.ccn },
        { label: "Billing NPI", value: provider.npi },
      ]
    : [];
  if (notice) {
    const fields: DdeKeyingField[] = [
      { label: "Type of bill", value: notice.kind === "noe" ? "81A" : "81B" },
      {
        label: notice.kind === "noe" ? "Election / admission date" : "Effective end date",
        value: notice.effectiveDate,
      },
      { label: "Filing deadline (MAC acceptance)", value: notice.windowTargetAt },
      { label: "ChartWarden control number", value: notice.controlNumber },
      ...(notice.payerControlNumber
        ? [{ label: "Payer control number (DCN)", value: notice.payerControlNumber }]
        : []),
      ...providerFields,
    ];
    return { screenHint, fields, rejectionCodes: notice.rejectionCodes.map(explainAckCode) };
  }
  if (claim) {
    const fields: DdeKeyingField[] = [
      { label: "Type of bill", value: claim.tob },
      { label: "Statement from", value: claim.serviceFrom },
      { label: "Statement through", value: claim.serviceTo },
      { label: "ChartWarden control number", value: claim.controlNumber },
      ...(claim.payerControlNumber
        ? [{ label: "Payer claim control number (DCN/ICN)", value: claim.payerControlNumber }]
        : []),
      ...(claim.patientStatusCode
        ? [{ label: "Patient status", value: claim.patientStatusCode }]
        : []),
      ...(claim.admissionTypeCode
        ? [{ label: "Admission type", value: claim.admissionTypeCode }]
        : []),
      ...(claim.admissionSourceCode
        ? [{ label: "Admission source", value: claim.admissionSourceCode }]
        : []),
      ...providerFields,
    ];
    return { screenHint, fields, rejectionCodes: claim.rejectionCodes.map(explainAckCode) };
  }
  return { screenHint, fields: [], rejectionCodes: [] };
}
