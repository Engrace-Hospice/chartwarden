// apps/backend/src/modules/21-supplies/lifecycle/dispatch.ts — M21-T03 (§2.5 / D6 / D17).
//
// The physical kit: what left the hub, in what lots, expiring when, handed to whom. This is the head of the
// 21 CFR §1304 chain of custody, so every rule here fails CLOSED — a line that cannot prove its identity
// does not ship, and §2.5 is explicit that a failed dispatch insert rolls the whole `ordered` transition
// back with the request left in `vendor_assigned`.
//
// The five refusals, and why each is not merely a validation:
//
//   • **Dispatcher not controlled-substance-eligible** → the person handing over a CII solution must be one
//     the org authorized to do it. Checked only when the kit actually CONTAINS a controlled line: making a
//     glove box require a DEA-eligible dispatcher would push agencies to grant the credential broadly.
//   • **Expiration inside the window** → a morphine solution expiring in three weeks reaches a patient who
//     may need it in five. The tenant may tighten the 30-day default; the 14-day SQL floor is not
//     negotiable, and a tenant policy below it gets the floor rather than its own looser number.
//   • **Missing lot on a controlled line** → the lot IS the identity of the physical unit in the perpetual
//     log. Without it, a later reconciliation cannot say which bottle came back.
//   • **Expiration missing when a lot is present** → a lot number with no expiration is half a record; the
//     pair is what the DEA log reads.
//   • **Line not in the template** → a kit assembled off-recipe has no floor to reconcile against.
//
// PURE — every fact (the ABAC answer, the template lines, the tenant's expiration policy) arrives resolved.
import {
  CONTROLLED_EXPIRATION_MIN_DAYS_DEFAULT,
  isControlledExpirationAcceptable,
  missingFloorMedications,
} from "@chartwarden/supplies";
import type {
  ComfortKitDispatchSource,
  ComfortKitDispatchStatus,
  ComfortKitTemplateMedicationId,
  ControlledSubstanceSchedule,
  IsoInstant,
  LocalDate,
  MembershipId,
  PharmacyDispatchMode,
} from "@chartwarden/types";
import { type SupplySideEffect, type SupplyTransitionResult, result, withAudit } from "./effects";
import { SupplyStateError, require_ } from "./errors";

/** One `comfort_kit_dispatched_content` line as the validator sees it (§2.5). Quantities are decimal
 *  STRINGS — the column is `numeric`, and a 0.1 mL that round-trips through a float is not the number the
 *  DEA log recorded. */
export interface DispatchLineInput {
  readonly comfortKitTemplateMedicationId: ComfortKitTemplateMedicationId;
  readonly drugName: string;
  readonly isControlledSubstance: boolean;
  readonly controlledSubstanceSchedule: ControlledSubstanceSchedule | null;
  readonly dispatchedQuantity: string;
  readonly dispatchedUnit: string;
  readonly lotNumber: string | null;
  readonly expirationDate: LocalDate | null;
}

/** What the dispatch validator needs beyond the lines themselves. */
export interface DispatchValidationContext {
  /** Every `comfort_kit_template_medication.id` on the referenced template. */
  readonly templateMedicationIds: ReadonlyArray<ComfortKitTemplateMedicationId>;
  /** The subset of the above that is platform floor (`system_locked` / `is_platform_floor`). */
  readonly floorTemplateMedicationIds: ReadonlyArray<ComfortKitTemplateMedicationId>;
  /** The §4.4 `controlled_substance_dispatcher_eligible` answer for the dispatching membership. */
  readonly dispatcherControlledEligible: boolean;
  /** Tenant expiration policy in days; the 14-day platform floor is applied inside the checker. */
  readonly controlledExpirationMinDays?: number;
  /** The instant the kit physically leaves — expirations are measured from THIS, not from now. */
  readonly dispatchedAt: Date;
  /** `comfort_kit_replenish` ships only the lines that crossed threshold, so the floor-coverage rule does
   *  not apply to it (§2.1: "contents is a subset of the original deployment"). */
  readonly isReplenishment: boolean;
}

/**
 * §2.5 / §2.10 — validate the whole dispatch. Throws the FIRST failure with its specific code, because each
 * of these is a stop-work condition with its own remedy (find an eligible dispatcher / pull a different lot
 * / re-open the recipe), not a form to fix field by field.
 */
