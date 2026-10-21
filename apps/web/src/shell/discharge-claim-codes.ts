// apps/web/src/shell/discharge-claim-codes.ts — the plain-language vocabulary M6 (admission) and M23 (billing) share
// for the discharge-driven parts of a Medicare hospice claim (CMS Pub. 100-04 Ch. 11 §30.3): the patient status a
// place of death (40/41/42) or a receiving care setting (50/51) sets, how the stay ended, and how the Type of Bill
// follows from it. Web modules may not import each other, so the shared wording lives here.

export type PlaceOfDeathValue = "home" | "facility" | "unknown";
export type ReceivingCareSettingValue = "home" | "facility";
export type MissingDischargeDetail = "place_of_death" | "receiving_care_setting";

export interface ClaimCodeChoice<V extends string> {
  readonly value: V;
  readonly label: string;
  /** UB-04 FL 17 patient discharge status the choice sets. */
  readonly status: string;
  readonly hint: string;
}

export const PLACE_OF_DEATH_CHOICES: readonly ClaimCodeChoice<PlaceOfDeathValue>[] = [
  { value: "home", label: "At home", status: "40", hint: "Patient status 40 — expired at home." },
  {
    value: "facility",
    label: "In a facility",
    status: "41",
    hint: "Patient status 41 — expired in a hospital, nursing facility or hospice facility.",
  },
  {
    value: "unknown",
    label: "Place not known",
    status: "42",
    hint: "Patient status 42 — expired, place unknown. Use only when the place truly cannot be determined.",
  },
];

export const RECEIVING_CARE_SETTING_CHOICES: readonly ClaimCodeChoice<ReceivingCareSettingValue>[] =
  [
    {
      value: "home",
      label: "At home",
      status: "50",
      hint: "Patient status 50 — discharged to hospice, home.",
    },
    {
      value: "facility",
      label: "In a facility",
      status: "51",
      hint: "Patient status 51 — discharged to hospice, medical facility (e.g. a nursing home).",
    },
  ];

/** The record field a missing detail lives on, in words. */
export function missingDetailNoun(detail: MissingDischargeDetail): string {
  return detail === "place_of_death" ? "place of death" : "receiving care setting";
}

/**
 * Why the final claim is blocked, in plain language — the same sentence on the claim and on the admission.
 */
export function missingDetailExplanation(detail: MissingDischargeDetail): string {
  return detail === "place_of_death"
    ? "CMS requires the patient status on the final claim. This death was recorded before ChartWarden captured " +
        "the place of death, so billing cannot set the status (40 home, 41 facility, 42 place unknown) and " +
        "the claim is held."
    : "CMS requires the patient status on the final claim. This transfer was recorded before ChartWarden captured " +
        "where the receiving hospice cares for the patient, so billing cannot set the status (50 home, " +
        "51 facility) and the claim is held.";
}

/** The guided M6 screen that records a missing detail (optionally returning to a claim). */
export function dischargeDetailsPath(admissionId: string, claimId?: string | null): string {
  const base = `/admissions/${encodeURIComponent(admissionId)}/discharge-details`;
  return claimId ? `${base}?claimId=${encodeURIComponent(claimId)}` : base;
}

/** How the stay ended, as a phrase ("by revocation", "by death", ...). */
export function stayEndPhrase(kind: string): string {
  switch (kind) {
    case "death":
      return "by the patient's death";
    case "revocation":
      return "by revocation";
    case "transfer":
      return "by transfer to another hospice";
    case "moved_out_of_service_area":
      return "by a move out of the service area";
    case "no_longer_terminal":
      return "by discharge (no longer terminally ill)";
    case "for_cause":
      return "by a for-cause discharge";
    default:
      return "by discharge";
  }
}

const TOB_MEANING: Record<string, string> = {
  "811": "Final claim (admission through discharge)",
  "812": "Interim claim — first of the stay",
  "813": "Interim claim — continuing",
  "814": "Final claim — last of the stay",
  "817": "Replacement of a prior claim",
  "818": "Void / cancel of a prior claim",
};

/** "Final claim — last of the stay" etc. */
export function tobMeaning(tob: string): string {
  return TOB_MEANING[tob] ?? `Type of bill ${tob}`;
}

const formatDate = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
};

/**
 * How a Type of Bill follows from the stay: "Final claim — the stay ended by revocation on 03/20/2026." or
 * "Interim claim — the patient was still on service on the claim's Through date."
 */
export function tobDerivationSentence(
  tob: string,
  stayEnd: { readonly kind: string; readonly effectiveDate: string } | null,
): string {
  if (tob === "817" || tob === "818") return `${tobMeaning(tob)}.`;
  if (stayEnd) {
    return `Final claim — the stay ended ${stayEndPhrase(stayEnd.kind)} on ${formatDate(stayEnd.effectiveDate)}.`;
  }
  return "Interim claim — the patient was still on service on the claim's Through date.";
}

export { formatDate as formatClaimDate };
