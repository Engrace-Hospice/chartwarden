// apps/backend/src/modules/20-field-safety/lifecycle/sos-alert.ts — M20-T03 (§2.2.2, §2.3, §2.5, §2.6,
// D5, §7.4, §7.5).
//
// THE SOS MACHINE. Thirteen states, eight commands, and three properties that are each easy to lose:
//
//   1. THE FAN-OUT HAPPENS AT THE PRESS, NOT AT THE END OF THE CANCEL WINDOW. §2.2.2's diagram labels
//      `acknowledging` "5-sec window expires; fan-out begins", but D5 says the SOS is "single-press
//      fire-immediate", §7.4 has the voice call dialed at ~+800 ms (i.e. INSIDE the window, which is why
//      the cancel has to issue a Twilio suppression at all), and §9.7 budgets 300 ms round-trip for the
//      raise. Deferring the fan-out to +5 s would put a five-second delay into a life-safety path to save a
//      handful of suppressible pages. So `raiseSosEffects` emits `sos_alert_raised` immediately, and
//      `acknowledging` is what it actually is: the state in which the SLA ladder starts running.
//
//   2. A REJECTED CANCEL DOES NOT MOVE THE LIFECYCLE. §2.2.2's diagram draws
//      `cancel_window_open → cancel_attempted_but_rejected`; §7.4 says in words that "`lifecycle_state`
//      stays `cancel_window_open`; at the 5-sec mark it advances to `acknowledging`", and migration 0110's
//      CHECK was written to that reading (M20-T02). The tiebreak is not editorial — migration 0110's
//      `ssa_sla_scan_idx` covers `acknowledging` and the four escalation states and NOTHING else, so an
//      alert parked in a `cancel_attempted_but_rejected` LIFECYCLE would never be scanned by the SLA
//      watchdog: the hostile-actor SOS, the one scenario the state exists for, would silently stop
//      escalating. The rejection is recorded on `cancel_status` (+ the forensics event) and the alert
//      proceeds exactly as if no cancel had happened.
//
//   3. `acknowledge` IS LEGAL FROM EVERY PRE-ACKNOWLEDGED OPEN STATE. §2.2.2's diagram draws the edge only
//      from `acknowledging` and `escalation_tier_3`; a machine that copied it would 409 the supervisor who
//      picks up at tier 1 — and the alert would keep escalating past a human who already answered. The
//      transition table below is a WHITELIST and `acknowledge` appears on five rows of it.
//
// The machine is PURE: every fact it reasons over is injected, it performs no IO and reads no clock beyond
// the `at` it is handed. Each transition returns the new state plus a DECLARATIVE side-effect list
// (./effects) the M20-T06 route layer and the §4.8 workers execute inside one transaction — so the
// `safety_sos_alert` row, its `safety_sos_alert_state_history` row, the M4 audit row and the §4.10 outbox
// row commit together or not at all.
import type {
  IsoInstant,
  MembershipId,
  SafetyIncidentId,
  SafetySosCancelBiometricResult,
  SafetySosCancelStatus,
  SafetySosLifecycleState,
  SafetySosOutcome,
  VisitId,
} from "@wardenx/types";
import {
  SAFETY_SOS_ANOMALY_VOLUME_PER_HOUR,
  SAFETY_SOS_TERMINAL_STATES,
} from "@wardenx/types";
import {
  type SafetySideEffect,
  type SafetyTransitionResult,
  result,
  withAudit,
  withSosHistory,
} from "./effects";
import { SafetyStateError, requireSafety } from "./errors";

/** §2.2.2 — the commands. */
export type SafetySosCommand =
  | "openCancelWindow"
  | "cancelInWindow"
  | "expireCancelWindow"
  | "escalate"
  | "acknowledge"
  | "beginResolution"
  | "resolve"
  | "openIncident";

/** One legal edge of §2.2.2. */
export interface SafetySosEdge {
  readonly from: SafetySosLifecycleState;
  readonly command: SafetySosCommand;
  readonly to: SafetySosLifecycleState;
}

