// @wardenx/billing — §4.5 rule `election_addendum_signed` (election, regulatory). FY2027 (CMS-1851-F): the
// election statement addendum ("Patient Notification of Hospice Non-Covered Items, Services, and Drugs",
// 42 CFR 418.24(c)) is mandatory for every election effective on or after 2026-10-01, and MLN Connects
// (2026-10-01) makes it a condition for payment: "satisfied when there's a valid signed addendum in the
// beneficiary's medical record with the hospice".
//
// PASSES when any addendum version on file is
//   • signed (receipt acknowledged, 418.24(c)(9)), or
//   • refused with the reason documented on the addendum ((c)(9)), or
//   • documented as not required / signature not required because the patient died, revoked, or was
//     discharged ((d)(3)/(d)(4)), or
//   • furnished but unsigned AND the patient has since died / revoked / been discharged ((d)(4): "the addendum
//     would not be required to be signed in order for the hospice to receive payment").
//
// EFFECTIVE DATES are rule PARAMETERS (tenant-overlayable through the registry's parameter merge, so no new
// mechanism): `applyToElectionsFrom` (default 2026-10-01 — earlier elections pass, not in scope) and
// `enforceFrom` (default 2027-01-01). CMS announced enforcement discretion for 2026-10-01..2026-12-31
// ("MACs will not deny claims solely because the addendum is missing or incomplete"), so a failure is a
// non-blocking WARN while the claim's THROUGH date (`serviceTo`) is before `enforceFrom`, and a BLOCKING error
// from then on. The through date is the deliberate, conservative choice: a claim spanning the boundary
// (e.g. 2026-12-15..2027-01-14) is held to the enforced standard, because part of what it bills falls inside
// the enforced period. PURE: reads ctx + params only, no clock.
import type { Rule } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "election_addendum_signed";

/** 418.24(b)(6)/(c): elections effective on/after this date owe the addendum. */
export const ADDENDUM_APPLIES_TO_ELECTIONS_FROM = "2026-10-01";
/** End of CMS's enforcement-discretion window (MLN Connects 2026-10-01): claims block from this date. */
export const ADDENDUM_ENFORCE_FROM = "2027-01-01";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateParam = (v: unknown, fallback: string): string =>
  typeof v === "string" && ISO_DATE.test(v) ? v : fallback;

export const electionAddendumSigned: Rule = {
  key: KEY,
  version: 1,
  category: "election",
  title: "Election statement addendum signed (or exception documented)",
  description:
    "For elections effective on or after 2026-10-01, the 42 CFR 418.24(c) election statement addendum must be " +
    "signed, or its refusal or (d)(3)/(d)(4) exemption documented. Warn-only during CMS's enforcement " +
    "discretion (claim through date before 2027-01-01), blocking after.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "compliance_officer",
  defaultParameters: {
    applyToElectionsFrom: ADDENDUM_APPLIES_TO_ELECTIONS_FROM,
    enforceFrom: ADDENDUM_ENFORCE_FROM,
  },
  check: (ctx, params) => {
    const snap = ctx.electionAddendum;
    if (snap === undefined) {
      return skip(
        KEY,
        "error",
        "seam_not_bound",
        "The election addendum reader is not bound; the addendum could not be checked.",
      );
    }
    const appliesFrom = dateParam(params.applyToElectionsFrom, ADDENDUM_APPLIES_TO_ELECTIONS_FROM);
    const enforceFrom = dateParam(params.enforceFrom, ADDENDUM_ENFORCE_FROM);
    if (snap.electionEffectiveDate === null) {
      return skip(KEY, "error", "not_applicable", "The election has no effective date yet.");
    }
    if (snap.electionEffectiveDate < appliesFrom) {
      return pass(
        KEY,
        "error",
        `Election effective ${snap.electionEffectiveDate}, before ${appliesFrom}: the mandatory addendum does not apply.`,
      );
    }
    if (snap.anySigned) return pass(KEY, "error", "A signed election addendum is on file.");
    if (snap.anyRefusalDocumented) {
      return pass(KEY, "error", "The addendum refusal and its reason are documented.");
    }
    if (snap.anyExemptionDocumented) {
      return pass(
        KEY,
        "error",
        "The addendum is documented as not required (death, revocation, or discharge).",
      );
    }
    if (snap.anyFurnished && snap.leftCareReason !== null) {
      return pass(
        KEY,
        "error",
        "The addendum was furnished and the patient left hospice care before signing (42 CFR 418.24(d)(4)).",
      );
    }
    const enforced = ctx.claim.serviceTo >= enforceFrom;
    const severity = enforced ? "error" : "warn";
    const what = snap.anyFurnished
      ? "The election addendum was furnished but is not signed, and no refusal is documented."
      : "No election addendum has been furnished for this election.";
    return fail(
      KEY,
      severity,
      enforced
        ? what
        : `${what} (CMS enforcement discretion through ${enforceFrom}: not blocking yet.)`,
      {
        summary: snap.anyFurnished
          ? "Record the beneficiary's signature, a documented refusal, or the reason a signature is not required (M6 election addendum)."
          : "Furnish the election statement addendum (M6) and record its signature or refusal.",
        blameTarget: "admission",
        blameTargetId: ctx.claim.admissionId,
        fixAction: "edit_in_m6",
      },
      {
        enforced,
        versionCount: snap.versionCount,
        furnished: snap.anyFurnished,
      },
    );
  },
};
