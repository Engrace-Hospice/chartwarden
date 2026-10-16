// M25 milestone 6a - the guided manual-submission checklist. PURE and deterministic. The steps are channel-NEUTRAL on
// purpose: no portal URL, field name, file format or fax number of any MAC, QIC or esMD gateway is hardcoded (none is
// verified; per-MAC instructions are an open item). The MAC name, the deadline and the packet come from the case.
import type { SubmissionPurpose } from "./submission";

export interface GuidedStep {
  readonly key: string;
  readonly text: string;
}

const WHAT: Readonly<Record<SubmissionPurpose, string>> = {
  adr_response: "ADR response",
  appeal_request: "appeal request",
  reopening_request: "reopening request",
  qic_escalation_request: "escalation request",
};

export function buildGuidedChecklist(input: {
  readonly purpose: SubmissionPurpose;
  readonly macName: string | null;
  readonly deadline: string | null;
}): readonly GuidedStep[] {
  const what = WHAT[input.purpose];
  const to = input.macName ? ` to ${input.macName}` : "";
  const by = input.deadline ? ` Deadline on the case: ${input.deadline}.` : "";
  return [
    {
      key: "download_packet",
      text: `Download the retained ${what} packet from the case and keep that copy as filed.`,
    },
    {
      key: "file_through_channel",
      text: `File the ${what}${to} through the channel the MAC or QIC instructs for this case.${by}`,
    },
    {
      key: "record_confirmation",
      text: "Copy the confirmation or tracking reference exactly as the channel shows it. Never enter a Medicare number.",
    },
    {
      key: "upload_receipt",
      text: "Save a copy of the receipt or confirmation page in the patient record and select it when you record the receipt.",
    },
    {
      key: "confirm_time",
      text: "Confirm the date and time the channel shows as received.",
    },
  ];
}