/**
 * §2.2.2 — the transition table.
 *
 * `raised` is the column DEFAULT and is reachable in production by exactly one path: the D15 offline sync,
 * which replays a press captured in the device's SQLCipher outbox. So both `raised` and `cancel_window_open`
 * accept `cancelInWindow`, and `openCancelWindow` exists to move a synced row onto the ordinary track rather
 * than leaving a state the rest of the machine cannot reach.
 *
 * `incident_opened` is reachable ONLY from `resolving`. §2.2.3 says linking an incident advances the SOS,
 * but a `resolved` SOS is terminal, so a next-morning freestanding incident that names the alert carries the
 * link on the INCIDENT row and leaves the alert resolved — the alternative would be re-opening a closed
 * life-safety record days later.
 */
export const SAFETY_SOS_EDGES: readonly SafetySosEdge[] = [
  { from: "raised", command: "openCancelWindow", to: "cancel_window_open" },
  { from: "raised", command: "cancelInWindow", to: "cancelled_in_window" },
  { from: "cancel_window_open", command: "cancelInWindow", to: "cancelled_in_window" },
  { from: "raised", command: "expireCancelWindow", to: "acknowledging" },
  { from: "cancel_window_open", command: "expireCancelWindow", to: "acknowledging" },
  { from: "acknowledging", command: "escalate", to: "escalation_tier_1" },
  { from: "escalation_tier_1", command: "escalate", to: "escalation_tier_2" },
  { from: "escalation_tier_2", command: "escalate", to: "escalation_tier_3" },
  { from: "escalation_tier_3", command: "escalate", to: "emergency_terminus" },
  // Property 3 in the header: five rows, not two.
  { from: "acknowledging", command: "acknowledge", to: "acknowledged" },
  { from: "escalation_tier_1", command: "acknowledge", to: "acknowledged" },
  { from: "escalation_tier_2", command: "acknowledge", to: "acknowledged" },
  { from: "escalation_tier_3", command: "acknowledge", to: "acknowledged" },
  { from: "emergency_terminus", command: "acknowledge", to: "acknowledged" },
  { from: "acknowledged", command: "beginResolution", to: "resolving" },
  { from: "resolving", command: "resolve", to: "resolved" },
  { from: "resolving", command: "openIncident", to: "incident_opened" },
];

/** §2.2.2 — the states no command advances out of. Mirrors `SAFETY_SOS_TERMINAL_STATES` (@wardenx/types);
 *  asserted equal by the §9 contract test. */
const TERMINAL: readonly SafetySosLifecycleState[] = SAFETY_SOS_TERMINAL_STATES;

/** Resolve the edge for `(from, command)`, or refuse. */
export function resolveSosEdge(
  from: SafetySosLifecycleState,
  command: SafetySosCommand,
): SafetySosEdge {
  requireSafety(
    !TERMINAL.includes(from),
    "SOS_TERMINAL",
    `an alert in '${from}' is terminal; no command advances it`,
  );
  const edge = SAFETY_SOS_EDGES.find((e) => e.from === from && e.command === command);
  if (edge === undefined) {
    throw new SafetyStateError(
      "SOS_INVALID_STATE_TRANSITION",
      `'${command}' is not a legal command from '${from}'`,
    );
  }
  return edge;
}

/** The commands legal from a state — what the §5 SOS detail panel renders as available actions. */
export function availableSosCommands(
  from: SafetySosLifecycleState,
): readonly SafetySosCommand[] {
  if (TERMINAL.includes(from)) return [];
  return SAFETY_SOS_EDGES.filter((e) => e.from === from).map((e) => e.command);
}

/** §2.5 — optimistic concurrency. Two supervisors acknowledging the same 3 a.m. alert is the ORDINARY case
 *  here, not the rare one; the second writer gets the spec's `409 STALE_LIFECYCLE_STATE` with the current
 *  state rather than silently overwriting the first responder's attribution. */
export function assertSosVersion(current: number, expected: number): void {
  requireSafety(
    current === expected,
    "STALE_LIFECYCLE_STATE",
    `the alert has moved on (version ${current}, you sent ${expected})`,
  );
}

/** One `safety_sos_alert` row as the machine sees it — the §2.2.2 columns and nothing more. */
export interface SafetySosAlertFacts {
  readonly lifecycleState: SafetySosLifecycleState;
  readonly version: number;
  readonly postedByMembershipId: MembershipId;
  readonly postedAt: IsoInstant;
  readonly cancelWindowExpiredAt: IsoInstant;
  readonly cancelStatus: SafetySosCancelStatus;
  readonly lastKnownVisitId: VisitId | null;
  readonly linkedIncidentId: SafetyIncidentId | null;
}

