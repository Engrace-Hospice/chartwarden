// @wardenx/billing — §4.5 rule `f2f_telehealth_g0679` (f2f, error, regulatory) + the pure G0679 line
// derivation claim assembly uses. CR 14495 (Pub 100-04 Transmittal 13944, MLN MM14495), Medicare Claims
// Processing Manual ch. 11 § 30.3, implementing 42 CFR 418.22(a)(4)(ii) as revised by CMS-1851-F: from
// dates of service 2027-01-01 a hospice reports each recertification face-to-face encounter conducted via
// telecommunications technology as a SEPARATELY DATED line, HCPCS G0679, revenue code 0657, on TOB 81X/82X.
// Source: docs/research/FY2027_HOSPICE_COP_RESEARCH.md §4.
//
// Business requirements enforced:
//   14495.1 — G0679 allowed on dates of service on/after 2027-01-01 (an earlier line is a defect).
//   14495.2 — RTP when the TOB is other than 81x / 82x.
//   14495.3 — RTP when reported with a revenue code other than 0657.
// Plus the reporting obligation itself (§ 418.22(a)(4)(ii) "must report ... on the claim"): every telehealth
// recert F2F with an encounter date in the claim span, on/after 2027-01-01, needs its G0679 line.
//
// UNCONFIRMED (research §4 / summary items 1, 2, 4): units, charge, benefit-period edit and modifier GV are
// NOT specified by CR 14495 or MM14495. The units/charge below are placeholders behind named constants; no
// benefit-period edit and no GV modifier are applied. TODO(CR 14495): confirm against the MAC's January 2027
// guidance and update the constants.
//
// PURE: reads ctx only.
import type { FaceToFaceSnapshot, Rule } from "./types";
import { fail, pass } from "./types";

const KEY = "f2f_telehealth_g0679";

/** HCPCS for a telehealth recertification F2F (CR 14495). */
export const G0679_HCPCS = "G0679";

/** The only revenue code G0679 may be reported on (BR 14495.3). */
export const G0679_REVENUE_CODE = "0657";

/** First date of service on which G0679 is allowed / required (BR 14495.1; § 418.22(a)(4)(ii)). */
export const G0679_EFFECTIVE_FROM = "2027-01-01";

/** The TOB prefixes G0679 is allowed on (BR 14495.2): 81X freestanding, 82X hospital-based hospice. */
export const G0679_ALLOWED_TOB_PREFIXES: readonly string[] = ["81", "82"];

/**
 * UNCONFIRMED — units per G0679 line. Neither CR 14495 nor MM14495 states units; one per encounter is the
 * research file's working assumption (FY2027_HOSPICE_COP_RESEARCH.md §4 "Units"). TODO(CR 14495): confirm.
 */
export const G0679_UNITS_PER_ENCOUNTER = 1;

/**
 * UNCONFIRMED — the G0679 line charge, in cents. The encounter is "an administrative expense" (not separately
 * paid) and the CR states no charge convention; $0.00 is the placeholder (FY2027_HOSPICE_COP_RESEARCH.md §4
 * "Charges"). TODO(CR 14495): confirm $0.00 vs a nominal charge with the MAC.
 */
export const G0679_UNIT_CHARGE_CENTS = 0;

/**
 * The encounter dates that need a G0679 line on a claim spanning [serviceFrom, serviceTo]: every TELEHEALTH
 * face-to-face whose encounter date is inside the span and on/after {@link G0679_EFFECTIVE_FROM}. In-person
 * encounters are never reported (CMS-1851-F). Sorted and de-duplicated by date — one separately dated line
 * per encounter date.
 */
export function telehealthF2fDatesRequiringG0679(
  faceToFace: readonly FaceToFaceSnapshot[],
  span: { readonly serviceFrom: string; readonly serviceTo: string },
): readonly string[] {
  const dates = new Set<string>();
  for (const f of faceToFace) {
    if (f.modality !== "telehealth" || f.encounterDate === null) continue;
    const d = f.encounterDate;
    if (d < G0679_EFFECTIVE_FROM || d < span.serviceFrom || d > span.serviceTo) continue;
    dates.add(d);
  }
  return [...dates].sort();
}

export const f2fTelehealthG0679: Rule = {
  key: KEY,
  version: 1,
  category: "f2f",
  title: "Telehealth face-to-face reported as G0679",
  description:
    "From dates of service 2027-01-01, each recertification face-to-face conducted via telehealth in the " +
    "claim span must be reported as a separately dated G0679 line on revenue code 0657, on TOB 81X/82X " +
    "(42 CFR §418.22(a)(4)(ii); CR 14495).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  check: (ctx) => {
    const defects: string[] = [];
    const g0679Lines = ctx.lines.filter((l) => l.hcpcs === G0679_HCPCS);

    for (const date of telehealthF2fDatesRequiringG0679(ctx.faceToFace, ctx.claim)) {
      const reported = g0679Lines.some(
        (l) => l.serviceDate === date && l.revenueCode === G0679_REVENUE_CODE,
      );
      if (!reported) defects.push(`${date}: telehealth face-to-face has no G0679/0657 line`);
    }
    for (const line of g0679Lines) {
      if (line.revenueCode !== G0679_REVENUE_CODE) {
        defects.push(
          `${line.serviceDate}: G0679 on revenue code ${line.revenueCode} (must be 0657)`,
        );
      }
      if (line.serviceDate < G0679_EFFECTIVE_FROM) {
        defects.push(
          `${line.serviceDate}: G0679 before its ${G0679_EFFECTIVE_FROM} effective date`,
        );
      }
    }
    if (
      g0679Lines.length > 0 &&
      !G0679_ALLOWED_TOB_PREFIXES.some((p) => ctx.claim.tob.startsWith(p))
    ) {
      defects.push(`G0679 reported on TOB ${ctx.claim.tob} (must be 81X or 82X)`);
    }

    if (defects.length === 0) {
      return pass(
        KEY,
        "error",
        "Every telehealth face-to-face in the span is reported as G0679/0657 on an 81X/82X claim.",
      );
    }
    return fail(
      KEY,
      "error",
      `${defects.length} G0679 telehealth face-to-face reporting defect(s).`,
      {
        summary:
          "Re-assemble the claim so each telehealth face-to-face carries a dated G0679 line on revenue code 0657, or correct the encounter modality in M6.",
        blameTarget: "claim_line",
        fixAction: "edit_claim",
      },
      { defectCount: defects.length, firstDefect: defects[0] ?? "" },
    );
  },
};
