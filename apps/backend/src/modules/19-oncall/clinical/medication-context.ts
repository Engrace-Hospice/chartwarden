// apps/backend/src/modules/19-oncall/clinical/medication-context.ts — M19-T05 (D15, §4.4, §5.1, §7.7).
//
// THE M12 READ SURFACE. D15's clinical case is concrete: the triage clinician at 2 a.m. needs to know
// whether the caller is asking for a refill they already have pending, and whether the patient is out of
// pain medication for a documented reason. Both facts live in M12, and M19 reads them through the two
// published seams — `RefillInboxProvider.getPendingRefillsForPatient` and
// `MedicationOrderProvider.getActiveMedications`. STRICTLY read-only: a PRN or refill authorized during the
// call becomes the `prn_intervention_authorized` disposition plus the
// `m19.triage_call.disposition_selected` outbox event M12's own consumer acts on. M19 never writes M12.
//
// "UNREADABLE" AND "EMPTY" ARE DIFFERENT VALUES — the M19-T04 roster finding, and it bites harder here. An
// M12 outage caught into `[]` renders as "no active medications" on the panel, and an RN who reads that
// screen at 2 a.m. will authorize against a chart they believe is empty. The two slices are therefore
// independently discriminated: M12 can be half-up (the refill read fails, the medication read succeeds) and
// the panel must be able to say so per surface rather than blanking both or, worse, showing one as fact and
// the other as absence.
//
// THE SUD GATE IS A REQUIRED ARGUMENT, not an optional post-step. 42 CFR Part 2 medications are flagged by
// M12 (`isSudTreatment`, derived from M38's value set) and disclosing them needs an M39 consent decision.
// Making `sudDisclosurePermitted` a mandatory parameter means no caller can obtain an unredacted list by
// forgetting to redact — the unredacted projection never exists as a value. `false` is the safe answer and
// the one T07 passes whenever `ConsentEvaluator` is unavailable or denies.
import type {
  MedicationOrderDto,
  MedicationOrderId,
  OrgId,
  PatientId,
  RefillRequestDto,
} from "@chartwarden/types";
import { require_ } from "../lifecycle/errors";
import { getMedicationOrderProvider, getRefillInboxProvider } from "../seams/consumed";

/** One active medication as the §5.1 triage panel shows it — the minimum-necessary projection of M12's
 *  `MedicationOrderDto`. Prescriber ids, pharmacy ids, NDC/RxCUI codes and the transmission timeline are
 *  all omitted: none of them changes a triage disposition, and the same projection is what a §7.5 vendor
 *  boundary would have to start from (the vendor filter itself is T07's `@chartwarden/triage-vendors` work). */
export interface TriageMedicationSummary {
  readonly medicationOrderId: MedicationOrderId;
  /** `drugName strength doseForm` — what the RN reads back to the caller. */
  readonly display: string;
  readonly route: string;
  /** True when M12's structured sig marks the medication as PRN — the ones a triage call is usually about. */
  readonly asNeeded: boolean;
  readonly isControlledSubstance: boolean;
  readonly deaSchedule: string | null;
  /** True when the row is a placeholder standing in for a redacted 42 CFR Part 2 medication. */
  readonly isRedacted: boolean;
}

/** One pending refill as the panel shows it. */
export interface TriageRefillSummary {
  readonly refillRequestId: string;
  readonly sourceMedicationOrderId: MedicationOrderId;
  readonly requestedAt: string;
  readonly requestedQuantity: number | null;
}

/**
 * One M12-sourced slice. `unavailable` is not an error the caller must handle to see the rest of the
 * panel — it is a fact the panel RENDERS ("medication list unavailable"), which is the difference between
 * a clinician who knows they are working blind and one who does not.
 */
export type TriageMedicationSlice<T> =
  | { readonly kind: "ready"; readonly items: readonly T[] }
  | { readonly kind: "unavailable"; readonly reason: string };

/** D15 — the medication context behind one triage call. */
export interface TriageMedicationContext {
  readonly activeMedications: TriageMedicationSlice<TriageMedicationSummary>;
  readonly pendingRefills: TriageMedicationSlice<TriageRefillSummary>;
  /** How many active medications were withheld under the 42 CFR Part 2 gate. Surfaced as a COUNT, never as
   *  the rows: the clinician must know the list is incomplete (otherwise "no opioid on file" reads as a
   *  clinical fact), and the count alone discloses no Part-2 information about any one medication. */
  readonly sudRedactedCount: number;
}

/** The §5.1 projection of one M12 medication row. */
function summarize(dto: MedicationOrderDto): TriageMedicationSummary {
  return {
    medicationOrderId: dto.id,
    display: `${dto.drugName} ${dto.strength} ${dto.doseForm}`.trim(),
    route: dto.route,
    asNeeded: dto.sigStructured.asNeeded,
    isControlledSubstance: dto.isControlledSubstance,
    deaSchedule: dto.deaSchedule,
    isRedacted: false,
  };
}

