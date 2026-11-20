// The web app does not depend on @chartwarden/assessments, so wound-labels.ts holds its own copy of the vocabulary. This
// suite runs from the repo root, where the package resolves, and fails when either copy moves alone: a code added,
// renamed or reordered, a site added, or a site's sides changed.
import {
  EXUDATE_AMOUNTS,
  EXUDATE_TYPES,
  WOUND_SITES as PACKAGE_SITES,
  PERIWOUND_CONDITIONS,
  PRESSURE_STAGES,
  WOUND_ACQUIRED,
  WOUND_BED_TISSUES,
  WOUND_CORRECTION_REASONS,
  WOUND_DRESSINGS,
  WOUND_ETIOLOGIES,
  WOUND_LATERALITIES,
  WOUND_ODORS,
  WOUND_RESOLUTIONS,
  WOUND_STATUSES,
  WOUND_TRENDS,
  lateralityFitsSite as packageFits,
  siteLabel as packageSiteLabel,
} from "@chartwarden/assessments";
import { describe, expect, it } from "vitest";
import {
  ACQUIRED_LABELS,
  CORRECTION_REASON_LABELS,
  DRESSING_LABELS,
  ETIOLOGY_LABELS,
  EXUDATE_AMOUNT_LABELS,
  EXUDATE_TYPE_LABELS,
  LATERALITY_LABELS,
  ODOR_LABELS,
  PERIWOUND_LABELS,
  RESOLUTION_LABELS,
  STAGE_LABELS,
  STATUS_LABELS,
  TREND_LABELS,
  WOUND_BED_LABELS,
  WOUND_SITES,
  lateralitiesFor,
  lateralityFitsSite,
  siteHeading,
  siteLabel,
} from "./wound-labels";
import type { WoundSiteCode } from "./wounds-api";

describe("wound labels cover exactly the server's value sets, in the server's order", () => {
  it.each([
    ["etiology", ETIOLOGY_LABELS, WOUND_ETIOLOGIES],
    ["pressure stage", STAGE_LABELS, PRESSURE_STAGES],
    ["wound bed", WOUND_BED_LABELS, WOUND_BED_TISSUES],
    ["exudate amount", EXUDATE_AMOUNT_LABELS, EXUDATE_AMOUNTS],
    ["exudate type", EXUDATE_TYPE_LABELS, EXUDATE_TYPES],
    ["odor", ODOR_LABELS, WOUND_ODORS],
    ["periwound", PERIWOUND_LABELS, PERIWOUND_CONDITIONS],
    ["dressing", DRESSING_LABELS, WOUND_DRESSINGS],
    ["trend", TREND_LABELS, WOUND_TRENDS],
    ["laterality", LATERALITY_LABELS, WOUND_LATERALITIES],
    ["acquired", ACQUIRED_LABELS, WOUND_ACQUIRED],
    ["status", STATUS_LABELS, WOUND_STATUSES],
    ["resolution", RESOLUTION_LABELS, WOUND_RESOLUTIONS],
    ["correction reason", CORRECTION_REASON_LABELS, WOUND_CORRECTION_REASONS],
  ] as const)("%s", (_name, labels, codes) => {
    expect(Object.keys(labels)).toEqual([...codes]);
    for (const label of Object.values(labels)) expect(label.trim()).not.toBe("");
  });
});

describe("the site vocabulary equals packages/assessments", () => {
  it("lists the same sites in the same order with the same names and sides", () => {
    expect(WOUND_SITES.map((s) => ({ ...s }))).toEqual(PACKAGE_SITES.map((s) => ({ ...s })));
  });

  it("builds the same display phrase for every site and side", () => {
    for (const site of PACKAGE_SITES) {
      for (const side of WOUND_LATERALITIES) {
        expect(siteLabel(site.code, side)).toBe(packageSiteLabel(site.code, side));
      }
    }
  });

  it("accepts the same sides for every site, in the server's order", () => {
    for (const { code } of PACKAGE_SITES) {
      // The package types a site code as a plain string; the generated client's union is what the form takes.
      const site = code as WoundSiteCode;
      const accepted = WOUND_LATERALITIES.filter((side) => packageFits(site, side));
      expect(lateralitiesFor(site)).toEqual(accepted);
      for (const side of WOUND_LATERALITIES) {
        expect(lateralityFitsSite(site, side)).toBe(packageFits(site, side));
      }
    }
  });

  it("capitalises a heading without changing the phrase", () => {
    expect(siteHeading("heel", "left")).toBe("Left heel");
    expect(siteHeading("sacrum", "midline")).toBe("Sacrum");
    expect(siteHeading("heel", "bilateral")).toBe("Bilateral heels");
  });
});
