// apps/backend/src/modules/08-encounters/cosignature/cosignature.ts — M8-T06 (§2.4 D3).
//
// The `cosignature_request` aggregate lifecycle (§2.4): an LPN/CHHA primary sign opens a request routed
// to the assigned RN case manager; from there it walks
//   routed → acknowledged → signed                     (§7.2 — cosigner opens, reviews, signs)
//   routed → escalated (24h) → signed                  (§7.3 — 24h escalation, then cosigner signs)
//   routed/escalated → hard_cap_reached (48h) → supervisor_released → signed   (§7.3 — locked, released)
// The `signed` request is terminal; the ENCOUNTER then transitions to `cosigned` (the encounter machine's
// `recordCosignature` event — composed by the service, not this machine). Pure, same shape as the M8
// encounter machine: legal-graph check + enumerated guards (each raises the §2.7/§2.4 code) + the §2.8
// in-transaction side-effect list. The 12h/24h/48h clock math is ./sla-clock; this machine consumes its
// stage decisions as injected events. No IO, no cross-module schema import.
import type { CosignatureStatus, LocalDate, MembershipId } from "@wardenx/types";
import { EncounterStateError, require_ } from "../lifecycle/errors";
import { type EncounterSideEffect, type TransitionResult, result } from "../lifecycle/effects";
import { TEXT_MINIMUMS } from "../lifecycle/validation";

/** The §2.4 cosignature-request state (mirrors `cosignature_status`). */
export type CosignatureState = CosignatureStatus;

/** The §2.4 cosignature-request lifecycle events. */
export type CosignatureEvent =
  /** Cosigner opens the request from their queue (§7.2). */
  | { readonly type: "acknowledge"; readonly at: LocalDate }
  /** 24h SLA tick: escalate to the clinical supervisor (§7.3; ./sla-clock decides the timing). */
  | {
      readonly type: "escalate";
      readonly supervisorMembershipId: MembershipId;
      readonly at: LocalDate;
    }
  /** 48h SLA tick: hard cap reached; the encounter is locked to `cosign_pending` (§7.3). */
  | {
      readonly type: "reachHardCap";
      readonly supervisorMembershipId: MembershipId;
      readonly at: LocalDate;
    }
  /** Past 48h: a clinical supervisor / DON releases with a documented reason ≥ 40 chars (§7.3). */
  | {
      readonly type: "release";
      readonly isSupervisor: boolean;
      readonly reason: string;
      readonly at: LocalDate;
    }
  /** A qualified RN signs as cosigner — request becomes terminal; encounter → `cosigned` (§7.2/§7.3). */
  | { readonly type: "sign"; readonly isQualifiedRn: boolean; readonly at: LocalDate };

export type CosignatureTransition = TransitionResult<CosignatureState, CosignatureEvent["type"]>;

/**
 * The legal §2.4 transition graph (from → events accepted). `sign` is accepted while the request is
 * actively awaiting a cosignature (`routed`/`acknowledged`/`escalated`) — but NOT from
 * `hard_cap_reached`: past 48h the encounter is LOCKED and a supervisor must `release` first (§7.3).
 * `pending` is the table default the opening encounter transition immediately routes past (see
 * {@link planCosignatureCreation}); it is included so an un-routed row can still be routed.
 */
export const COSIGNATURE_GRAPH: Readonly<
  Record<CosignatureState, ReadonlyArray<CosignatureEvent["type"]>>
> = {
  pending: [],
  routed: ["acknowledge", "escalate", "reachHardCap", "sign"],
  acknowledged: ["escalate", "reachHardCap", "sign"],
  escalated: ["reachHardCap", "sign"],
  hard_cap_reached: ["release"],
  supervisor_released: ["sign"],
  signed: [],
};

/**
 * The genesis of a cosignature request: created already `routed` to the RN case manager inside the
 * LPN/CHHA primary-sign transaction (§2.4). A factory, not a transition — the encounter machine's
 * `open_cosignature_request` effect creates the row and `m8.encounter.cosignature_routed` is published
 * there; this returns the request-side side-effect list (audit + the routed timestamp). The actual
 * `routedToMembershipId` (the assigned RN case manager) is resolved by the service from M5's
 * `CaseloadProvider`. Mirrors `planDraftCreation` on the encounter aggregate.
 */
