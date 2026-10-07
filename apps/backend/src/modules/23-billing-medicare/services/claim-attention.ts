// apps/backend/src/modules/23-billing-medicare/services/claim-attention.ts — what a biller must do about a claim
// because of how its stay ended, computed from M6's CURRENT stay-end facts (never from what was persisted at
// assembly). PURE: no I/O, no clock.
//
// Two conditions:
//   1. MISSING DISCHARGE DETAILS — the stay ended (on/before the claim's Through date) by a death with no place of
//      death, or a transfer-out with no receiving care setting: the patient status cannot be derived and the
//      `bereavement_discharge_legitimacy` rule blocks the claim. The fix is on the M6 record
//      (`/admissions/:id/discharge-details`), after which the claim is re-validated.
//   2. TYPE OF BILL CHANGED — the TOB the resolver derives today differs from the stored one. Claims assembled
//      before revocations and transfer-outs counted as the end of the stay were typed interim 812/813 where the
//      resolver now derives final 811/814. What to do depends on where the claim is:
//        - `revalidate`           (draft / validating / ready) — re-validation re-types it (claim-validation-service);
//        - `await_acknowledgment` (submitted / ack_pending)     — wait for the MAC's answer, then replace it;
//        - `replace`              (ack_accepted / ack_partial / paid) — build a TOB-817 replacement claim;
//        - `manual`               (partial_paid / denied)       — no replacement route from this state: adjust
//                                   the claim with the MAC directly (the manual step is stated in the UI).
//      Replaced / voided / rejected claims are superseded and never flagged.
import type { ClaimDischargeFact, TypeOfBill } from "@wardenx/billing";
import { deriveDischargeClaimCodes } from "@wardenx/billing";
import { rederivedTypeOfBill, resolveClaimDischarge } from "./claim-discharge";

/**
 * M6's batched stay-end facts (`claimStayEndFactsForOrg`), duplicated locally — the composition root binds the
 * port to the M6 function (the module's no-package-import posture for M6 bridges).
 */
export interface ClaimStayEndFactsRow {
  readonly admissionId: string;
  readonly dischargeDate: string | null;
  readonly dischargeReason: string | null;
  readonly dischargeEventId: string | null;
  readonly deceasedDate: string | null;
  readonly placeOfDeath: string | null;
  readonly transferOut: {
    readonly transferEventId: string;
    readonly effectiveDate: string;
    readonly receivingCareSetting: string | null;
  } | null;
  readonly revocationDate: string | null;
}

export interface ClaimStayEndFactsPort {
  forAdmissions(
    organizationId: string,
    admissionIds: readonly string[],
  ): Promise<readonly ClaimStayEndFactsRow[]>;
}

export type ClaimAttentionFlag = "missing_discharge_details" | "tob_changed";
export const CLAIM_ATTENTION_FLAGS: readonly ClaimAttentionFlag[] = [
  "missing_discharge_details",
  "tob_changed",
];
export type TobChangeRemedy = "revalidate" | "await_acknowledgment" | "replace" | "manual";

export interface ClaimAttentionView {
  /** How and when the stay ended, when that is on or before the claim's Through date; `null` otherwise. */
  readonly stayEnd: { readonly kind: string; readonly effectiveDate: string } | null;
  readonly typeOfBill: {
    readonly stored: string;
    /** The TOB the resolver derives today; `null` for a replacement / void (817/818). */
    readonly derived: TypeOfBill | null;
    readonly changed: boolean;
    /** What to do about a change; `null` when unchanged. */
    readonly remedy: TobChangeRemedy | null;
  };
  readonly missingDischargeDetail: {
    readonly detail: "place_of_death" | "receiving_care_setting";
    readonly admissionId: string;
    readonly dischargeEventId: string | null;
    readonly transferEventId: string | null;
    /** The guided M6 screen that records it. */
    readonly fixPath: string;
  } | null;
  readonly flags: readonly ClaimAttentionFlag[];
}

const SUPERSEDED = new Set(["replaced", "voided", "ack_rejected"]);

function remedyFor(state: string): TobChangeRemedy {
  if (state === "draft" || state === "validating" || state === "ready") return "revalidate";
  if (state === "submitted" || state === "ack_pending") return "await_acknowledgment";
  if (state === "ack_accepted" || state === "ack_partial" || state === "paid") return "replace";
  return "manual";
}

/** The stay-end fact M23's resolver reads, from the batched M6 row (the same `resolveClaimDischarge`). */
export function stayEndDischarge(facts: ClaimStayEndFactsRow): ClaimDischargeFact | null {
  return resolveClaimDischarge(
    {
      dischargeDate: facts.dischargeDate,
      dischargeReason: facts.dischargeReason,
      deceasedDate: facts.deceasedDate,
      placeOfDeath: facts.placeOfDeath,
      dischargeEventId: facts.dischargeEventId,
      transferOut: facts.transferOut,
    },
    facts.revocationDate === null ? [] : [{ revoked: true, revocationDate: facts.revocationDate }],
  );
}

export function claimAttention(
  claim: {
    readonly claimId: string;
    readonly admissionId: string;
    readonly tob: string;
    readonly state: string;
    readonly serviceTo: string;
  },
  facts: ClaimStayEndFactsRow | undefined,
): ClaimAttentionView {
  const none: ClaimAttentionView = {
    stayEnd: null,
    typeOfBill: { stored: claim.tob, derived: null, changed: false, remedy: null },
    missingDischargeDetail: null,
    flags: [],
  };
  if (!facts || SUPERSEDED.has(claim.state)) return none;

  const discharge = stayEndDischarge(facts);
  const ended = discharge !== null && discharge.effectiveDate <= claim.serviceTo;
  const derived = rederivedTypeOfBill(claim.tob, discharge, claim.serviceTo);
  const changed = derived !== null && derived !== claim.tob;
  const codes = deriveDischargeClaimCodes({ serviceTo: claim.serviceTo, discharge });
  const missing =
    codes.unresolved === "place_of_death_missing"
      ? ("place_of_death" as const)
      : codes.unresolved === "transfer_setting_missing"
        ? ("receiving_care_setting" as const)
        : null;
  const flags: ClaimAttentionFlag[] = [];
  if (missing) flags.push("missing_discharge_details");
  if (changed) flags.push("tob_changed");
  return {
    stayEnd:
      ended && discharge ? { kind: discharge.kind, effectiveDate: discharge.effectiveDate } : null,
    typeOfBill: {
      stored: claim.tob,
      derived,
      changed,
      remedy: changed ? remedyFor(claim.state) : null,
    },
    missingDischargeDetail: missing
      ? {
          detail: missing,
          admissionId: claim.admissionId,
          dischargeEventId: missing === "place_of_death" ? facts.dischargeEventId : null,
          transferEventId:
            missing === "receiving_care_setting"
              ? (facts.transferOut?.transferEventId ?? null)
              : null,
          fixPath: `/admissions/${claim.admissionId}/discharge-details?claimId=${claim.claimId}`,
        }
      : null,
    flags,
  };
}
