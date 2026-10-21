// apps/backend/src/modules/20-field-safety/lifecycle/sos-escalator.ts — M20-T03 (§2.2.2, §4.8
// `m20.sos-sla-watchdog.cron`, D7, M20-F05 / S13 / INT-031).
//
// The decision half of the 15-second SLA watchdog: given one alert, the instant its current state began, the
// policy version pinned on it and the clock, say what — if anything — is due. Pure and total, so the whole
// escalation ladder is testable without a timer and without a database.
//
// THE POLICY IS THE ONE PINNED ON THE ROW, NOT TODAY'S. Every alert carries `safety_policy_version_id`
// (§3.3); a tenant that tightens its tier SLAs at 03:10 must not retroactively re-time the alert that has
// been escalating since 03:05. The caller resolves the pinned version through
// `SafetyPolicyProvider.policyAtTime` (§4.3) and hands the result here.
//
// THREE THINGS THIS FILE DECIDES THAT THE SPEC LEAVES OPEN:
//
//   1. THE TIER-3 → TERMINUS DWELL AND THE TERMINUS LOOP PERIOD BOTH REUSE `sosTier3SlaSeconds`. §2.2.2
//      says tier 3 enters the terminus on "tier-3 SLA breach" and that the terminus "keeps re-escalating on
//      a loop", but the policy has three tier knobs and no fourth. Reusing tier 3 keeps the cadence a tenant
//      already chose for its most urgent rung; inventing a constant would make the loudest alarm in the
//      system the one nobody can tune.
//
//   2. A STALE CANCEL WINDOW IS SWEPT HERE. The 5-second `cancel_window_open → acknowledging` step is
//      ordinarily a delayed job scheduled at the press — and migration 0110's `ssa_sla_scan_idx` covers
//      `acknowledging` and the four escalation states and NOT `cancel_window_open`, so if that job is ever
//      lost (a Valkey restart in the §2.7 degraded table) the alert sits in an open cancel window forever
//      and the ladder never starts. The sweep below closes it, scanning through `ssa_org_active_idx` (which
//      does cover every non-terminal state) rather than the SLA index. A five-second timer must not be the
//      only thing standing between a press and its escalation chain.
//
//   3. `acknowledged` AND `resolving` ARE QUIET. A human answered; the ladder's job is done and re-paging
//      them would train responders to ignore the channel. The chain re-arms only if the alert is escalated
//      manually (`escalateSos(reasonCode: 'manual')`), which is a supervisor's deliberate act.
import type { IsoInstant, SafetyPolicyEffectiveDto, SafetySosLifecycleState } from "@chartwarden/types";
import type { SafetySideEffect } from "./effects";
import {
  type SafetySosAlertFacts,
  type SafetySosTransition,
  escalateSos,
  expireCancelWindow,
  repageTerminus,
} from "./sos-alert";

/** What the watchdog should do with one alert this tick. */
export type SafetySosWatchdogDecision =
  /** Nothing is due. `nextDueAt` is when something will be (null when the alert is quiet or terminal), so
   *  the worker can log a horizon instead of "no action" fifteen times a minute. */
  | { readonly kind: "none"; readonly nextDueAt: IsoInstant | null }
  /** Advance one rung — including the rung INTO `emergency_terminus`. */
  | { readonly kind: "escalate"; readonly transition: SafetySosTransition }
  /** M20-F05 — one more turn of the terminus loop. NOT a transition: the state does not move. */
  | {
      readonly kind: "terminus_repage";
      readonly loopIteration: number;
      readonly effects: ReadonlyArray<SafetySideEffect>;
    }
  /** Header note 2 — the lost-delayed-job sweep. */
  | { readonly kind: "expire_cancel_window"; readonly transition: SafetySosTransition };

/** §2.2.2 — the dwell (seconds) an alert may sit in `state` before the next rung is due. `null` means the
 *  state is not on a timer at all. */
