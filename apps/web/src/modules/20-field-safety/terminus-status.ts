// apps/web/src/modules/20-field-safety — GAP-032: plain-language status for the emergency-terminus effects.
//
// The ledger carries a closed vocabulary of reason codes (never a number, never PHI). This turns the latest
// row of each effect into the one line a supervisor reads at 3 a.m.: what happened, and - when it did not -
// the honest reason. Pure and DOM-free so the wording is unit-tested.

export type TerminusEffect = "page_ops" | "dial_contact" | "resolve_psap";

export interface TerminusActionLike {
  readonly actionKind: string;
  readonly loopIteration: number;
  readonly attemptNo: number;
  readonly status: string;
  readonly outcomeCode: string | null;
}

export type TerminusTone = "ok" | "pending" | "problem" | "neutral";

export interface TerminusLine {
  readonly effect: TerminusEffect;
  readonly label: string;
  readonly text: string;
  readonly tone: TerminusTone;
}

const EFFECT_LABEL: Readonly<Record<TerminusEffect, string>> = {
  page_ops: "ChartWarden operations page",
  dial_contact: "Emergency-contact call",
  resolve_psap: "PSAP lookup",
};

const REASON_TEXT: Readonly<Record<string, string>> = {
  consent_absent: "the clinician has not consented to an emergency-contact call",
  consent_unavailable: "consent could not be checked; retrying",
  consent_expired_or_revoked: "the clinician's consent was revoked or expired",
  contact_unreadable: "the stored contact could not be opened",
  number_invalid: "the stored number cannot be dialled",
  voice_unbound: "telephony is not configured on this deployment",
  dial_disabled: "automatic contact calls are switched off on this deployment",
  pager_unbound: "no ops pager is configured on this deployment",
  vendor_refused: "the carrier refused the call",
  receiver_non_2xx: "the ops receiver did not accept the page",
  timeout: "the ops receiver or carrier could not be reached",
  superseded_ack: "the alert was acknowledged first",
  possible_duplicate: "an earlier attempt may already have placed the call",
  jurisdiction_none: "no PSAP line is on file for this place",
  jurisdiction_unavailable: "the PSAP catalog could not be read",
};

const reason = (code: string | null): string => (code ? (REASON_TEXT[code] ?? code) : "");

function lineFor(effect: TerminusEffect, latest: TerminusActionLike | undefined): TerminusLine {
  const label = EFFECT_LABEL[effect];
  if (!latest) return { effect, label, text: "not yet recorded", tone: "neutral" };
  switch (latest.status) {
    case "succeeded":
      return {
        effect,
        label,
        tone: "ok",
        text:
          effect === "page_ops"
            ? "ops paged"
            : effect === "dial_contact"
              ? "call placed to the emergency contact"
              : "PSAP line resolved",
      };
    case "pending":
    case "attempting":
      return {
        effect,
        label,
        tone: "pending",
        text: latest.outcomeCode ? `in progress (${reason(latest.outcomeCode)})` : "in progress",
      };
    case "failed":
      return { effect, label, tone: "problem", text: `failed: ${reason(latest.outcomeCode)}` };
    case "skipped":
      return { effect, label, tone: "problem", text: `not done: ${reason(latest.outcomeCode)}` };
    case "superseded":
      return { effect, label, tone: "neutral", text: reason(latest.outcomeCode) };
    default:
      return { effect, label, tone: "neutral", text: latest.status };
  }
}

/** The latest row of each effect (highest loop iteration, then attempt) as a status line. */
export function describeTerminus(actions: readonly TerminusActionLike[]): TerminusLine[] {
  const latestOf = (kind: TerminusEffect): TerminusActionLike | undefined =>
    actions
      .filter((a) => a.actionKind === kind)
      .sort((a, b) => b.loopIteration - a.loopIteration || b.attemptNo - a.attemptNo)[0];
  return (["page_ops", "dial_contact", "resolve_psap"] as const).map((effect) =>
    lineFor(effect, latestOf(effect)),
  );
}
