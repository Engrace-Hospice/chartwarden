// apps/backend/src/modules/22-documents/render-pdf/election-statement-doc.ts — the `election_statement`
// template: M6's `m6.election.signed` payload → a {@link DocModel}. Pure. Replaces the stand-in bytes the
// statement rendered as until FY2027.
//
// Carries every element of 42 CFR 418.24(b) as amended by CMS-1851-F (effective 2026-10-01):
//   (b)(1) the hospice and the attending physician of the individual's choice (acknowledged as their choice)
//   (b)(2) palliative, not curative, care for the terminal illness and related conditions
//   (b)(3) the hospice's coverage responsibility and the Medicare services waived — including that services
//          unrelated to the terminal illness are exceptional and unusual and the hospice should provide
//          virtually all care needed
//   (b)(4) the effective date (the first day of hospice care or later, never before the statement's date)
//   (b)(5) individual cost sharing for hospice services
//   (b)(6) the individual WILL receive the "Patient Notification of Hospice Non-Covered Items, Services, and
//          Drugs" addendum (within 5 days of the effective date; updates within 3 days of a plan-of-care change)
//   (b)(7) BFCC-QIO information, the right to immediate advocacy, and how to contact it
//   (b)(8) the signature of the individual or representative
// The customer's paper form (version 4/18) lacked the (b)(3) "exceptional and unusual" language, (b)(5), (b)(6)
// and (b)(7); this template is the reason those can no longer be missing.
import { type Block, type DocModel, latestInstant } from "./doc-model";
import { ELECTION_ADDENDUM_DOC_TITLE } from "./election-addendum-doc";
import { fmtDate, rec, str } from "./shared";

export const ELECTION_STATEMENT_DOC_TITLE = "Medicare Hospice Election Statement";

export const ELECTION_TEXT = {
  b1: "I choose to receive hospice care from the hospice named above. I acknowledge that the attending physician named above is my choice. (If no attending physician is named, I have chosen not to have one.)",
  b2: "I have been given a full understanding that hospice care is palliative, not curative: it is meant to keep me comfortable and manage my pain and symptoms, as it relates to my terminal illness and related conditions.",
  b3: "I have been told about the hospice's coverage responsibility. By electing the Medicare hospice benefit I waive (give up) Medicare payment for care related to my terminal illness and related conditions except care from the hospice, care arranged by the hospice, and care from my attending physician. Services unrelated to my terminal illness and related conditions are exceptional and unusual: the hospice should be providing virtually all the care I need.",
  b4: "My election takes effect on the effective date shown above. That date may be the first day of hospice care or a later date, but not earlier than the date I sign this statement.",
  b5: "Cost sharing: I may owe a copayment of up to $5 for each outpatient prescription drug or similar product for pain relief and symptom control, and 5% of the Medicare-approved amount for inpatient respite care. I have been given the information about cost sharing for hospice services.",
  b6: `I will receive a written addendum titled "${ELECTION_ADDENDUM_DOC_TITLE}". It lists any conditions, items, services, and drugs the hospice has determined are unrelated to my terminal illness and related conditions and will not cover, and why. The hospice will give it to me within 5 days of the effective date of my election, and will give me an updated addendum within 3 days of any change to my plan of care that affects those determinations.`,
  b7: "If I have a concern about my hospice care or disagree with a hospice decision, I have the right to immediate advocacy from the Medicare Beneficiary and Family Centered Care Quality Improvement Organization (BFCC-QIO). Call 1-800-MEDICARE (1-800-633-4227; TTY 1-877-486-2048) or visit https://www.cms.gov/medicare/quality/quality-improvement-organizations/family-centered-care to find my BFCC-QIO and its contact information.",
} as const;

export function buildElectionStatementDoc(payload: unknown): DocModel {
  const p = rec(payload);
  const signerKind = str(p.signerKind);
  const blocks: Block[] = [
    { kind: "title", text: ELECTION_STATEMENT_DOC_TITLE },
    {
      kind: "facts",
      rows: [
        ["Hospice", str(p.hospiceName) ?? "______________________________"],
        [
          "Attending physician (my choice)",
          str(p.attendingPhysicianName) ?? "______________________________",
        ],
        ["Beneficiary", str(p.patientName) ?? "______________________________"],
        [
          "Effective date of election",
          p.effectiveDate ? fmtDate(p.effectiveDate) : "______________",
        ],
      ],
    },
    { kind: "heading", level: 1, text: "My hospice and my attending physician" },
    { kind: "paragraph", text: ELECTION_TEXT.b1 },
    { kind: "heading", level: 1, text: "Palliative care" },
    { kind: "paragraph", text: ELECTION_TEXT.b2 },
    { kind: "heading", level: 1, text: "What I give up and what the hospice covers" },
    { kind: "paragraph", text: ELECTION_TEXT.b3 },
    { kind: "heading", level: 1, text: "Effective date" },
    { kind: "paragraph", text: ELECTION_TEXT.b4 },
    { kind: "heading", level: 1, text: "My costs" },
    { kind: "paragraph", text: ELECTION_TEXT.b5 },
    { kind: "heading", level: 1, text: `Your addendum: "${ELECTION_ADDENDUM_DOC_TITLE}"` },
    { kind: "paragraph", text: ELECTION_TEXT.b6 },
    { kind: "heading", level: 1, text: "My right to immediate advocacy" },
    { kind: "paragraph", text: ELECTION_TEXT.b7 },
    { kind: "heading", level: 1, text: "Signature" },
    {
      kind: "facts",
      rows: [
        [
          "Signed by",
          signerKind === "representative"
            ? "Representative"
            : signerKind === "patient"
              ? "Beneficiary"
              : "______________________________",
        ],
        ["Name", str(p.patientName) ?? "______________________________"],
        ["Date signed", p.signedAt ? fmtDate(p.signedAt) : "______________"],
      ],
    },
  ];
  return {
    title: ELECTION_STATEMENT_DOC_TITLE,
    createdAtIso: latestInstant([
      typeof p.signedAt === "string" ? `${p.signedAt.slice(0, 10)}T12:00:00.000Z` : undefined,
    ]),
    blocks,
  };
}