/** A transition of the SOS machine. */
export type SafetySosTransition = SafetyTransitionResult<SafetySosLifecycleState, SafetySosCommand>;

// ── The press ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * §2.2.2 / §2.6 / D5 — the effects of the PRESS. Not a transition (there is no prior state), and
 * deliberately not idempotent: M20-F10 makes every press write its own row and fan out on its own, because
 * collapsing two presses onto one alert IS the suppression S13 forbids. Delivery de-duplication lives on the
 * outbox `event_id`, which is per-emit.
 *
 * TWO FACTS ARE RECORDED AND NEITHER GATES (§2.2.2, M20-F16, §8.3):
 *   • `deviceAttested=false` — an SOS from an unattested device still records and still fans out. The
 *     anomaly event is the forensics trail behind the delivered alert, never a reason it was not delivered.
 *   • `coordinatesCaptured=false` — a clinician who declined `sos_coordinates` consent still gets the full
 *     fan-out; the recipients are told there is no location instead of being shown a stale one.
 *
 * `pressesInLastHour` counts this press. Above `SAFETY_SOS_ANOMALY_VOLUME_PER_HOUR` the platform FLAGS the
 * volume to compliance — and the eleventh press escalates exactly like the first (§8.3: a flag, not a gate).
 */
export function raiseSosEffects(input: {
  readonly at: IsoInstant;
  readonly deviceAttested: boolean;
  readonly coordinatesCaptured: boolean;
  readonly pressesInLastHour: number;
  /** D15 — a press replayed from the device's offline queue lands in `raised` and is moved onto the
   *  ordinary track by `openCancelWindow`; an online press is written straight into `cancel_window_open`. */
  readonly offlineSync?: boolean;
}): ReadonlyArray<SafetySideEffect> {
  const initial: SafetySosLifecycleState =
    input.offlineSync === true ? "raised" : "cancel_window_open";
  return withSosHistory(null, initial, false, [
    { kind: "outbox", event: "m20.safety.sos_alert_raised" },
    { kind: "alert", alert: "m20.safety.sos_alert_raised" },
    ...(input.deviceAttested
      ? []
      : ([
          { kind: "outbox", event: "m20.safety.device_attestation_anomaly" },
        ] as const satisfies readonly SafetySideEffect[])),
    ...(input.pressesInLastHour > SAFETY_SOS_ANOMALY_VOLUME_PER_HOUR
      ? ([
          { kind: "outbox", event: "m20.safety.sos_anomaly_volume" },
        ] as const satisfies readonly SafetySideEffect[])
      : []),
  ]);
}

/** D15 — move an offline-synced press from the column default onto the ordinary track. */
export function openCancelWindow(facts: SafetySosAlertFacts): SafetySosTransition {
  const edge = resolveSosEdge(facts.lifecycleState, "openCancelWindow");
  return result(edge.from, edge.command, edge.to, withSosHistory(edge.from, edge.to, true, []));
}

// ── D5 / §7.4 — the cancel ────────────────────────────────────────────────────────────────────────────

/** The outcome of a cancel attempt. `rejected` is NOT an error: the attempt is a recorded forensic fact and
 *  the alert proceeds, so the route returns 200 with the alert still live rather than a 4xx that would tell
 *  a hostile actor holding the device that their tap did something. */
export type SafetySosCancelDecision =
  | { readonly kind: "cancelled"; readonly transition: SafetySosTransition }
  | {
      readonly kind: "rejected";
      readonly biometricResult: SafetySosCancelBiometricResult;
      readonly effects: ReadonlyArray<SafetySideEffect>;
    };

/**
 * D5 / §7.4 — the clinician taps cancel inside the window.
 *
 * Guard order is deliberate: window → raiser → biometric. The window check runs first because it is the one
 * refusal that is true regardless of who is holding the phone, and the raiser check runs before the
 * biometric because "you are not the person who raised this" must not be discoverable by presenting a face
 * to the sensor.
 *
 * `biometricResult` is the DEVICE's verdict, passed through M2's step-up surface by the route layer; this
 * machine decides only what the verdict means under the tenant's policy. A policy that does not require
 * biometric still records `not_required` rather than `passed` — §3.3's vocabulary keeps the two apart
 * precisely so a forensic read can tell "the platform did not ask" from "the clinician's face matched".
 */
