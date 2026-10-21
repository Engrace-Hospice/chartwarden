import { InlineAlert, Panel, StatusPill } from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — the guided "how the stay ended" panels billers see on a claim:
//   * MissingDischargeDetailsPanel — the final claim is held because the death has no place of death / the transfer
//     no receiving care setting (the bereavement_discharge_legitimacy rule's PLACE_OF_DEATH_MISSING /
//     RECEIVING_CARE_SETTING_MISSING). Explains why in plain language, lists the values with the patient status
//     each sets, and links to the M6 guided screen ("Fix discharge details") — by URL, web modules never import
//     each other.
//   * TypeOfBillPanel — the claim's Type of Bill and how it follows from the stay ("Final claim — the stay ended by
//     revocation on 03/20/2026"), and, when the TOB derived today differs from the stored one (claims assembled
//     before revocations / transfer-outs ended the stay), what to do for the claim's state: re-run validation
//     (unsubmitted), wait for the acknowledgment then replace (submitted), build a TOB-817 replacement
//     (accepted / paid), or adjust it with the MAC directly (no replacement route from that state).
// Both read the claim read's `attention` block (GET /api/v1/billing/claims[/:id]), computed server-side from M6's
// live stay-end facts.
import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  type MissingDischargeDetail,
  PLACE_OF_DEATH_CHOICES,
  RECEIVING_CARE_SETTING_CHOICES,
  dischargeDetailsPath,
  formatClaimDate,
  missingDetailExplanation,
  missingDetailNoun,
  stayEndPhrase,
  tobDerivationSentence,
  tobMeaning,
} from "../../shell/discharge-claim-codes";

export type TobChangeRemedy = "revalidate" | "await_acknowledgment" | "replace" | "manual";

/** The `attention` block on a claim list item / detail (services/claim-attention.ts). */
export interface ClaimAttention {
  stayEnd: { kind: string; effectiveDate: string } | null;
  typeOfBill: {
    stored: string;
    derived: string | null;
    changed: boolean;
    remedy: TobChangeRemedy | null;
  };
  missingDischargeDetail: {
    detail: MissingDischargeDetail;
    admissionId: string;
    dischargeEventId: string | null;
    transferEventId: string | null;
    fixPath: string;
  } | null;
  flags: readonly ("missing_discharge_details" | "tob_changed")[];
}

/** The two defect codes the guided panel resolves (bereavement_discharge_legitimacy v3). */
export const MISSING_DETAIL_DEFECTS: Record<string, MissingDischargeDetail> = {
  PLACE_OF_DEATH_MISSING: "place_of_death",
  RECEIVING_CARE_SETTING_MISSING: "receiving_care_setting",
};

