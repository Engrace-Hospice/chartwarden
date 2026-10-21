// @chartwarden/assessments — PPS (Palliative Performance Scale v2) scorer (§4.3, §7.1).
//
// PPS is read off the published v2 matrix by "leftward reading": ambulation is the primary band
// determinant, then the remaining columns refine within that band to the best-fit level. The score is
// always a multiple of 10 in [0,100]. Disease-evidence (100 vs 90) is not a captured item — a hospice
// capture always carries disease, so a `normal`-activity / `full`-ambulation row resolves to 90 (the
// "some evidence of disease" row), never 100. §7.1's reference capture (`mainly_sit_lie`) scores 50.
import type { PpsData } from "../../scale-types";
import type { ScaleScorer } from "../scorer";

/** Leftward-reading best-fit: ambulation sets the band, the other columns refine within it (PPS v2). */
function ppsLevel(d: PpsData): number {
  switch (d.ambulation) {
    case "full":
      // 80–100 band. `normal` activity ⇒ 90 ("some disease"); reduced/limited effort ⇒ 80.
      return d.activity === "normal" ? 90 : 80;
    case "reduced":
      // 60–70 band. Occasional assistance, or unable to do hobby/house work ⇒ 60; else 70.
      return d.selfCare === "occasional_assist" || d.activity === "unable_hobby_work" ? 60 : 70;
    case "mainly_sit_lie":
      return 50;
    case "mainly_in_bed":
      return 40;
    case "totally_bed_bound":
      // 10–30 band, refined by oral intake (the only column that distinguishes 30/20/10 in v2).
      if (d.intake === "mouth_care_only") return 10;
      if (d.intake === "minimal_to_sips") return 20;
      return 30;
  }
}

export const ppsScorer: ScaleScorer<PpsData> = {
  scaleType: "pps",
  scoreRange: [0, 100],
  score: ppsLevel,
  interpret(d) {
    const l = ppsLevel(d);
    const band =
      l >= 80
        ? "ambulatory, self-care intact"
        : l >= 60
          ? "reduced ambulation, occasional assistance"
          : l >= 40
            ? "mainly sit/lie to bed, considerable assistance"
            : "bed-bound, total care";
    return `PPS ${l}% — ${band}`;
  },
};