export function cancelSos(input: {
  readonly alert: SafetySosAlertFacts;
  readonly by: MembershipId;
  readonly at: IsoInstant;
  readonly biometricRequired: boolean;
  readonly biometricResult: SafetySosCancelBiometricResult | null;
}): SafetySosCancelDecision {
  const edge = resolveSosEdge(input.alert.lifecycleState, "cancelInWindow");

  requireSafety(
    Date.parse(input.at) <= Date.parse(input.alert.cancelWindowExpiredAt),
    "CANCEL_WINDOW_EXPIRED",
    `the ${Math.round((Date.parse(input.alert.cancelWindowExpiredAt) - Date.parse(input.alert.postedAt)) / 1000)}-second cancel window closed at ${input.alert.cancelWindowExpiredAt}`,
  );
  requireSafety(
    input.by === input.alert.postedByMembershipId,
    "CANCEL_NOT_BY_RAISER",
    "only the clinician who raised the SOS may cancel it; a supervisor stands it down by acknowledging",
  );

  if (input.biometricRequired && input.biometricResult !== "passed") {
    // §7.4's alternative outcome. NO history row: the lifecycle does not move (header property 2), and
    // §3.3's `m20_ssash_no_self` CHECK would refuse a from===to row anyway.
    return {
      kind: "rejected",
      biometricResult: "failed",
      effects: withAudit([
        {
          kind: "set_cancel_status",
          status: "cancel_attempted_but_rejected",
          biometricResult: "failed",
          attemptedAt: input.at,
        },
        { kind: "outbox", event: "m20.safety.sos_alert_cancel_attempted_rejected" },
      ]),
    };
  }

  const biometricResult: SafetySosCancelBiometricResult = input.biometricRequired
    ? "passed"
    : (input.biometricResult ?? "not_required");

  return {
    kind: "cancelled",
    transition: result(
      edge.from,
      edge.command,
      edge.to,
      withSosHistory(edge.from, edge.to, false, [
        {
          kind: "set_cancel_status",
          status: "cancelled_in_window",
          biometricResult,
          attemptedAt: input.at,
        },
        // §7.4 — the raiser's own stand-down clears the recipients' notification surface. It rides the
        // acknowledged topic because that is what the surface listens on; the row's `cancel_status` is the
        // discriminator that says a cancel (not a supervisor) ended it. The §4.10 payload has no `outcome`
        // field and none is invented here.
        { kind: "outbox", event: "m20.safety.sos_alert_acknowledged" },
        { kind: "alert", alert: "m20.safety.sos_alert_acknowledged" },
      ]),
    ),
  };
}

/** §2.2.2 — the cancel window elapsed with no successful cancel; the SLA ladder starts running. Emits no
 *  new alert: the fan-out already went out at the press (header property 1). */
export function expireCancelWindow(input: {
  readonly alert: SafetySosAlertFacts;
  readonly at: IsoInstant;
}): SafetySosTransition {
  const edge = resolveSosEdge(input.alert.lifecycleState, "expireCancelWindow");
  requireSafety(
    Date.parse(input.at) >= Date.parse(input.alert.cancelWindowExpiredAt),
    "SOS_INVALID_STATE_TRANSITION",
    "the cancel window has not closed yet; the clinician can still stand the alert down",
  );
  return result(edge.from, edge.command, edge.to, withSosHistory(edge.from, edge.to, true, []));
}

// ── The escalation ladder + the terminus ──────────────────────────────────────────────────────────────

/** Why the alert advanced a rung (§4.10 `M20SosAlertEscalatedPayload.reasonCode`). */
export type SafetySosEscalationReason = "sla_breach" | "delivery_failed" | "manual";

/**
 * §2.2.2 — advance one rung. Driven by the §4.8 SLA watchdog (`sla_breach`, see ./sos-escalator), by the
 * `m36.notification.delivery_failed` consumer (`delivery_failed` — a page that did not arrive is a breach
 * that has already happened) and by a supervisor's explicit escalate (`manual`).
 *
 * The rung into `emergency_terminus` carries the §2.2.2 quartet: dial the consented emergency contact,
 * surface M40's PSAP number to every recipient, page WardenX ops, and (in ./sos-escalator) keep looping.
 */
