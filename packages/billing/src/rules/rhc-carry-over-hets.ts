import { paramNumber } from "./_util";
// @wardenx/billing — rule `rhc_carry_over_hets_fresh` (hipps, WARN, NON-regulatory). The two-tier RHC split
// (days 1–60 high, 61+ low) continues across a readmission within 60 days of ANY prior hospice discharge,
// including days at another hospice (Claims Processing Manual ch. 11 §30.2; CR 9201 / R3326CP). Medicare
// counts those days from CWF; we only see other hospices' days through the HETS 271 history. When the
// patient was readmitted within 60 days and the HETS check is missing or older than `maxAgeDays`, the
// high/low split on this claim may not match Medicare's — a warning, never a block. PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "rhc_carry_over_hets_fresh";

export const rhcCarryOverHetsFresh: Rule = {
  key: KEY,
  version: 1,
  category: "hipps",
  title: "RHC day count across a readmission is confirmed by a recent HETS check",
  description:
    "A readmission within 60 days of a prior hospice discharge carries the earlier hospice days (any hospice) " +
    "into the RHC high/low split. Without a HETS check from the last 30 days, days at another hospice may be " +
    "missing and the split may differ from Medicare's (warning, tenant-configurable).",
  severity: "warn",
  regulatoryRequired: false,
  overrideRoleRequired: "billing_manager",
  defaultParameters: { maxAgeDays: 30 },
  check: (ctx, params) => {
    const carry = ctx.rhcCarryOver ?? null;
    if (carry === null) {
      return skip(KEY, "warn", "not_applicable", "RHC carry-over not materialized for this claim.");
    }
    const maxAgeDays = paramNumber(params, "maxAgeDays", 30);
    const basisNote = `${carry.priorDays} prior hospice day(s) carried (basis: ${carry.basis}).`;
    if (!carry.readmittedWithin60Days) {
      return pass(
        KEY,
        "warn",
        `No readmission within 60 days of a prior hospice stay. ${basisNote}`,
      );
    }
    const age = carry.hetsCheckAgeDays;
    if (age !== null && age <= maxAgeDays) {
      return pass(KEY, "warn", `HETS check is ${age} day(s) old (≤ ${maxAgeDays}). ${basisNote}`);
    }
    return fail(
      KEY,
      "warn",
      age === null
        ? `Readmitted within 60 days of a prior hospice stay, but no HETS eligibility check is on file: the RHC high/low split may be wrong. ${basisNote}`
        : `Readmitted within 60 days of a prior hospice stay, but the HETS check is ${age} day(s) old (> ${maxAgeDays}): the RHC high/low split may be wrong. ${basisNote}`,
      {
        summary:
          "Re-run the HETS eligibility check so days at other hospices are counted, then re-validate the claim.",
        blameTarget: "patient",
        blameTargetId: ctx.claim.patientId,
        fixAction: "refresh_eligibility",
      },
      {
        priorDays: carry.priorDays,
        basis: carry.basis,
        hetsCheckAgeDays: age ?? -1,
        maxAgeDays,
      },
    );
  },
};