export function assertDispatchValid(
  lines: ReadonlyArray<DispatchLineInput>,
  ctx: DispatchValidationContext,
): void {
  require_(
    lines.length > 0,
    "M21_DISPATCH_CONTENTS_EMPTY",
    "a comfort-kit dispatch with no medication lines is a chain-of-custody record of nothing",
  );

  const templateIds = new Set(ctx.templateMedicationIds);
  const containsControlled = lines.some((l) => l.isControlledSubstance);

  if (containsControlled) {
    require_(
      ctx.dispatcherControlledEligible,
      "M21_CONTROLLED_SUBSTANCE_DISPATCHER_DENIED",
      "this kit contains a CII–CV medication; the dispatching member must hold the controlled-substance dispatcher credential",
    );
  }

  for (const line of lines) {
    require_(
      templateIds.has(line.comfortKitTemplateMedicationId),
      "M21_DISPATCH_CONTENT_NOT_IN_TEMPLATE",
      `'${line.drugName}' is not a medication of the referenced comfort-kit template`,
    );
    require_(
      Number.parseFloat(line.dispatchedQuantity) > 0 && line.dispatchedUnit.trim().length > 0,
      "M21_DISPATCH_QUANTITY_INVALID",
      `'${line.drugName}': a dispatched quantity must be positive and carry its unit`,
    );
    require_(
      line.isControlledSubstance === (line.controlledSubstanceSchedule !== null),
      "M21_CONTROLLED_SCHEDULE_MISMATCH",
      `'${line.drugName}': is_controlled_substance and the DEA schedule must move together`,
    );

    if (line.isControlledSubstance) {
      require_(
        line.lotNumber !== null && line.lotNumber.trim().length > 0,
        "M21_LOT_NUMBER_REQUIRED",
        `'${line.drugName}': a controlled-substance line must carry its lot number — the lot is its identity in the perpetual log`,
      );
    }
    if (line.lotNumber !== null && line.lotNumber.trim().length > 0) {
      require_(
        line.expirationDate !== null,
        "M21_EXPIRATION_REQUIRED_WITH_LOT",
        `'${line.drugName}': a lot number with no expiration date is half a DEA record`,
      );
    }
    if (line.isControlledSubstance && line.expirationDate !== null) {
      require_(
        isControlledExpirationAcceptable(
          new Date(line.expirationDate),
          ctx.dispatchedAt,
          ctx.controlledExpirationMinDays ?? CONTROLLED_EXPIRATION_MIN_DAYS_DEFAULT,
        ),
        "M21_CONTROLLED_EXPIRATION_WINDOW",
        `'${line.drugName}' expires ${line.expirationDate}, inside the controlled-substance dispatch window measured from ${ctx.dispatchedAt.toISOString()}`,
      );
    }
  }

  // §2.10 defense-in-depth: the template's `system_locked` flag already blocks removing a floor medication
  // recipe-side; this catches the kit assembled BY HAND that simply left one out. A replenishment is
  // exempt by construction — it ships only what crossed threshold.
  if (!ctx.isReplenishment) {
    const missing = missingFloorMedications(
      lines.map((l) => l.comfortKitTemplateMedicationId),
      ctx.floorTemplateMedicationIds,
    );
    if (missing.length > 0) {
      throw new SupplyStateError(
        "M21_TEMPLATE_VIOLATES_PLATFORM_FLOOR",
        `the dispatch omits ${missing.length} platform-floor medication(s): ${missing.join(", ")}`,
      );
    }
  }
}

/** §2.5 — the immutable dispatch header a validated dispatch produces. */
export interface DispatchHeaderInput {
  readonly kitSerialNumber: string;
  readonly dispatchedByMembershipId: MembershipId;
  readonly dispatchSource: ComfortKitDispatchSource;
  readonly pharmacyDispatchMode: PharmacyDispatchMode;
  readonly pharmacyPartnerId: string | null;
  /** sha256 of the template's controlled-substance handling policy AS DISPATCHED (§2.5) — frozen so a
   *  later policy edit cannot retroactively change what the courier was instructed to do. */
  readonly controlledSubstanceHandlingPolicyDigest: string;
}

/**
 * §2.5 — the dispatch-side of the `ordered` transition: validate, then declare the writes. The caller runs
 * these in the same transaction as {@link transitionSupplyRequest}'s `placeOrderWithVendor` result.
 */
export function prepareDispatch(
  lines: ReadonlyArray<DispatchLineInput>,
  header: DispatchHeaderInput,
  ctx: DispatchValidationContext,
): ReadonlyArray<SupplySideEffect> {
  assertDispatchValid(lines, ctx);
  require_(
    header.kitSerialNumber.trim().length > 0,
    "M21_KIT_SERIAL_REQUIRED",
    "a dispatched kit must carry the supply-hub barcode it will be scanned by",
  );
  require_(
    header.controlledSubstanceHandlingPolicyDigest.trim().length > 0,
    "M21_HANDLING_POLICY_DIGEST_REQUIRED",
    "the controlled-substance handling policy digest must be frozen onto the dispatch",
  );
  return withAudit([
    { kind: "create_dispatch", lineCount: lines.length },
    { kind: "set_dispatch_status", status: "dispatched" },
    { kind: "outbox", event: "m21.comfort_kit.dispatched" },
    { kind: "request_document", documentKind: "bill_of_lading" },
  ]);
}

