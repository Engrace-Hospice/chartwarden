// apps/backend/src/modules/22-documents/render-pdf/triage-summary-doc.ts — F-224 (#248). The
// `triage_summary_caregiver` / `triage_summary_attending` templates: the `m19.triage.summary_requested`
// payload -> a {@link DocModel}. Pure.
//
// THE PAYLOAD IS AN ALLOWLIST, AND THIS BUILDER IS THE SECOND LOCK. M19's producer
// (`clinical/triage-summary.ts`) only ever puts enumerated facts on the wire — a disposition enum, a
// discipline token, instants/dates, a transport enum. This builder reads exactly those fields BY NAME and
// nothing else, so a producer bug that leaks a free-text field (`reason`, `educationSummary`, a transcript)
// or a SUD-class value onto the wire still cannot reach the PDF. It never prints the patient's name (the
// document is filed against the chart by `patient_id`; the caregiver copy is handed over by staff), and the
// caregiver variant never prints internal identifiers (membership ids, the call id).
import { type Block, type DocModel, latestInstant } from "./doc-model";
import { fmtDate, fmtInstant, humanize, rec, shortId, str } from "./shared";

export const TRIAGE_SUMMARY_CAREGIVER_TITLE = "After-Hours Call Summary";
export const TRIAGE_SUMMARY_ATTENDING_TITLE = "After-Hours Triage Summary (Attending)";

/** What the on-call clinician's disposition means, in plain language for the family. Fixed text keyed on the
 *  closed disposition enum — never the clinician's own words. */
const CAREGIVER_OUTCOME: Readonly<Record<string, string>> = {
  caregiver_education_only:
    "The nurse gave you guidance by phone and no visit was needed at this time. Please keep following the instructions you were given.",
  prn_intervention_authorized:
    "The nurse authorised a comfort medication that was already part of the care plan. Please give it only as instructed.",
  verbal_order_recorded:
    "The nurse obtained a new instruction from the physician. The care team will confirm it with you.",
  visit_dispatched_now: "A member of the care team is being sent to see the patient now.",
  visit_scheduled_first_light:
    "A visit from the care team has been scheduled for the next available morning time.",
  gip_admission_proposed:
    "The care team has proposed a short stay in an inpatient hospice unit for symptom control. They will contact you to discuss it.",
  ed_transfer_acknowledged:
    "You chose to have the patient taken to the emergency department. The hospice team has been informed.",
  pronouncement_scheduled:
    "A nurse is being sent to be with you and to care for the patient after the death. We are so sorry for your loss.",
};

/** The summary's factual rows — only the allowlisted fields, only when present. */
function factRows(p: Readonly<Record<string, unknown>>): Array<readonly [string, string]> {
  const rows: Array<readonly [string, string]> = [];
  const discipline = str(p.requestedDiscipline);
  if (discipline !== undefined) rows.push(["Care team member", humanize(discipline)]);
  const arrival = str(p.requestedArrivalBy);
  if (arrival !== undefined) rows.push(["Expected by", fmtInstant(arrival)]);
  const date = str(p.proposedForDate);
  if (date !== undefined) rows.push(["Planned for", fmtDate(date)]);
  const transport = str(p.transportArrangedBy);
  if (transport !== undefined) rows.push(["Transport arranged by", humanize(transport)]);
  return rows;
}

/** Build the caregiver- or attending-facing summary. `recipient` is fixed by the TEMPLATE the render
 *  consumer resolved (never re-read off the payload here, so one variant can never render the other's view). */
function buildTriageSummaryDoc(payload: unknown, recipient: "caregiver" | "attending"): DocModel {
  const p = rec(payload);
  const disposition = str(p.disposition);
  const opened = str(p.callOpenedAt);
  const blocks: Block[] = [];
  const title =
    recipient === "caregiver" ? TRIAGE_SUMMARY_CAREGIVER_TITLE : TRIAGE_SUMMARY_ATTENDING_TITLE;

  blocks.push({
    kind: "title",
    text: title,
    subtitle: opened !== undefined ? `Call received ${fmtInstant(opened)}` : undefined,
  });

  if (recipient === "caregiver") {
    blocks.push({ kind: "heading", level: 1, text: "What happened" });
    blocks.push({
      kind: "paragraph",
      text:
        (disposition !== undefined ? CAREGIVER_OUTCOME[disposition] : undefined) ??
        "The on-call nurse reviewed your call. The care team will follow up with you.",
    });
    const rows = factRows(p);
    if (rows.length > 0) {
      blocks.push({ kind: "heading", level: 1, text: "Details" });
      blocks.push({ kind: "facts", rows });
    }
    blocks.push({
      kind: "banner",
      tone: "info",
      text: "If the patient's symptoms change or you have any worry, call the hospice's 24-hour line again at any time.",
    });
    blocks.push({
      kind: "paragraph",
      muted: true,
      text: "This summary does not replace the instructions the nurse gave you by phone.",
    });
  } else {
    blocks.push({ kind: "heading", level: 1, text: "Call outcome" });
    blocks.push({
      kind: "facts",
      rows: [
        ["Call reference", shortId(p.triageCallId)],
        ["Call received", fmtInstant(opened)],
        ["Disposition", humanize(disposition)],
        ...factRows(p),
        ["Requested by", shortId(p.requestedByMembershipId)],
        ["Requested at", fmtInstant(p.occurredAt)],
      ],
    });
    blocks.push({
      kind: "paragraph",
      muted: true,
      text: "Enumerated call facts only. The clinical narrative, protocol answers and medication detail live in the encounter note and are not reproduced here.",
    });
  }

  return {
    title,
    createdAtIso: latestInstant([p.occurredAt, p.callOpenedAt]),
    blocks,
  };
}

export const buildTriageSummaryCaregiverDoc = (payload: unknown): DocModel =>
  buildTriageSummaryDoc(payload, "caregiver");
export const buildTriageSummaryAttendingDoc = (payload: unknown): DocModel =>
  buildTriageSummaryDoc(payload, "attending");
