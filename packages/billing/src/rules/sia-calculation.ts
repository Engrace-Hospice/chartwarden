// @chartwarden/billing — §4.5 rule `sia_calculation_correct` (sia, error, regulatory), version 2. Medicare prices the
// Service Intensity Add-on from the CLAIM'S visit lines (RN G0299 / social-work G0155 on routine-home-care days in the
// last 7 days of life), never from our encounters, so on a claim that ends in the patient's death the units our engine
// counts and the units the lines carry must AGREE, in both directions:
//   - lines > counted: a telephonic, video, unconfirmed or undocumented visit is billed as an in-person line and the MAC
//     would pay it as SIA (an overpayment we would have asserted);
//   - counted > lines: the expected payment promises an add-on the MAC cannot see.
// The window is re-derived HERE from the claim's own date of death (never trusted from the producer), and the rule runs
// on any death claim, including one whose snapshot has no SIA (an in-person line the engine did not count). PURE.
//
// v1 compared the encounters' discipline against uppercase "RN"/"MSW" while M8 stores lowercase `rn`/`msw`, so it
// failed every real SIA claim; v2 compares no discipline at all (the shared engine already decided eligibility).
import { addDaysIso, isWithinInclusive } from "../domain/dates";
import {
  SIA_MAX_UNITS_PER_DAY,
  SIA_WINDOW_DAYS,
  siaAmountCents,
  siaUnitsFromLines,
} from "../sia/sia-units";
import type { Rule, SiaSnapshot } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "sia_calculation_correct";

/** Patient discharge status codes that mean the patient died (UB-04 FL 17): home, facility, unknown place. */
const DEATH_STATUS_CODES: ReadonlySet<string> = new Set(["40", "41", "42"]);

/** Defects of a payable SIA snapshot taken on its own (independent of the lines). */
function snapshotDefects(
  sia: SiaSnapshot,
  window: { readonly from: string; readonly to: string } | null,
): string[] {
  const defects: string[] = [];
  if (sia.doubleCounted) defects.push("SIA is double-counted with another adjustment");
  if (sia.paidUnits <= 0) defects.push("SIA present but pays zero units");
  if (sia.days.some((d) => d.paidUnits > SIA_MAX_UNITS_PER_DAY)) {
    defects.push(`SIA pays more than ${SIA_MAX_UNITS_PER_DAY} units on a day`);
  }
  if (window !== null && (sia.window.from !== window.from || sia.window.to !== window.to)) {
    defects.push("SIA window is not the last 7 days of life ending on the date of death");
  }
  if (window !== null && sia.days.some((d) => !isWithinInclusive(d.date, window.from, window.to))) {
    defects.push("SIA counts units outside the last 7 days of life");
  }
  if (sia.days.reduce((total, d) => total + d.paidUnits, 0) !== sia.paidUnits) {
    defects.push("SIA per-day units do not add up to the total");
  }
  if (sia.amountCents !== siaAmountCents(sia.paidUnits, sia.chcHourlyRateCents)) {
    defects.push("SIA amount is not units x CHC hourly rate / 4");
  }
  return defects;
}

export const siaCalculationCorrect: Rule = {
  key: KEY,
  version: 2,
  category: "sia",
  title: "Service Intensity Add-on calculated correctly",
  description:
    "On a claim that ends in the patient's death, the RN (G0299) / social-work (G0155) visit lines in the last 7 " +
    "days of life must carry exactly the units the Service Intensity Add-on counts (in-person, documented, routine " +
    "home care days, 16 units a day, amount = units x CHC hourly / 4), because Medicare pays the add-on from those " +
    "lines (CMS ch. 11 §30.2.2).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  check: (ctx) => {
    const { deathDate, serviceTo, dischargeClaimCodes } = ctx.claim;
    const sia = ctx.sia?.present ? ctx.sia : null;
    const diedOnThisClaim =
      deathDate != null &&
      deathDate <= serviceTo &&
      DEATH_STATUS_CODES.has(dischargeClaimCodes.patientStatus ?? "");
    // The window comes from the claim's own date of death, never from the snapshot being verified.
    const window =
      deathDate != null
        ? { from: addDaysIso(deathDate, -(SIA_WINDOW_DAYS - 1)), to: deathDate }
        : null;
    const lineUnits = siaUnitsFromLines(ctx.lines, window).paidUnits;
    const claimedUnits = sia?.paidUnits ?? 0;

    if (sia === null && !(diedOnThisClaim && lineUnits > 0)) {
      // No SIA on this claim and no SIA-coded visit line that would earn one (not a death claim, or no payable visit).
      return skip(KEY, "error", "not_applicable", "No SIA add-on present on this claim.");
    }

    const defects: string[] = [];
    if (sia !== null) {
      if (!deathDate) {
        defects.push("SIA present but the claim carries no date of death");
      } else if (deathDate > serviceTo) {
        defects.push("SIA present but the date of death is after the claim's service-to date");
      }
      if (!DEATH_STATUS_CODES.has(dischargeClaimCodes.patientStatus ?? "")) {
        defects.push("SIA present but the patient status is not a death status (40/41/42)");
      }
      defects.push(...snapshotDefects(sia, window));
      if (claimedUnits > lineUnits) {
        defects.push(
          `SIA counts ${claimedUnits} unit(s) but the claim's RN/social-work visit lines carry only ${lineUnits}`,
        );
      }
    }
    if ((sia !== null || diedOnThisClaim) && lineUnits > claimedUnits) {
      defects.push(
        `the claim's RN/social-work visit lines carry ${lineUnits} SIA-eligible unit(s) in the last 7 days of life but only ${claimedUnits} qualify: a telephonic, video, unconfirmed or undocumented visit must not be billed as an in-person visit line`,
      );
    }

    if (defects.length === 0) {
      return pass(
        KEY,
        "error",
        `SIA pays ${claimedUnits} unit(s), backed by the claim's visit lines.`,
      );
    }
    return fail(
      KEY,
      "error",
      `SIA calculation has ${defects.length} defect(s).`,
      {
        summary:
          "For each RN/social-work visit in the last 7 days, confirm in its encounter how it was delivered and that its start/stop times are documented, then re-validate. If a visit turns out to be telephonic or video, re-assemble the claim so its visit line is dropped (re-assembling alone rebuilds the same line while the delivery mode is unconfirmed). Also check the death status and date of death.",
        blameTarget: "claim",
        blameTargetId: ctx.claim.claimId,
        fixAction: "reassemble_claim",
      },
      {
        defectCount: defects.length,
        firstDefect: defects[0] ?? "",
        claimedUnits,
        lineUnits,
      },
    );
  },
};
