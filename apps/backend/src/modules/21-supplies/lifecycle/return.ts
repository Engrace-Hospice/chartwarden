// apps/backend/src/modules/21-supplies/lifecycle/return.ts — M21-T03 (§2.6 / D8).
//
// The chain-of-custody machine that runs from "this patient died, the kit must come back" to a reconciled,
// witnessed disposal record: `requested → assigned → retrieving → retrieved → reconciled`, with `overdue`
// (30d) and `unreturnable` (90d, assumption of loss) as the two escape states.
//
// FOUR RULES THAT ARE NOT NEGOTIABLE, and the reason each exists:
//
//   1. **Separation of duties.** The reconciler may not be the dispatcher; the witness may not be the
//      retriever or the reconciler. One person attesting to their own count is not a count. §7.3 words the
//      first as an ABAC failure and the second as the §3.1.10 CHECK — both surface here so the service
//      refuses before either the predicate or the database has to.
//
//   2. **Over-return is refused, never absorbed.** Returned + disposed > dispatched writes a NEGATIVE
//      unaccounted quantity into the perpetual log. It is a data-entry error or a mixed-up kit, and either
//      way the reconciler resolves it before signing.
//
//   3. **Every dispatched line must be accounted for.** A reconciliation that silently omits a line is
//      indistinguishable, on the record, from one where that line came back — which is exactly the shape a
//      diversion takes.
//
//   4. **Discrepancy is terminal-but-not-reverting.** §7.3: the reconciler cannot walk a flagged
//      reconciliation back; only an M30 investigation closure can mark it explained. So the flag is computed
//      from the numbers, never passed in.
//
// The escalation tail is a CRON decision, not a human one: 30 days emits the compliance surface, 90 days
// takes the assumption of loss and fires the controlled-substance discrepancy for every controlled line
// still outstanding.
import {
  RETURN_OVERDUE_DAYS,
  RETURN_WINDOW_HOURS_DEFAULT,
  type ReturnLineInput,
  computeReturnReconciliation,
  daysBetween,
  isDisposalWitnessValid,
  isReturnLineCoherent,
  returnDueAt,
  returnEscalationAt,
} from "@chartwarden/supplies";
import type {
  ComfortKitDispatchedContentId,
  ComfortKitDisposalMethod,
  ComfortKitReturnState,
  IsoInstant,
  MembershipId,
} from "@chartwarden/types";
import { type SupplySideEffect, type SupplyTransitionResult, result, withAudit } from "./effects";
import { SupplyStateError, require_ } from "./errors";

/** One reconciled line as the reconciler submits it (§2.6). Quantities are decimal strings. */
export interface ReturnLineSubmission extends ReturnLineInput {
  readonly dispatchedContentId: ComfortKitDispatchedContentId;
  readonly drugName: string;
}

/** The §2.6 return-machine events. */
export type ComfortKitReturnEvent =
  | {
      /** §2.6 — a supply-team member takes the retrieval. */
      readonly type: "assignRetriever";
      readonly retrievingMembershipId: MembershipId;
      readonly at: IsoInstant;
    }
  | {
      readonly type: "markEnRoute";
      readonly at: IsoInstant;
    }
  | {
      /** §2.6 — the kit is physically in the retriever's hands. */
      readonly type: "markRetrieved";
      readonly at: IsoInstant;
      /** Null when disposal happened at the home rather than back at the hub. */
      readonly returnedToHubAt: IsoInstant | null;
    }
  | {
      /** §2.6 / D8 — the count, the disposal record and the signature, in one transaction. */
      readonly type: "reconcile";
      readonly at: IsoInstant;
      readonly reconciledByMembershipId: MembershipId;
      readonly disposalMethod: ComfortKitDisposalMethod;
      readonly disposalWitnessMembershipId: MembershipId | null;
      readonly disposalMethodJurisdictionPolicyDigest: string;
      readonly lines: ReadonlyArray<ReturnLineSubmission>;
      /** Every `comfort_kit_dispatched_content.id` on the dispatch — the coverage check reads this. */
      readonly dispatchedContentIds: ReadonlyArray<ComfortKitDispatchedContentId>;
      /** §7.3 — the dispatcher, so separation of duties can be proven rather than assumed. */
      readonly dispatchedByMembershipId: MembershipId;
      /** Populated at `assignRetriever`; null when nobody was assigned (a hub walk-in return). */
      readonly assignedRetrievingMembershipId: MembershipId | null;
    }
  | {
      /** §2.6 — the daily cron found the 30-day boundary crossed. */
      readonly type: "markOverdue";
      readonly at: IsoInstant;
      readonly returnRequiredAt: IsoInstant;
      readonly containsControlledSubstance: boolean;
    }
  | {
      /** §2.6 — the 90-day disposition, attested by a clinical supervisor. */
      readonly type: "markUnreturnable";
      readonly at: IsoInstant;
      readonly returnRequiredAt: IsoInstant;
      readonly reason: string;
      readonly attestedByMembershipId: MembershipId;
      readonly containsControlledSubstance: boolean;
      readonly unreturnableDays?: number;
    };

