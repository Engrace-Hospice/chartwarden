// apps/web/src/modules/08-encounters/next-visit — what a plan and next-visit entry usually covers, each item with the SOURCE it rests on
// and what kind of source that is, so a reader can tell a requirement from guidance from a habit. Prompts only: nothing here is required of
// a note, and the regulatory items are requirements on the hospice's plan of care or services, offered here as things the entry can connect to.
//
// Every item is traced, with URL, section and retrieval date, in docs/research/HOSPICE_VISIT_PLAN_AND_NEXT_VISIT_RESEARCH.md
// (retrieved 2026-11-24). Nothing that could not be sourced is here: no federal rule sets a minimum visit frequency or a note format, and
// none is claimed. The clinical wording needs a clinician's sign-off before release.

export type GuideBasis = "regulation" | "guidance" | "guideline" | "practice";

export const PLAN_ENTRY_GUIDE_BASIS_LABEL: Readonly<Record<GuideBasis, string>> = {
  regulation: "Medicare rule",
  guidance: "CMS guidance",
  guideline: "Guideline",
  practice: "Common practice",
};

export interface PlanEntryGuideItem {
  readonly id: string;
  readonly text: string;
  readonly basis: GuideBasis;
  readonly source: string;
}

export const PLAN_ENTRY_GUIDE: readonly PlanEntryGuideItem[] = [
  {
    id: "next-visit",
    text: "The next visit: who will come, when (a date or a window) and what it is for, and that the patient and caregiver know.",
    basis: "practice",
    source:
      "agency documentation standards list the next planned visit (no rule requires it in each note); CMS State Operations Manual, Appendix M: surveyors ask whether the patient and caregiver know the visit schedule",
  },
  {
    id: "on-schedule",
    text: "Whether visits are on the schedule the plan of care orders, and for a visit that was missed or moved, why and what was done.",
    basis: "guidance",
    source:
      "CMS State Operations Manual, Appendix M, record review under 42 CFR 418.56 and 418.64; NHPCO Standards of Practice, PFC 5.1",
  },
  {
    id: "follows-plan",
    text: "That the care you plan follows the plan of care, and any change you think the plan needs (proposed in the plan-of-care step below).",
    basis: "regulation",
    source: "42 CFR 418.56(b) and (e)(2)",
  },
  {
    id: "symptoms",
    text: "Symptoms you treated and when you will check the result (no single interval is set). After a moderate or severe symptom rating at admission or at the HOPE update visit, an in-person follow-up visit is expected within two calendar days.",
    basis: "guidance",
    source:
      "HOPE Guidance Manual v1.03, section 1.3.3 (quality reporting, not a condition of participation); NCP Guidelines 4th ed., 2.2.4: timely reassessment after treatment",
  },
  {
    id: "wounds",
    text: "If a wound was assessed: wounds are usually reassessed weekly and when the patient's condition worsens; if there is no improvement after 2 to 4 weeks, review the plan.",
    basis: "guideline",
    source:
      "HPNA Palliative Wound Care resource guide; AAWC pressure ulcer guideline of guidelines (2010)",
  },
  {
    id: "orders",
    text: "Drugs, treatments, medical supplies or equipment still needed or pending, and whether the family can get them and use them safely.",
    basis: "regulation",
    source: "42 CFR 418.56(c)(4) and (5); NCP Guidelines 4th ed., 1.3.7 (guideline)",
  },
  {
    id: "teaching",
    text: "Teaching given to the patient and caregiver for their part in the care, and how well they understood it (asking them to say it back in their own words).",
    basis: "regulation",
    source:
      "42 CFR 418.56(b) and (c)(6); AHRQ Health Literacy Toolkit, Tool 5, teach-back (common practice, not required in hospice)",
  },
  {
    id: "sharing",
    text: "Who else has been told what you found (the physician, the other disciplines), and how the patient and caregiver reach the hospice at any hour.",
    basis: "regulation",
    source:
      "42 CFR 418.56(e)(4); 418.100(c)(2): nursing, physician services and drugs available 24 hours a day, 7 days a week; NHPCO Standards of Practice, PFC 1.5",
  },
  {
    id: "aide-supervision",
    text: "For a patient with a hospice aide, when the RN's on-site supervisory visit is due (at least every 14 days).",
    basis: "regulation",
    source: "42 CFR 418.76(h)(1)(i)",
  },
];