export function MissingDischargeDetailsPanel({
  detail,
  admissionId,
  claimId,
  fixPath,
}: {
  detail: MissingDischargeDetail;
  admissionId: string;
  claimId: string;
  fixPath?: string | null;
}): JSX.Element {
  const choices =
    detail === "place_of_death" ? PLACE_OF_DEATH_CHOICES : RECEIVING_CARE_SETTING_CHOICES;
  const noun = missingDetailNoun(detail);
  return (
    <Panel
      title="Claim held: missing discharge details"
      icon="alert-circle"
      className="wx-discharge-attention"
    >
      <div style={{ display: "grid", gap: "0.75rem" }}>
        <p style={textStyle}>{missingDetailExplanation(detail)}</p>
        <div>
          <p style={{ ...textStyle, fontWeight: 600, color: "var(--color-on-surface)" }}>
            Record the {noun} — one of:
          </p>
          <ul aria-label={`${noun} choices`} style={listStyle}>
            {choices.map((c) => (
              <li key={c.value} style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
                <StatusPill label={c.status} tone="neutral" />
                <span style={textStyle}>
                  <strong style={{ color: "var(--color-on-surface)" }}>{c.label}</strong> —{" "}
                  {c.hint.replace(/^Patient status \d+ — /, "")}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p style={textStyle}>
          The {noun} is recorded on the admission's discharge record (clinical staff with the
          discharge permission can save it). The claim is re-validated afterwards.
        </p>
        <div>
          <Link
            to={fixPath || dischargeDetailsPath(admissionId, claimId)}
            className="wx-btn-primary"
          >
            Fix discharge details
          </Link>
        </div>
      </div>
    </Panel>
  );
}

/** The remedy a changed TOB calls for, as one plain paragraph (and the action, when the screen offers one). */
function remedyText(
  remedy: TobChangeRemedy,
  state: string,
  derived: string,
): { text: string; tone: "info" | "error" } {
  switch (remedy) {
    case "revalidate":
      return {
        tone: "info",
        text: `This claim has not been submitted. Re-run validation and the type of bill is updated to ${derived} automatically.`,
      };
    case "await_acknowledgment":
      return {
        tone: "info",
        text: `This claim was already submitted with the old type of bill. A replacement claim (TOB 817) is needed to correct it, and a submitted claim can be replaced only after the MAC accepts it: wait for the acknowledgment, then use Replace.`,
      };
    case "replace":
      return {
        tone: "error",
        text: `This claim was submitted with the old type of bill. Build a replacement claim (TOB 817): it re-sends the claim with the correct final-claim coding (type of bill ${derived} and the discharge patient status).`,
      };
    default:
      return {
        tone: "error",
        text: `This claim is ${state.replace(/_/g, " ")}, a state ChartWarden cannot build a replacement from. Correct it with the MAC directly (an adjustment in the MAC portal or DDE) using type of bill ${derived}, and note the correction on the claim.`,
      };
  }
}

export function TypeOfBillPanel({
  tob,
  state,
  attention,
  action,
}: {
  tob: string;
  state: string;
  attention: ClaimAttention | null | undefined;
  /** The button for the remedy (Re-run validation / Replace), supplied by the screen that can perform it. */
  action?: ReactNode;
}): JSX.Element {
  const t = attention?.typeOfBill;
  const changed = Boolean(t?.changed && t.derived && t.remedy);
  const stayEnd = attention?.stayEnd ?? null;
  return (
    <Panel title="Type of bill" icon="receipt" className="wx-tob-panel">
      <div style={{ display: "grid", gap: "0.6rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{tob}</span>
          <span style={textStyle}>{tobMeaning(tob)}</span>
        </div>
        {attention ? (
          <p style={textStyle}>
            {changed
              ? `Recorded as ${tobMeaning(tob).toLowerCase()} when the claim was assembled.`
              : tobDerivationSentence(tob, stayEnd)}
          </p>
        ) : null}
        {changed && t?.derived && t.remedy ? (
          <div style={{ display: "grid", gap: "0.5rem" }} aria-label="Type of bill changed">
            <InlineAlert tone={remedyText(t.remedy, state, t.derived).tone}>
              <strong>
                Type of bill changed: {tob} → {t.derived}.
              </strong>{" "}
              {stayEnd
                ? `The stay ended ${stayEndPhrase(stayEnd.kind)} on ${formatClaimDate(stayEnd.effectiveDate)}, so this is now a ${tobMeaning(t.derived).toLowerCase()}. ChartWarden used to bill revocations and transfers to another hospice as interim claims (812/813); they are final claims (811/814).`
                : `The patient is now still on service on this claim's Through date, so this is a ${tobMeaning(t.derived).toLowerCase()}.`}{" "}
              {remedyText(t.remedy, state, t.derived).text}
            </InlineAlert>
            {action ? <div>{action}</div> : null}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

const textStyle = {
  margin: 0,
  fontSize: "0.8125rem",
  color: "var(--color-on-surface-variant)",
} as const;
const listStyle = {
  listStyle: "none",
  margin: "0.4rem 0 0",
  padding: 0,
  display: "grid",
  gap: "0.35rem",
} as const;