export function sosTierDwellSeconds(
  state: SafetySosLifecycleState,
  policy: Pick<
    SafetyPolicyEffectiveDto,
    "sosTier1SlaSeconds" | "sosTier2SlaSeconds" | "sosTier3SlaSeconds"
  >,
): number | null {
  switch (state) {
    case "acknowledging":
      return policy.sosTier1SlaSeconds;
    case "escalation_tier_1":
      return policy.sosTier2SlaSeconds;
    case "escalation_tier_2":
      return policy.sosTier3SlaSeconds;
    // Header note 1 — no tier-4 knob exists; tier 3 governs both the terminus entry and the terminus loop.
    case "escalation_tier_3":
    case "emergency_terminus":
      return policy.sosTier3SlaSeconds;
    default:
      return null;
  }
}

/** M20-F05 — which turn of the terminus loop `now` falls in. 1 is the first RE-page (the terminus entry
 *  itself is iteration 0 and was emitted by `escalateSos`), so a consumer counting pages never sees two
 *  events claiming to be the same one. */
export function terminusLoopIteration(input: {
  readonly terminusEnteredAt: IsoInstant;
  readonly nowIso: IsoInstant;
  readonly loopSeconds: number;
}): number {
  const elapsed = (Date.parse(input.nowIso) - Date.parse(input.terminusEnteredAt)) / 1000;
  if (!Number.isFinite(elapsed) || input.loopSeconds <= 0) return 0;
  return Math.max(0, Math.floor(elapsed / input.loopSeconds));
}

/**
 * §4.8 `m20.sos-sla-watchdog.cron` — the per-alert decision.
 *
 * `stateEnteredAt` is the `transitioned_at` of the alert's most recent `safety_sos_alert_state_history` row
 * (the press's own row for an alert that has never moved). It is passed in rather than derived from
 * `posted_at` because the ladder measures from TIER ENTRY, and an alert that spent four minutes in
 * `acknowledging` before tier 1 must not have those minutes counted twice.
 */
export function decideSosWatchdog(input: {
  readonly alert: SafetySosAlertFacts;
  readonly stateEnteredAt: IsoInstant;
  readonly policy: SafetyPolicyEffectiveDto;
  readonly nowIso: IsoInstant;
  /** D10 — carried through to the terminus effects; `false` means there is nobody to auto-dial, which is
   *  itself a fact the §4.10 payload reports. */
  readonly emergencyContactConsent: boolean;
  /** M20-F05 — the instant the alert ENTERED `emergency_terminus`, from its state-history row. Required
   *  only while the alert is in the terminus. */
  readonly terminusEnteredAt?: IsoInstant | null;
}): SafetySosWatchdogDecision {
  const { alert, policy, nowIso } = input;
  const now = Date.parse(nowIso);

  // Header note 2 — the sweep. Runs before the dwell logic because these two states have no dwell.
  if (alert.lifecycleState === "raised" || alert.lifecycleState === "cancel_window_open") {
    if (now >= Date.parse(alert.cancelWindowExpiredAt)) {
      return {
        kind: "expire_cancel_window",
        transition: expireCancelWindow({ alert, at: nowIso }),
      };
    }
    return { kind: "none", nextDueAt: alert.cancelWindowExpiredAt };
  }

  const dwellSeconds = sosTierDwellSeconds(alert.lifecycleState, policy);
  if (dwellSeconds === null) return { kind: "none", nextDueAt: null };

  const dueAtMs = Date.parse(input.stateEnteredAt) + dwellSeconds * 1000;
  if (now < dueAtMs) return { kind: "none", nextDueAt: new Date(dueAtMs).toISOString() };

  if (alert.lifecycleState === "emergency_terminus") {
    const enteredAt = input.terminusEnteredAt ?? input.stateEnteredAt;
    const loopIteration = terminusLoopIteration({
      terminusEnteredAt: enteredAt,
      nowIso,
      loopSeconds: dwellSeconds,
    });
    return {
      kind: "terminus_repage",
      loopIteration,
      effects: repageTerminus({
        alert,
        loopIteration,
        emergencyContactConsent: input.emergencyContactConsent,
      }),
    };
  }

  return {
    kind: "escalate",
    transition: escalateSos({
      alert,
      reasonCode: "sla_breach",
      at: nowIso,
      emergencyContactConsent: input.emergencyContactConsent,
    }),
  };
}
