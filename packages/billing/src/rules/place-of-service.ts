import { paramStringMap } from "./_util";
// @wardenx/billing — §4.5 rule `place_of_service_consistency` (pos, error, regulatory). Each line's
// Q-code must match the patient's documented place of service (home / ALF / SNF / IPU) per the M5/M40
// facility lookup; place-of-service changes must be documented with effective dates (M6). Reads the
// resolved `mdm.placeOfService` + line Q-codes; SKIPs when the M40 resolver is unbound. PURE: reads ctx.
import type { Rule } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "place_of_service_consistency";

/**
 * CMS hospice Q-code → eligible place(s) of service (the §4.5 default mapping; tenant-overridable). The
 * Q-codes describe where hospice care is furnished:
 *   Q5001 patient home/residence · Q5002 assisted-living facility · Q5003 long-term-care / nursing
 *   facility (non-SNF) · Q5004 skilled-nursing facility · Q5005 inpatient hospital · Q5006 inpatient
 *   hospice facility · Q5007 long-term care hospital · Q5008 inpatient psychiatric · Q5009 place N.O.S. ·
 *   Q5010 hospice home care furnished in a hospice facility.
 *
 * THE authoritative table (F-125, #251) — `claim-assembly.ts`'s own Q-code DERIVATION reads this map
 * inverted rather than carrying an independently-authored copy. It used to carry one: `qCodeForPlaceOfService`
 * assigned `snf`→Q5003 (this table's own `ltc`), `ipu`→Q5005 (this table's own `hospital`), `hospital`→Q5008
 * (this table's own `psych`), and defaulted an UNKNOWN place to Q5006 ("inpatient hospice facility") under a
 * doc comment that called Q5006 "unspecified" — CMS's actual catch-all is Q5009 ("place N.O.S."), so an
 * unassessed patient's line was asserting a specific, wrong site of care rather than admitting the site was
 * unknown. One shared table is what makes that class of drift impossible from here on.
 */
export const POS_BY_QCODE: Readonly<Record<string, string>> = {
  Q5001: "home",
  Q5002: "alf",
  Q5003: "ltc",
  Q5004: "snf",
  Q5005: "hospital",
  Q5006: "ipu",
  Q5007: "ltch",
  Q5008: "psych",
  Q5009: "nos",
  Q5010: "hospice_home",
};

/** Synonyms `claim-assembly.ts`'s Q-code derivation accepts for a place already named above, so a second
 *  spelling never needs a second entry in {@link POS_BY_QCODE} (F-125, #251). */
export const POS_LABEL_ALIASES: Readonly<Record<string, string>> = {
  assisted_living: "alf",
  nf: "snf",
  inpatient_unit: "ipu",
  hospice_facility: "ipu",
};

export const placeOfServiceConsistency: Rule = {
  key: KEY,
  version: 1,
  category: "pos",
  title: "Place-of-service / Q-code consistency",
  description:
    "Each line's Q-code must match the patient's documented place of service (home/ALF/SNF/IPU) per the " +
    "M5/M40 facility lookup; place-of-service changes must be documented with effective dates (M6).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  defaultParameters: { placeByQCode: POS_BY_QCODE },
  check: (ctx, params) => {
    if (!ctx.seams.mdmResolverBound) {
      return skip(
        KEY,
        "error",
        "seam_not_bound",
        "MDM/facility resolver (M40) not bound — POS check deferred.",
      );
    }
    const documentedPos = ctx.mdm.placeOfService;
    if (documentedPos === null) {
      return fail(KEY, "error", "The patient's documented place of service is unknown.", {
        summary: "Record the patient's place of service (M5/M6) before billing.",
        blameTarget: "patient",
        blameTargetId: ctx.claim.patientId,
        fixAction: "edit_in_m6",
      });
    }
    const placeByQCode = paramStringMap(params, "placeByQCode", POS_BY_QCODE);
    const mismatches: string[] = [];
    for (const line of ctx.lines) {
      if (line.qCode === null) continue; // not every line carries a site-of-service Q-code
      const expectedPos = placeByQCode[line.qCode];
      if (expectedPos === undefined) {
        mismatches.push(`${line.serviceDate}: unknown Q-code ${line.qCode}`);
      } else if (expectedPos !== documentedPos) {
        mismatches.push(
          `${line.serviceDate}: Q-code ${line.qCode} (${expectedPos}) ≠ documented ${documentedPos}`,
        );
      }
    }
    if (mismatches.length === 0) {
      return pass(
        KEY,
        "error",
        `Every line's Q-code matches the documented place of service (${documentedPos}).`,
      );
    }
    return fail(
      KEY,
      "error",
      `${mismatches.length} line(s) have a Q-code / place-of-service mismatch.`,
      {
        summary:
          "Correct the line Q-code or document the place-of-service change with effective dates (M6).",
        blameTarget: "claim_line",
        fixAction: "edit_in_m6",
      },
      { mismatchCount: mismatches.length, firstMismatch: mismatches[0] ?? "", documentedPos },
    );
  },
};