export function escalateSos(input: {
  readonly alert: SafetySosAlertFacts;
  readonly reasonCode: SafetySosEscalationReason;
  readonly at: IsoInstant;
  /** D10 — only relevant on the terminus rung: does this clinician have an active `emergency_contact_call`
   *  consent? A `false` still reaches the terminus; it means there is nobody to auto-dial, which the §4.10
   *  payload has to be able to say. */
  readonly emergencyContactConsent?: boolean;
}): SafetySosTransition {
  const edge = resolveSosEdge(input.alert.lifecycleState, "escalate");
  const systemActor = input.reasonCode !== "manual";

  if (edge.to === "emergency_terminus") {
    return result(
      edge.from,
      edge.command,
      edge.to,
      withSosHistory(edge.from, edge.to, systemActor, [
        { kind: "dial_emergency_contact", consentPresent: input.emergencyContactConsent === true },
        { kind: "surface_psap_number" },
        { kind: "page_wardenx_ops" },
        { kind: "outbox", event: "m20.safety.sos_terminus_reached" },
        { kind: "alert", alert: "m20.safety.sos_terminus_reached" },
      ]),
    );
  }

  return result(
    edge.from,
    edge.command,
    edge.to,
    withSosHistory(edge.from, edge.to, systemActor, [
      { kind: "outbox", event: "m20.safety.sos_alert_escalated" },
      { kind: "alert", alert: "m20.safety.sos_alert_escalated" },
    ]),
  );
}

/**
 * §2.2.2 / M20-F05 / S13 / INT-031 — one turn of the terminus LOOP.
 *
 * The terminus "keeps re-escalating on a loop … until a responder or WardenX ops acknowledges. The chain
 * only exits on acknowledgment, never on timeout." So this is NOT a transition — the state stays
 * `emergency_terminus` — and it therefore returns NO `sos_state_history` effect: §3.3's `m20_ssash_no_self`
 * CHECK refuses a row whose from- and to-state are equal, and a machine that emitted one here would have the
 * loop die on a constraint violation at exactly the moment nobody is answering.
 *
 * `loopIteration` is carried into the §4.10 payload so a consumer can tell the tenth page from the first
 * WITHOUT suppressing either.
 */
export function repageTerminus(input: {
  readonly alert: SafetySosAlertFacts;
  readonly loopIteration: number;
  readonly emergencyContactConsent: boolean;
}): ReadonlyArray<SafetySideEffect> {
  requireSafety(
    input.alert.lifecycleState === "emergency_terminus",
    "SOS_INVALID_STATE_TRANSITION",
    "the terminus loop only re-pages an alert already in `emergency_terminus`",
  );
  return withAudit([
    { kind: "dial_emergency_contact", consentPresent: input.emergencyContactConsent },
    { kind: "surface_psap_number" },
    { kind: "page_wardenx_ops" },
    { kind: "outbox", event: "m20.safety.sos_terminus_reached" },
    { kind: "alert", alert: "m20.safety.sos_terminus_reached" },
  ]);
}

// ── Acknowledgment → resolution ───────────────────────────────────────────────────────────────────────

/**
 * §2.2.2 — a responder answers. This is the ONLY exit from the escalation ladder and the only exit from the
 * terminus; everything else in the chain is a timer.
 *
 * The `active_sos_responder` eligibility check (§2.2.2) is an M3 ABAC predicate and lives at the route layer
 * (M20-T06) rather than here: this machine takes no role facts, and re-implementing an ABAC decision from
 * whatever subset of them a caller happened to pass is how two answers to the same question start to differ.
 */
export function acknowledgeSos(input: {
  readonly alert: SafetySosAlertFacts;
  readonly by: MembershipId;
  readonly at: IsoInstant;
}): SafetySosTransition {
  const edge = resolveSosEdge(input.alert.lifecycleState, "acknowledge");
  return result(
    edge.from,
    edge.command,
    edge.to,
    withSosHistory(edge.from, edge.to, false, [
      { kind: "set_timestamp", field: "acknowledged_at", at: input.at },
      { kind: "set_actor", field: "acknowledged_by_membership_id", membershipId: input.by },
      { kind: "outbox", event: "m20.safety.sos_alert_acknowledged" },
      { kind: "alert", alert: "m20.safety.sos_alert_acknowledged" },
    ]),
  );
}

