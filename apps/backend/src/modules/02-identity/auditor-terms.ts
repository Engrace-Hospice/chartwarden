// apps/backend/src/modules/02-identity/auditor-terms.ts — the versioned BAA / engagement terms an external
// auditor accepts before an engagement session can read anything (M2 §7.7, architecture §7.5 grant step 3).
//
// WHERE THE TEXT LIVES, AND WHY NOT M40. M40's `BaaStatusProvider` answers "does THIS TENANT hold an executed
// BAA with THAT master-data entity" (physician / facility / payer / pharmacy / ...) and gates PHI disclosures
// to such recipients; it has no concept of an individual's acceptance and an audit agency is not an MDM
// entity. So the acceptance cannot be filed there. The terms are a platform-owned, versioned document: the
// text below is what the auditor is shown, and the acceptance row (`auditor_baa_acceptance`) records its
// version AND the sha-256 of the exact text, so a later edit to this file can never be mistaken for what an
// auditor agreed to. Changing the text REQUIRES a new `version` (the unit test pins the hash to the version).
//
// LEGAL REVIEW: the wording is an engineering draft of the standard survey-access undertakings; it must be
// approved by counsel before production. Publishing a new approved text is a one-line version bump here.
import { createHash } from "node:crypto";

export interface AuditorTerms {
  readonly version: string;
  readonly title: string;
  readonly text: string;
  readonly sha256: string;
}

const TERMS_VERSION = "2026-10-v1";
const TERMS_TITLE = "Business associate and engagement access terms";
const TERMS_TEXT = [
  "These terms apply to you as an external auditor, surveyor or reviewer given time-limited, read-only access to the organization's records for one audit engagement.",
  "1. Purpose. You will use protected health information only to carry out the engagement you were enrolled for, and for no other purpose.",
  "2. Safeguards. You will keep your authenticator and recovery codes private, will not share your session, and will use only the access provided. You will not copy, export, photograph or transcribe protected health information except as the engagement strictly requires and the organization permits.",
  "3. Minimum necessary. You will view only the records the engagement covers. Access is limited to the engagement window and ends automatically when it closes or after a period of inactivity.",
  "4. Monitoring. Your access is logged, including the records you view and for how long, and the organization may review that log.",
  "5. Reporting. You will tell the organization without delay if you suspect that your access or any protected health information has been used or disclosed improperly.",
  "6. Return and destruction. When the engagement ends you will not retain protected health information in any form, and any permitted working copies will be destroyed.",
  "7. Confidentiality. These obligations continue after the engagement ends.",
  "By accepting you confirm that you have read these terms, that you act for the agency named in the engagement, and that you are bound by them under the organization's business associate arrangements.",
].join("\n\n");

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The terms currently in force. Immutable; the hash is computed from the exact text. */
export const CURRENT_AUDITOR_TERMS: AuditorTerms = Object.freeze({
  version: TERMS_VERSION,
  title: TERMS_TITLE,
  text: TERMS_TEXT,
  sha256: digest(TERMS_TEXT),
});

/** Pure: does the pair an auditor posted name the terms currently in force? */
export function isCurrentTerms(
  input: { readonly termsVersion: string; readonly termsSha256: string },
  terms: AuditorTerms = CURRENT_AUDITOR_TERMS,
): boolean {
  return input.termsVersion === terms.version && input.termsSha256 === terms.sha256;
}