/**
 * §7.8 / D15 — apply the 42 CFR Part 2 gate to a medication list.
 *
 * A withheld medication is DROPPED, not blanked in place: a redacted row that keeps its DEA schedule or its
 * route re-identifies the medication class to anyone who reads a formulary, which is the disclosure the
 * gate exists to prevent. The count travels alongside (see `sudRedactedCount`) so the omission is visible
 * without the content being.
 */
export function redactSudMedications(
  medications: readonly MedicationOrderDto[],
  sudDisclosurePermitted: boolean,
): { readonly kept: readonly TriageMedicationSummary[]; readonly redactedCount: number } {
  if (sudDisclosurePermitted) {
    return { kept: medications.map(summarize), redactedCount: 0 };
  }
  const kept = medications.filter((m) => !m.isSudTreatment).map(summarize);
  return { kept, redactedCount: medications.length - kept.length };
}

/** The §5.1 projection of one M12 refill row. */
function summarizeRefill(dto: RefillRequestDto): TriageRefillSummary {
  return {
    refillRequestId: dto.id,
    sourceMedicationOrderId: dto.sourceMedicationOrderId,
    requestedAt: dto.requestedAt,
    requestedQuantity: dto.requestedQuantity,
  };
}

/**
 * D15 — read the medication context for a triage call.
 *
 * The two seam reads are independent and independently degradable (see the file header). Neither throws:
 * this surface is advisory context on a screen the RN is already on, and an M12 outage must not prevent a
 * triage call from being handled — §2.7 lists no degraded class for M12 precisely because the call
 * lifecycle does not depend on it.
 *
 * `sudDisclosurePermitted` is the M39 `ConsentEvaluator` verdict, resolved by the caller (T07). Passing
 * `false` when the evaluator is unavailable is the fail-closed default.
 */
export async function readTriageMedicationContext(input: {
  readonly organizationId: OrgId;
  readonly patientId: PatientId;
  readonly sudDisclosurePermitted: boolean;
}): Promise<TriageMedicationContext> {
  let activeMedications: TriageMedicationSlice<TriageMedicationSummary>;
  let sudRedactedCount = 0;
  try {
    const rows = await getMedicationOrderProvider().getActiveMedications(
      input.organizationId,
      input.patientId,
    );
    const { kept, redactedCount } = redactSudMedications(rows, input.sudDisclosurePermitted);
    activeMedications = { kind: "ready", items: kept };
    sudRedactedCount = redactedCount;
  } catch (error) {
    activeMedications = {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : "MedicationOrderProvider read failed",
    };
  }

  let pendingRefills: TriageMedicationSlice<TriageRefillSummary>;
  try {
    const rows = await getRefillInboxProvider().getPendingRefillsForPatient(
      input.organizationId,
      input.patientId,
    );
    pendingRefills = { kind: "ready", items: rows.map(summarizeRefill) };
  } catch (error) {
    pendingRefills = {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : "RefillInboxProvider read failed",
    };
  }

  return { activeMedications, pendingRefills, sudRedactedCount };
}

/** What a validated `prn_intervention_authorized` target resolves to. */
export interface PrnAuthorizationTarget {
  readonly medicationOrderId: MedicationOrderId;
  readonly display: string;
  readonly isControlledSubstance: boolean;
  readonly deaSchedule: string | null;
}

/**
 * D15 — validate the M12 medication order a `prn_intervention_authorized` disposition names.
 *
 * §2.3's "linked-encounter integrity" rule generalized: a cross-module id on an M19 row is validated at the
 * write boundary through the OWNER's seam, never by a SQL FK. `../lifecycle/disposition` already refuses a
 * payload naming neither id; this is the read that turns "an id was supplied" into "the order exists".
 *
 * ONLY THE M12 ARM IS VALIDATED, and that gap is named rather than papered over. The payload's other arm is
 * an M11 `orderRecordId`, and §4.4 grants M19 exactly one M11 seam — `OrderSignatureProvider`, a WRITE
 * primitive with no read path. Validating it would mean consuming M11's `OrderProvider`, i.e. widening
 * M19's consumed-seam set beyond the locked §4.4 list, which is a spec change and not this task's to make.
 * So an M11-only PRN payload passes the non-null check and no more; the T07 route records that asymmetry in
 * the audit entry rather than implying a check it did not perform.
 *
 * Unlike the panel read above this THROWS: a disposition is a write, and writing a PRN authorization
 * against an order M12 will not confirm is the shape M13 cannot administer against.
 */
export async function validatePrnAuthorizationTarget(input: {
  readonly organizationId: OrgId;
  readonly medicationOrderId: MedicationOrderId;
}): Promise<PrnAuthorizationTarget> {
  const order = await getMedicationOrderProvider().getMedicationOrder(
    input.organizationId,
    input.medicationOrderId,
  );
  require_(
    order !== null,
    "PRN_TARGET_NOT_FOUND",
    `medication order ${input.medicationOrderId} was not returned by M12 for this tenant`,
  );
  return {
    medicationOrderId: order.id,
    display: `${order.drugName} ${order.strength} ${order.doseForm}`.trim(),
    isControlledSubstance: order.isControlledSubstance,
    deaSchedule: order.deaSchedule,
  };
}
