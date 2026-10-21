// apps/backend/src/modules/22-documents/render-pdf/forms/operational-forms.ts - the operational documents M22
// draws (GAP-033 Wave 4): the caregiver visit-confirmation reminder, the EVV verification record, the DSAR export
// transmittal sheet and the tenant-export cover letter. Their producers (M17, M18, M34) already ship the whole
// content, so the fixed wording below is deliberately limited to what the payload proves: a visit is scheduled
// for an instant, a submission was accepted, an archive has a digest. None of them states coverage, a verification
// outcome beyond acceptance, or a legal conclusion. They carry no patient identity by design (the payload holds an
// id, never a name), so each is a patient-independent sheet with a constant title; ids print shortened.
import {
  assertDsarBundleRenderPayload,
  assertEvvVerificationRenderPayload,
  assertTenantExportCoverRenderPayload,
  assertVisitConfirmationRenderPayload,
} from "@chartwarden/types";
import { fmtInstant, shortId } from "../shared";
import { defineForm } from "./compile";

export const OPERATIONAL_FORM_VERSION = "1.0.0";

export const OPERATIONAL_TEXT = {
  visitConfirmation:
    "This is a reminder that a hospice visit is scheduled to begin at the time shown. If the time does not work, contact the hospice care team as soon as possible so the visit can be rescheduled.",
  evv: "This record confirms that the electronic visit verification submission identified below was accepted by the state aggregator on the date shown. It records acceptance only.",
  dsarSheet:
    "This sheet accompanies the data export prepared for a patient access request. It records the export reference, the integrity digest of the archive and whether Part 2 redaction was applied. To confirm the archive is complete and unaltered, compute the SHA-256 digest of the file received and compare it with the value below.",
  dsarPart2Applied:
    "42 CFR Part 2 redaction was applied to the export: substance use disorder treatment records the patient has not consented to release were excluded.",
  dsarPart2NotRecorded:
    "No Part 2 redaction was recorded for this export. The export contains no record that was withheld under 42 CFR Part 2.",
  tenantExport:
    "This letter accompanies the whole-organization data archive prepared at the organization's request. To confirm the archive is complete and unaltered, compute the SHA-256 digest of the file received and compare it with the value below.",
} as const;

const CHANNEL_LABELS: Readonly<Record<string, string>> = { sms: "Text message", email: "Email" };

export const visitConfirmationForm = defineForm({
  key: "visit_confirmation",
  version: OPERATIONAL_FORM_VERSION,
  title: "Visit Confirmation Reminder",
  authority: "M17 caregiver reminder",
  parse: assertVisitConfirmationRenderPayload,
  patient: () => null,
  hospiceName: () => null,
  documentDate: (p) => p.scheduledStartedAt,
  sections: [
    { id: "reminder_statement", kind: "legal", text: OPERATIONAL_TEXT.visitConfirmation },
    {
      id: "visit_details",
      kind: "fields",
      heading: "Visit",
      cells: (p) => [
        ["Scheduled start", fmtInstant(p.scheduledStartedAt)],
        ["Visit reference", shortId(p.visitId)],
        ["Reminder sent by", CHANNEL_LABELS[p.channel] ?? p.channel],
      ],
    },
  ],
  signatures: [],
});

export const evvVerificationForm = defineForm({
  key: "evv_verification",
  version: OPERATIONAL_FORM_VERSION,
  title: "Electronic Visit Verification Record",
  authority: "21st Century Cures Act s.12006 EVV; M18 aggregator submission",
  parse: assertEvvVerificationRenderPayload,
  patient: () => null,
  hospiceName: () => null,
  documentDate: (p) => p.acceptedAt,
  sections: [
    { id: "verification_statement", kind: "legal", text: OPERATIONAL_TEXT.evv },
    {
      id: "submission_details",
      kind: "fields",
      heading: "Submission",
      cells: (p) => [
        ["Submission reference", shortId(p.submissionId)],
        ["Visit reference", shortId(p.visitId)],
        ["State", p.stateCode],
        ["Aggregator transaction", p.aggregatorTransactionId ?? "Not assigned by the aggregator"],
        ["Accepted", fmtInstant(p.acceptedAt)],
      ],
    },
  ],
  signatures: [],
});

export const dsarBundleForm = defineForm({
  key: "dsar_bundle",
  version: OPERATIONAL_FORM_VERSION,
  title: "Patient Data Export - Transmittal Sheet",
  authority: "45 CFR 164.524 right of access; M34 DSAR export",
  parse: assertDsarBundleRenderPayload,
  patient: () => null,
  hospiceName: () => null,
  // The worker's request carries no instant of its own; the sheet states none rather than read the clock.
  documentDate: () => null,
  sections: [
    { id: "transmittal_statement", kind: "legal", text: OPERATIONAL_TEXT.dsarSheet },
    {
      id: "export_details",
      kind: "fields",
      heading: "Export",
      cells: (p) => [
        ["Export reference", shortId(p.aggregateId)],
        ["Archive SHA-256", p.bundleSha256],
      ],
    },
    {
      id: "part2_statement",
      kind: "banner",
      tone: "info",
      message: (p) =>
        p.partTwoRedactionApplied
          ? OPERATIONAL_TEXT.dsarPart2Applied
          : OPERATIONAL_TEXT.dsarPart2NotRecorded,
    },
  ],
  signatures: [],
});

export const tenantExportCoverForm = defineForm({
  key: "tenant_export_cover_letter",
  version: OPERATIONAL_FORM_VERSION,
  title: "Organization Data Export - Cover Letter",
  authority: "M34 tenant export",
  parse: assertTenantExportCoverRenderPayload,
  patient: () => null,
  hospiceName: () => null,
  documentDate: () => null,
  sections: [
    { id: "cover_statement", kind: "legal", text: OPERATIONAL_TEXT.tenantExport },
    {
      id: "export_details",
      kind: "fields",
      heading: "Export",
      cells: (p) => [
        ["Export reference", shortId(p.aggregateId)],
        ["Archive SHA-256", p.bundleSha256],
      ],
    },
  ],
  signatures: [],
});
