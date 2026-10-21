// apps/backend/src/modules/22-documents/render-pdf/forms/revocation-form.ts - the `revocation` template: the
// signed statement revoking the hospice election (42 CFR 418.28). It states the revocation, the date it takes
// effect, and carries the beneficiary's (or representative's) signature and date.
import { assertRevocationRenderPayload } from "@chartwarden/types";
import { fmtDate, humanize } from "../shared";
import { defineForm } from "./compile";

export const REVOCATION_TEXT = {
  statement:
    "I revoke my election of Medicare hospice care for the remaining days in the current election period, effective on the date shown above. I understand that Medicare coverage of the benefits I waived when I elected hospice care resumes on that date, and that I may elect hospice care again at a later time.",
} as const;

export const REVOCATION_FORM_VERSION = "2.0.0";

export const revocationForm = defineForm({
  key: "revocation",
  version: REVOCATION_FORM_VERSION,
  title: "Revocation of Hospice Election",
  authority: "42 CFR 418.28",
  parse: assertRevocationRenderPayload,
  patient: (p) => p.patient,
  hospiceName: (p) => p.hospiceName,
  documentDate: (p) => p.revocation.signedAt,
  sections: [
    {
      id: "revocation_effective_date",
      kind: "fields",
      heading: "Revocation",
      cite: "42 CFR 418.28(c)",
      cells: (p) => [
        ["Effective date of revocation", fmtDate(p.effectiveDate)],
        ["Date signed", fmtDate(p.signedDate)],
        ["Signed by", p.signerKind === "representative" ? "Patient's representative" : "Patient"],
        ["Reason", humanize(p.reason)],
      ],
    },
    {
      id: "revocation_statement",
      kind: "legal",
      text: REVOCATION_TEXT.statement,
    },
    {
      id: "revocation_narrative",
      kind: "narrative",
      heading: "Additional information",
      text: (p) => p.narrative ?? undefined,
      emptyText: "None recorded.",
    },
  ],
  signatures: [
    {
      id: "beneficiary_signature_block",
      role: "Patient or representative",
      required: true,
      from: (p) => p.revocation,
    },
  ],
});