/** §2.2.2 — the responder begins outreach. A separate state from `acknowledged` because §4.3's response-time
 *  metric measures to the ACKNOWLEDGMENT and the §5 board needs to distinguish "somebody has seen this" from
 *  "somebody is working it". */
export function beginSosResolution(alert: SafetySosAlertFacts): SafetySosTransition {
  const edge = resolveSosEdge(alert.lifecycleState, "beginResolution");
  return result(edge.from, edge.command, edge.to, withSosHistory(edge.from, edge.to, false, []));
}

/**
 * §2.2.2 / §7.5 — the responder closes the alert with an outcome and a narrative.
 *
 * Both are required at the write path even though §3.3 leaves `resolution_narrative_cipher` nullable (a
 * repaired row must remain writable): an alert that can say it ended but not how is not the workers-comp
 * evidence §1.1 exists to produce. `outcome='visit_cancelled'` additionally requires a visit — M20 never
 * writes an M17 row, it emits `m20.safety.visit_cancellation_requested` and M17's D3 handler decides, and
 * that event has nothing to name without one.
 */
export function resolveSos(input: {
  readonly alert: SafetySosAlertFacts;
  readonly by: MembershipId;
  readonly outcome: SafetySosOutcome | null;
  readonly resolutionNarrative: string;
  readonly at: IsoInstant;
}): SafetySosTransition {
  const edge = resolveSosEdge(input.alert.lifecycleState, "resolve");
  requireSafety(
    input.outcome !== null,
    "SOS_OUTCOME_REQUIRED",
    "record how the SOS ended; the §4.3 metrics seam and the workers-comp file both read the outcome",
  );
  requireSafety(
    input.resolutionNarrative.trim().length > 0,
    "SOS_RESOLUTION_NARRATIVE_REQUIRED",
    "record what the responder did; an outcome with no narrative cannot be read back in 2031",
  );

  const visitCancellation: readonly SafetySideEffect[] =
    input.outcome === "visit_cancelled"
      ? (() => {
          requireSafety(
            input.alert.lastKnownVisitId !== null,
            "SOS_VISIT_CONTEXT_REQUIRED",
            "`visit_cancelled` asks M17 to cancel a visit; this alert carries no visit context",
          );
          return [
            {
              kind: "request_visit_cancellation",
              visitId: input.alert.lastKnownVisitId,
            },
            { kind: "outbox", event: "m20.safety.visit_cancellation_requested" },
          ] satisfies readonly SafetySideEffect[];
        })()
      : [];

  return result(
    edge.from,
    edge.command,
    edge.to,
    withSosHistory(edge.from, edge.to, false, [
      { kind: "set_timestamp", field: "resolved_at", at: input.at },
      { kind: "set_actor", field: "resolved_by_membership_id", membershipId: input.by },
      { kind: "set_sos_outcome", outcome: input.outcome },
      ...visitCancellation,
      { kind: "outbox", event: "m20.safety.sos_alert_resolved" },
      { kind: "alert", alert: "m20.safety.sos_alert_resolved" },
    ]),
  );
}

/** §2.2.2 / §2.2.3 — the responder converts the alert into a formal incident instead of resolving it. The
 *  incident row is minted first (M20-T06's incident opener) so the link exists before the SOS moves;
 *  §3.3's `m20_ssa_incident_linked` refuses the state without it. */
export function openIncidentFromSos(input: {
  readonly alert: SafetySosAlertFacts;
  readonly incidentId: SafetyIncidentId | null;
}): SafetySosTransition {
  const edge = resolveSosEdge(input.alert.lifecycleState, "openIncident");
  requireSafety(
    input.incidentId !== null,
    "SOS_INCIDENT_LINK_REQUIRED",
    "`incident_opened` names the incident it was opened into; mint the incident first",
  );
  return result(
    edge.from,
    edge.command,
    edge.to,
    withSosHistory(edge.from, edge.to, false, [
      { kind: "link_incident", incidentId: input.incidentId },
      { kind: "outbox", event: "m20.safety.incident_reported" },
    ]),
  );
}
