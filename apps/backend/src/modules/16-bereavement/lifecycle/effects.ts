// apps/backend/src/modules/16-bereavement/lifecycle/effects.ts — M16-T03 (§2.6 side-effects).
//
// The same §2.6 discipline M6/M7/M15 fixed: every transition carries an explicit, in-transaction
// side-effect list (audit + outbox + timestamp/roster ops), and the COMMIT binds the domain row, the audit
// row and the outbox row atomically — "the plan closed but `plan_closed_completed` never went out" is
// eliminated structurally rather than by review. This pure engine returns the side effects DECLARATIVELY
// as data; the M16 service layer (the M16-T06 routes + the §4.9 workers) executes them inside the
// aggregate's optimistic-locked (§2.5 `If-Match`) transaction. Keeping them as data makes the machines
// deterministic and unit-testable with no DB.
import type {
  BereavementAlertPayload,
  BereavementAnniversaryMark,
  BereavementCloseKind,
  BereavementExternalSourceMetadata,
  BereavementOptOutKind,
  BereavementOptOutSourceKind,
  BereavementPlanClosureReason,
  IsoInstant,
  M16EventName,
} from "@chartwarden/types";

/**
 * One in-transaction side effect a transition declares (§2.6). The service layer is the only place these
 * run; the machine never touches IO. `outbox` events are restricted to the §4.4 `m16.*` catalog, so a typo
 * cannot invent an event name the dispatcher (and `arch:gaps`) would not recognise.
 */
export type BereavementSideEffect =
  /** Write the M4 write-audit row for the aggregate (always present). */
  | { readonly kind: "audit" }
  /** Publish an `m16.*` outbox event in the same tx (§4.4 catalog). */
  | { readonly kind: "outbox"; readonly event: M16EventName }
  /** Raise a §4.10 typed M36 alert. Only the DISCRIMINATOR is declared here — the service layer resolves
   *  the recipient + the rest of the payload, which needs reads the pure machine deliberately cannot do. */
  | { readonly kind: "alert"; readonly alert: BereavementAlertPayload["kind"] }
  /** Set a timestamp column on the aggregate (`opened_at`, `closed_at`, `confirmed_at`, …). */
  | { readonly kind: "set_timestamp"; readonly field: string; readonly at: IsoInstant }
  /** Point `assigned_counselor_user_id` / `assigned_volunteer_user_id` at a membership (§2.2). */
  | {
      readonly kind: "set_assignment";
      readonly role: "counselor" | "volunteer";
      readonly membershipId: string;
      readonly at: IsoInstant;
    }
  /** Insert the §3.3.7 `bereavement_plan_closure` row that records WHY the program ended (D7). */
  | {
      readonly kind: "insert_closure";
      readonly reason: BereavementPlanClosureReason;
      readonly closeKind: BereavementCloseKind;
      /** D7 — whether the row lands awaiting a clinical-supervisor cosign. */
      readonly cosignRequired: boolean;
    }
  /** Insert the §3.3.8 `bereavement_opt_out` row behind a contact opt-out (D9). */
  | {
      readonly kind: "insert_opt_out";
      readonly optOutKind: BereavementOptOutKind;
      readonly source: BereavementOptOutSourceKind;
    }
  /** Mark the D9 rescind on the open opt-out row rather than deleting it (the survivor's decision and its
   *  reversal both stay on the survey record). */
  | { readonly kind: "rescind_opt_out"; readonly at: IsoInstant }
  /** Cancel every future-dated `scheduled` outreach for the plan or for one contact (§2.2 / §2.3). */
  | { readonly kind: "cancel_future_outreach"; readonly scope: "plan" | "contact" }
  /** Regenerate the forward schedule from an instant to the window end (`resumePlan`, `rescindOptOut`). */
  | {
      readonly kind: "regenerate_schedule";
      readonly fromIso: IsoInstant;
      readonly scope: "plan" | "contact";
    }
  /** Materialize the D4 outreach rows + emit one `outreach_scheduled` per row (`seedRosterAndSchedule`). */
  | { readonly kind: "generate_schedule" }
  /** Insert the §3.3.6 anniversary-reminder rows the §4.9 lookahead cron alerts off. */
  | {
      readonly kind: "seed_anniversary_reminders";
      readonly marks: ReadonlyArray<BereavementAnniversaryMark>;
    }
  /** Recompute the deterministic D3 risk score (the initial score at `seedRosterAndSchedule`, and the
   *  per-contact score a `confirmContact` triggers). The scorer itself is M16-T04. */
  | { readonly kind: "recompute_risk"; readonly scope: "plan" | "contact" }
  /** D18 — write the cosign receipt back onto `external_source_metadata` (state unchanged). */
  | {
      readonly kind: "set_external_source_metadata";
      readonly metadata: BereavementExternalSourceMetadata;
    }
  /** §7.7 — log the M40 external-resource referral behind `flagComplicatedGrief`. */
  | { readonly kind: "log_external_referral"; readonly externalResourceId: string };

/** A transition's full result — the new state + its ordered side-effect list. */
export interface BereavementTransitionResult<S extends string, E extends string> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly effects: ReadonlyArray<BereavementSideEffect>;
}

/** Build a {@link BereavementTransitionResult} (keeps the three machines terse and uniform). */
export function result<S extends string, E extends string>(
  from: S,
  event: E,
  to: S,
  effects: ReadonlyArray<BereavementSideEffect>,
): BereavementTransitionResult<S, E> {
  return { from, event, to, effects };
}