// ── M21-F04 — the dispatch row's OWN status machine ───────────────────────────────────────────────────
//
// It deliberately does not track the request status: the request goes terminal at deployment while the
// dispatch stays live through the whole return + reconciliation tail, which is the part a surveyor reads.

/** The §2.5 / §2.6 dispatch-status events. */
export type ComfortKitDispatchEvent =
  | {
      /** §7.2 — the kit is physically at the patient. Gated on `dispatched` so two racing deploys are safe. */
      readonly type: "deployAtPatient";
      readonly deployedByMembershipId: MembershipId;
      readonly at: IsoInstant;
      /** `comfort_kit_replenish` tops up an existing M13 deployment instead of creating one. */
      readonly isReplenishment: boolean;
    }
  | {
      /** §2.5 — M13's `m13.comfort_kit.deployed` ack. Status unchanged; only the link is written. */
      readonly type: "linkM13Deployment";
      readonly m13DeploymentId: string;
    }
  | {
      /** §7.3 — some lines came back; the rest are still out. */
      readonly type: "recordPartialReturn";
    }
  | {
      readonly type: "recordFullReturn";
    }
  | {
      /** §2.6 — the return reconciled. The discrepancy flag picks the terminal status. */
      readonly type: "recordReconciliation";
      readonly discrepancyDetected: boolean;
    };

export type ComfortKitDispatchTransitionResult = SupplyTransitionResult<
  ComfortKitDispatchStatus,
  ComfortKitDispatchEvent["type"]
>;

/** The legal dispatch-status graph (from → events accepted). `linkM13Deployment` appears on every
 *  non-terminal status because M13's ack can land late (§7.2's "M13 down" edge case is explicitly
 *  non-fatal), and dropping it would leave the dispatch unlinked forever. */
export const COMFORT_KIT_DISPATCH_GRAPH: Readonly<
  Record<ComfortKitDispatchStatus, ReadonlyArray<ComfortKitDispatchEvent["type"]>>
> = {
  dispatched: ["deployAtPatient", "linkM13Deployment"],
  deployed_at_patient: ["linkM13Deployment", "recordPartialReturn", "recordFullReturn"],
  partially_returned: ["linkM13Deployment", "recordPartialReturn", "recordFullReturn"],
  fully_returned: ["linkM13Deployment", "recordReconciliation"],
  reconciled: [],
  reconciled_with_discrepancy: [],
} as const;

/** §2.5 / §2.6 — apply one dispatch-status event. */
export function transitionComfortKitDispatch(
  status: ComfortKitDispatchStatus,
  event: ComfortKitDispatchEvent,
): ComfortKitDispatchTransitionResult {
  const accepted = COMFORT_KIT_DISPATCH_GRAPH[status];
  if (!accepted.includes(event.type)) {
    // §7.2 words the racing-deploy failure as the request-side code, because that is what the second
    // coordinator's submit hit; every other illegal dispatch move is the dispatch-side code.
    const code =
      event.type === "deployAtPatient"
        ? "M21_DISPATCH_NOT_DEPLOYABLE"
        : "M21_DISPATCH_STATUS_TRANSITION_INVALID";
    throw new SupplyStateError(
      code,
      `'${event.type}' is not legal from dispatch status '${status}'`,
    );
  }

  switch (event.type) {
    case "deployAtPatient":
      return result(
        status,
        event.type,
        "deployed_at_patient",
        withAudit([
          { kind: "set_timestamp", field: "deployed_at_patient_at", at: event.at },
          {
            kind: "outbox",
            event: event.isReplenishment
              ? "m21.comfort_kit.replenished"
              : "m21.comfort_kit.deployed_at_patient",
          },
        ]),
      );

    case "linkM13Deployment":
      // Status is UNCHANGED on purpose — the ack tells us M13 built its row, not that the kit moved.
      return result(
        status,
        event.type,
        status,
        withAudit([{ kind: "link_m13_deployment", m13DeploymentId: event.m13DeploymentId }]),
      );

    case "recordPartialReturn":
      return result(
        status,
        event.type,
        "partially_returned",
        withAudit([{ kind: "set_dispatch_status", status: "partially_returned" }]),
      );

    case "recordFullReturn":
      return result(
        status,
        event.type,
        "fully_returned",
        withAudit([{ kind: "set_dispatch_status", status: "fully_returned" }]),
      );

    case "recordReconciliation": {
      const to: ComfortKitDispatchStatus = event.discrepancyDetected
        ? "reconciled_with_discrepancy"
        : "reconciled";
      return result(
        status,
        event.type,
        to,
        withAudit([{ kind: "set_dispatch_status", status: to }]),
      );
    }
  }
}
