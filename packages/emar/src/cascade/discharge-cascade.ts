// @wardenx/emar — §2.5/§2.7 D14 admission-discharge + patient-deceased cascade (M13-T05). PURE, IO-free.
//
// On `m6.admission.discharged` (death, revocation, transfer-out) — and as a redundant safety signal on
// `m5.patient.deceased`, which "signals comfort-kit return" per the M5 dependency — M13's `cancel-future-
// schedule` worker fires this pure planner (D14):
//   - cancel every `scheduled_dose` with `due_at > dischargeAt` AND `status='pending'`, with
//     `cancellation_reason='admission_discharged'` and the originating `source_event_id`;
//   - NEVER retroactively mark anything missed — a past 0800 dose either has a linked administration or the
//     missed-dose-sweep will catch it on its own pass; retro-marking creates phantom missed-dose alerts;
//   - emit `m13.comfort_kit.return_required` for every still-active comfort-kit deployment.
// Idempotent on event dedup (the M1 outbox-consumer `(eventId, consumerName)` key). Pure — the scheduled-dose
// set, the active deployments, the discharge instant, and the source-event id are all injected; the worker
// (M13-T08) persists the cancellations + emits the signals in one transaction.
import type {
  AdmissionId,
  ComfortKitDeploymentId,
  IsoInstant,
  MedicationOrderId,
  PatientId,
  ScheduledDoseId,
  ScheduledDoseStatus,
} from "@wardenx/types";

/** The discharge-cascade source — both route into the same D14 plan; death is itself a discharge reason. */
export type CascadeSource = "admission_discharged" | "patient_deceased";

/** §2.3 — the minimal scheduled-dose facts the cascade reads (the worker projects these from the rows). */
export interface CascadeScheduledDose {
  readonly scheduledDoseId: ScheduledDoseId;
  readonly medicationOrderId: MedicationOrderId;
  readonly dueAt: IsoInstant;
  readonly status: ScheduledDoseStatus;
}

/** §2.7 — the minimal active-deployment facts the cascade reads (deployments still at the bedside). */
export interface CascadeActiveDeployment {
  readonly deploymentId: ComfortKitDeploymentId;
  /** The deployment's disposal lifecycle; only `deployed` (return not yet required) is cascaded. */
  readonly disposalStatus: string;
  /** Non-null once a prior cascade already emitted the return-required signal (idempotency guard). */
  readonly returnRequiredAt: IsoInstant | null;
}

/** §2.3 — the `m13.scheduled_dose.cancelled` payload (M33 consumes). */
export interface ScheduledDoseCancelledSignal {
  readonly scheduledDoseId: ScheduledDoseId;
  readonly medicationOrderId: MedicationOrderId;
  readonly cancellationReason: "admission_discharged";
  readonly sourceEventId: string;
}

/** §2.7 — the `m13.comfort_kit.return_required` payload (M21 forward seam + M36 + M33 consume). */
export interface ComfortKitReturnRequiredSignal {
  readonly deploymentId: ComfortKitDeploymentId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly returnRequiredAt: IsoInstant;
}

/** The facts the worker resolves for the D14 cascade (all injected; no IO). */
export interface DischargeCascadeInput {
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly dischargeAt: IsoInstant;
  /** The originating outbox event id, stamped onto each cancellation for provenance. */
  readonly sourceEventId: string;
  readonly source: CascadeSource;
  readonly scheduledDoses: readonly CascadeScheduledDose[];
  readonly activeDeployments: readonly CascadeActiveDeployment[];
}

/** The D14 cascade plan: the doses to cancel + the comfort-kit deployments that must be returned. */
export interface DischargeCascadePlan {
  readonly cancellations: readonly ScheduledDoseCancelledSignal[];
  readonly returnRequired: readonly ComfortKitReturnRequiredSignal[];
}

/** A scheduled dose is cancellable by the cascade iff it is still pending AND its due instant is future. */
function isCancellable(dose: CascadeScheduledDose, dischargeAt: IsoInstant): boolean {
  return dose.status === "pending" && Date.parse(dose.dueAt) > Date.parse(dischargeAt);
}

/** A deployment needs return iff it is still `deployed` and no prior cascade already required its return. */
function needsReturn(deployment: CascadeActiveDeployment): boolean {
  return deployment.disposalStatus === "deployed" && deployment.returnRequiredAt === null;
}

/**
 * §2.5/§2.7 D14 — plan the admission-discharge (or patient-deceased) cascade. Cancels only the FUTURE pending
 * scheduled doses (`due_at > dischargeAt`); past doses are left untouched (the missed-dose-sweep owns them).
 * Emits a `m13.comfort_kit.return_required` for every still-`deployed` kit with no prior return signal. The
 * cancellation reason is always `admission_discharged` (the only enum value for this cascade, shared by the
 * death path). Idempotent — re-running with the same already-cancelled doses / already-returned kits yields an
 * empty plan. Pure — no clock, no IO.
 */
export function planDischargeCascade(input: DischargeCascadeInput): DischargeCascadePlan {
  const cancellations: ScheduledDoseCancelledSignal[] = input.scheduledDoses
    .filter((dose) => isCancellable(dose, input.dischargeAt))
    .map((dose) => ({
      scheduledDoseId: dose.scheduledDoseId,
      medicationOrderId: dose.medicationOrderId,
      cancellationReason: "admission_discharged",
      sourceEventId: input.sourceEventId,
    }));
  const returnRequired: ComfortKitReturnRequiredSignal[] = input.activeDeployments
    .filter(needsReturn)
    .map((deployment) => ({
      deploymentId: deployment.deploymentId,
      patientId: input.patientId,
      admissionId: input.admissionId,
      returnRequiredAt: input.dischargeAt,
    }));
  return { cancellations, returnRequired };
}

// ── Return-overdue compliance sweep (nightly cron) ───────────────────────────────────────────────────────

/** §2.7 — unreturned kits this many days past `return_required_at` surface the return-overdue signal. */
export const RETURN_OVERDUE_DAYS = 30;

/** §2.7 — the `m13.comfort_kit.return_overdue` payload (M36 high + M30 consume). */
export interface ComfortKitReturnOverdueSignal {
  readonly deploymentId: ComfortKitDeploymentId;
  readonly daysOverdue: number;
}

/** §2.7 — the result of the return-overdue evaluation for one deployment. */
export interface ReturnOverdueResult {
  readonly overdue: boolean;
  readonly daysOverdue: number;
  readonly signal: ComfortKitReturnOverdueSignal | null;
}

/**
 * §2.7 — evaluate whether a deployment whose return was required (`returnRequiredAt`) has gone unreturned past
 * the 30-day compliance window as of `nowIso`. Returns the `m13.comfort_kit.return_overdue` signal once the
 * elapsed whole-day count reaches the threshold. The clock is INJECTED (`nowIso`) so the cron is testable with
 * no `Date.now()`. Pure.
 */
export function evaluateReturnOverdue(
  deploymentId: ComfortKitDeploymentId,
  returnRequiredAt: IsoInstant,
  nowIso: IsoInstant,
): ReturnOverdueResult {
  const elapsedMs = Date.parse(nowIso) - Date.parse(returnRequiredAt);
  const daysOverdue = Math.floor(elapsedMs / 86_400_000);
  const overdue = daysOverdue >= RETURN_OVERDUE_DAYS;
  return {
    overdue,
    daysOverdue,
    signal: overdue ? { deploymentId, daysOverdue } : null,
  };
}