export type ComfortKitReturnTransitionResult = SupplyTransitionResult<
  ComfortKitReturnState,
  ComfortKitReturnEvent["type"]
>;

/**
 * The legal §2.6 graph (from → events accepted).
 *
 * `overdue` is NOT a dead end: a kit that turns up on day 40 is still retrieved, reconciled and recorded —
 * the overdue state says the clock was missed, not that the count stopped mattering. `unreturnable` and
 * `reconciled` are the only terminals.
 */
export const COMFORT_KIT_RETURN_GRAPH: Readonly<
  Record<ComfortKitReturnState, ReadonlyArray<ComfortKitReturnEvent["type"]>>
> = {
  requested: ["assignRetriever", "markOverdue", "markUnreturnable"],
  assigned: ["markEnRoute", "markRetrieved", "markOverdue", "markUnreturnable"],
  retrieving: ["markRetrieved", "markOverdue", "markUnreturnable"],
  retrieved: ["reconcile", "markOverdue", "markUnreturnable"],
  overdue: ["assignRetriever", "markEnRoute", "markRetrieved", "reconcile", "markUnreturnable"],
  reconciled: [],
  unreturnable: [],
} as const;

/** §2.6 — `return_due_at` from the M13 event instant plus the tenant's (possibly tightened) window. */
export function computeReturnDueAt(
  returnRequiredAt: IsoInstant,
  windowHours: number = RETURN_WINDOW_HOURS_DEFAULT,
): IsoInstant {
  return returnDueAt(new Date(returnRequiredAt), windowHours).toISOString();
}

/** §2.6 — apply one return-machine event. */
export function transitionComfortKitReturn(
  state: ComfortKitReturnState,
  event: ComfortKitReturnEvent,
): ComfortKitReturnTransitionResult {
  const accepted = COMFORT_KIT_RETURN_GRAPH[state];
  if (!accepted.includes(event.type)) {
    // §7.3's racing-reconcilers case: the second submit finds the row already terminal and must be told
    // exactly that, not a generic conflict — the UI shows who signed it and when.
    if (state === "reconciled") {
      throw new SupplyStateError(
        "M21_RETURN_ALREADY_RECONCILED",
        "this return was already reconciled; a second reconciliation would overwrite a signed DEA record",
      );
    }
    throw new SupplyStateError(
      "M21_RETURN_STATE_TRANSITION_INVALID",
      `'${event.type}' is not legal from return state '${state}'`,
    );
  }

  switch (event.type) {
    case "assignRetriever":
      return result(
        state,
        event.type,
        "assigned",
        withAudit([{ kind: "assign_retriever", membershipId: event.retrievingMembershipId }]),
      );

    case "markEnRoute":
      return result(
        state,
        event.type,
        "retrieving",
        withAudit([{ kind: "set_timestamp", field: "retrieving_at", at: event.at }]),
      );

    case "markRetrieved": {
      const effects: SupplySideEffect[] = [
        { kind: "set_timestamp", field: "retrieved_at", at: event.at },
      ];
      if (event.returnedToHubAt !== null) {
        effects.push({
          kind: "set_timestamp",
          field: "returned_to_hub_at",
          at: event.returnedToHubAt,
        });
      }
      return result(state, event.type, "retrieved", withAudit(effects));
    }

    case "reconcile":
      return reconcile(state, event);

    case "markOverdue": {
      const days = daysBetween(new Date(event.returnRequiredAt), new Date(event.at));
      require_(
        days >= RETURN_OVERDUE_DAYS,
        "M21_RETURN_NOT_YET_OVERDUE",
        `the kit has been out ${days} day(s); the compliance boundary is ${RETURN_OVERDUE_DAYS}`,
      );
      return result(
        state,
        event.type,
        "overdue",
        withAudit([
          { kind: "outbox", event: "m21.comfort_kit.return_overdue" },
          { kind: "alert", alert: "m21.comfort_kit.unreturned" },
        ]),
      );
    }

    case "markUnreturnable": {
      require_(
        event.reason.trim().length > 0,
        "M21_UNRETURNABLE_REASON_REQUIRED",
        "declaring a kit unreturnable requires an attested reason — this is the record that the agency tried",
      );
      const escalation = returnEscalationAt(
        new Date(event.returnRequiredAt),
        new Date(event.at),
        event.unreturnableDays,
      );
      require_(
        escalation === "unreturnable_90d",
        "M21_RETURN_NOT_YET_OVERDUE",
        "the assumption-of-loss boundary has not been reached; the kit is still being retrieved",
      );
      const effects: SupplySideEffect[] = [
        {
          kind: "record_unreturnable",
          reason: event.reason,
          attestedByMembershipId: event.attestedByMembershipId,
        },
        { kind: "outbox", event: "m21.comfort_kit.return_overdue" },
        { kind: "alert", alert: "m21.comfort_kit.unreturned" },
      ];
      if (event.containsControlledSubstance) {
        // §2.6 — at 90 days the controlled content is presumed lost. The discrepancy fires on the
        // ASSUMPTION, because a CII solution nobody can produce is a diversion question either way.
        effects.push(
          { kind: "outbox", event: "m21.controlled_substance.discrepancy_detected" },
          { kind: "alert", alert: "m21.controlled_substance.discrepancy" },
        );
      }
      return result(state, event.type, "unreturnable", withAudit(effects));
    }
  }
}