export function planCosignatureCreation(routedAt: LocalDate): ReadonlyArray<EncounterSideEffect> {
  return [
    { kind: "set_timestamp", field: "routed_at", at: routedAt },
    { kind: "audit" },
  ];
}

/**
 * Apply a §2.4 cosignature-request lifecycle event. Throws {@link EncounterStateError}
 * `ILLEGAL_TRANSITION` if the event is not accepted from `from` (e.g. `sign` from `hard_cap_reached`
 * while the encounter is locked), or the specific §2.4/§2.7 guard code on a guard failure.
 */
export function transitionCosignature(
  from: CosignatureState,
  event: CosignatureEvent,
): CosignatureTransition {
  if (!COSIGNATURE_GRAPH[from].includes(event.type)) {
    // A `sign` attempt while locked at the hard cap is the meaningful failure here: surface the precise
    // §2.4 code rather than the structural one so the UI explains "release required" (§7.3).
    if (event.type === "sign" && from === "hard_cap_reached") {
      throw new EncounterStateError(
        "COSIGNATURE_LOCKED",
        "the encounter is locked at the 48h hard cap; a supervisor must release it before cosignature",
      );
    }
    throw new EncounterStateError(
      "ILLEGAL_TRANSITION",
      `cosignature request cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "acknowledge": {
      return result(from, event.type, "acknowledged", [
        { kind: "set_timestamp", field: "acknowledged_at", at: event.at },
        { kind: "audit" },
      ]);
    }
    case "escalate": {
      // 24h: status flips to `escalated`; the supervisor alert is the `cosignature_escalated` outbox.
      return result(from, event.type, "escalated", [
        { kind: "set_timestamp", field: "escalated_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m8.encounter.cosignature_escalated" },
      ]);
    }
    case "reachHardCap": {
      // 48h: status → `hard_cap_reached`; encounter locked; alert to Supervisor + DON (critical).
      return result(from, event.type, "hard_cap_reached", [
        { kind: "set_timestamp", field: "hard_cap_at", at: event.at },
        { kind: "audit" },
        { kind: "outbox", event: "m8.encounter.cosignature_hard_cap_reached" },
      ]);
    }
    case "release": {
      // Only a clinical supervisor / DON may release, with a documented reason ≥ 40 chars (also a DB
      // CHECK). Release does NOT cosign — the encounter still requires a qualified RN signature (§7.3).
      require_(
        event.isSupervisor,
        "SUPERVISOR_RELEASE_NOT_PERMITTED",
        "only a clinical supervisor or DON may release a hard-capped cosignature request",
      );
      require_(
        event.reason.trim().length >= TEXT_MINIMUMS.supervisorReleaseReason,
        "SUPERVISOR_RELEASE_REASON_TOO_SHORT",
        `supervisor release reason must be ≥ ${TEXT_MINIMUMS.supervisorReleaseReason} characters`,
      );
      return result(from, event.type, "supervisor_released", [
        { kind: "set_timestamp", field: "supervisor_released_at", at: event.at },
        { kind: "set_field", field: "supervisor_released_by" },
        { kind: "set_field", field: "supervisor_released_reason" },
        { kind: "audit" },
      ]);
    }
    case "sign": {
      // The signing RN's full §2.7 eligibility (encounter.cosign ∧ RN ∧ on-caseload) is checked by the
      // service via checkCosignerEligibility; the machine guards the discipline floor (must be a
      // qualified RN — or the supervisor themself if RN-qualified, §7.3) and seals the request.
      require_(
        event.isQualifiedRn,
        "NOT_COSIGN_ELIGIBLE",
        "a cosignature must be signed by a qualified RN",
      );
      return result(from, event.type, "signed", [
        { kind: "set_timestamp", field: "signed_at", at: event.at },
        { kind: "audit" },
      ]);
    }
  }
}