/** The §2.6 reconciliation outcome the caller needs beyond the state change. */
export interface ReturnReconciliationOutcome {
  readonly transition: ComfortKitReturnTransitionResult;
  readonly discrepancyDetected: boolean;
  readonly flaggedLineCount: number;
  /** Per-line computed accounting, in submission order (the `comfort_kit_returned_content` rows). */
  readonly lines: ReadonlyArray<{
    readonly dispatchedContentId: ComfortKitDispatchedContentId;
    readonly quantityUnaccounted: string;
    readonly discrepancyPct: number;
    readonly discrepancyFlagged: boolean;
  }>;
}

function reconcile(
  state: ComfortKitReturnState,
  event: Extract<ComfortKitReturnEvent, { type: "reconcile" }>,
): ComfortKitReturnTransitionResult {
  return reconcileReturn(state, event).transition;
}

/**
 * §2.6 / D8 — the reconciliation. Returns the transition AND the computed per-line accounting, because the
 * caller writes both the state and the `comfort_kit_returned_content` rows in one transaction.
 *
 * The discrepancy flag is COMPUTED here from the quantities (`@chartwarden/supplies` owns the Decimal math the
 * `m21_compute_return_discrepancy` trigger mirrors). It is never accepted from the caller: a flag the
 * reconciler could set is a flag the reconciler could clear, and §7.3 is explicit that only an M30
 * investigation closure can mark a discrepancy explained.
 */
export function reconcileReturn(
  state: ComfortKitReturnState,
  event: Extract<ComfortKitReturnEvent, { type: "reconcile" }>,
): ReturnReconciliationOutcome {
  // Mirrors the `m21_ckit_return_reconciled_complete` CHECK: terminal `reconciled` without a disposal
  // method is a signed record that does not say what happened to the medication.
  require_(
    String(event.disposalMethod ?? "").length > 0,
    "M21_DISPOSAL_METHOD_REQUIRED",
    "a reconciled return must record how the medication was disposed of",
  );
  require_(
    event.disposalMethodJurisdictionPolicyDigest.trim().length > 0,
    "M21_DISPOSAL_METHOD_REQUIRED",
    "the jurisdiction disposal policy AS APPLIED must be frozen onto the return record",
  );

  // §7.3 — the reconciler may not be the dispatcher. Fails CLOSED: the whole point of the rule is that the
  // person who signed the kit out does not get to be the only person who says what came back.
  require_(
    event.reconciledByMembershipId !== event.dispatchedByMembershipId,
    "M21_RECONCILIATION_SEPARATION_OF_DUTIES_VIOLATION",
    "the reconciler may not be the member who dispatched the kit",
  );

  const witnessOk = isDisposalWitnessValid({
    disposalMethod: event.disposalMethod,
    disposalWitnessMembershipId: event.disposalWitnessMembershipId,
    assignedRetrievingMembershipId: event.assignedRetrievingMembershipId,
    reconciledByMembershipId: event.reconciledByMembershipId,
  });
  if (!witnessOk) {
    // Two distinct failures share one predicate; the codes differ because the remedies do — one needs a
    // witness at all, the other needs a DIFFERENT one.
    if (
      event.disposalMethod === "dispose_at_home_by_witnessed_destruction" &&
      event.disposalWitnessMembershipId === null
    ) {
      throw new SupplyStateError(
        "M21_WITNESS_REQUIRED_FOR_CONTROLLED_SUBSTANCE",
        "at-home witnessed destruction requires a witness — nothing arrives anywhere afterwards to corroborate the count",
      );
    }
    throw new SupplyStateError(
      "M21_RECONCILIATION_SEPARATION_OF_DUTIES_VIOLATION",
      "the disposal witness must differ from both the retriever and the reconciler",
    );
  }

  // Every dispatched line must appear exactly once. A missing line reads, on the record, exactly like a
  // line that came back whole.
  const submitted = new Set(event.lines.map((l) => l.dispatchedContentId));
  const missing = event.dispatchedContentIds.filter((id) => !submitted.has(id));
  require_(
    missing.length === 0 && submitted.size === event.lines.length,
    "M21_RECONCILIATION_LINE_COVERAGE_INCOMPLETE",
    missing.length > 0
      ? `${missing.length} dispatched line(s) were not accounted for in this reconciliation`
      : "a dispatched line was accounted for more than once",
  );

  for (const line of event.lines) {
    require_(
      isReturnLineCoherent(line),
      "M21_INVALID_RECONCILIATION_QUANTITY",
      `'${line.drugName}': returned + disposed-at-home exceeds what was dispatched`,
    );
  }

  const summary = computeReturnReconciliation(event.lines);
  const effects: SupplySideEffect[] = [
    { kind: "set_timestamp", field: "reconciled_at", at: event.at },
    {
      kind: "record_disposal",
      disposalMethod: event.disposalMethod,
      witnessMembershipId: event.disposalWitnessMembershipId,
      jurisdictionPolicyDigest: event.disposalMethodJurisdictionPolicyDigest,
    },
    {
      kind: "insert_returned_contents",
      lineCount: summary.lines.length,
      flaggedLineCount: summary.flaggedLineCount,
    },
    { kind: "outbox", event: "m21.comfort_kit.returned" },
    { kind: "outbox", event: "m21.comfort_kit.return_reconciliation" },
    { kind: "request_document", documentKind: "return_receipt" },
  ];
  if (summary.discrepancyDetected) {
    effects.push(
      { kind: "outbox", event: "m21.controlled_substance.discrepancy_detected" },
      { kind: "alert", alert: "m21.controlled_substance.discrepancy" },
    );
  }

  return {
    transition: result(state, "reconcile", "reconciled", withAudit(effects)),
    discrepancyDetected: summary.discrepancyDetected,
    flaggedLineCount: summary.flaggedLineCount,
    lines: event.lines.map((line, i) => ({
      dispatchedContentId: line.dispatchedContentId,
      // `summary.lines` is computed positionally from the same array, so index alignment is total.
      quantityUnaccounted: summary.lines[i]?.quantityUnaccounted ?? "0",
      discrepancyPct: summary.lines[i]?.discrepancyPct ?? 0,
      discrepancyFlagged: summary.lines[i]?.discrepancyFlagged ?? false,
    })),
  };
}

// ── §2.6 / §7.6 escalation scan ───────────────────────────────────────────────────────────────────────

/** What the daily `unreturned-kit-monitor` cron found on one open return. */
export type ReturnEscalationFinding =
  | { readonly kind: "none" }
  | {
      readonly kind: "overdue_30d" | "unreturnable_90d";
      readonly daysOverdue: number;
      /** §7.6 — `medium` at 30 days, `high` at the 90-day assumption-of-loss boundary. */
      readonly severity: "medium" | "high";
    };

/**
 * §2.6 / §7.6 — decide the escalation for one open return at `asOf`.
 *
 * The cron is idempotent by DESIGN rather than by bookkeeping: it re-derives the boundary from
 * `return_required_at` every night and M36 dedupes the repeat alerts (§7.5's stated division of labour).
 * A return already in a terminal state yields `none`, so a reconciled kit never re-escalates.
 */
export function detectReturnEscalation(
  input: {
    readonly state: ComfortKitReturnState;
    readonly returnRequiredAt: IsoInstant;
    readonly unreturnableDays?: number;
  },
  asOf: Date,
): ReturnEscalationFinding {
  if (input.state === "reconciled" || input.state === "unreturnable") return { kind: "none" };

  const requiredAt = new Date(input.returnRequiredAt);
  const escalation = returnEscalationAt(requiredAt, asOf, input.unreturnableDays);
  if (escalation === "none") return { kind: "none" };

  return {
    kind: escalation,
    daysOverdue: daysBetween(requiredAt, asOf),
    severity: escalation === "unreturnable_90d" ? "high" : "medium",
  };
}
