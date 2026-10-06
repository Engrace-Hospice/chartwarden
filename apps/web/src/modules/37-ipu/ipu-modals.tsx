import {
  Button,
  EntityLookupField,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/37-ipu — the M37 write ceremonies (#91).
//
// An inpatient unit is staffed around the clock by people who change every shift, and every ceremony
// here is one that a LATER shift performs on something an EARLIER one created. That is why #169 and
// #172 had to land first: three of these writes were keyed by ids no read route returned, so the only
// caller who could ever perform them was the browser session that did the create.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES (ADR-0030 — no frontend authz).
//
//   • §2.10 / CoP 418.110 — the physician order. The picker offers this patient's SIGNED orders, so the
//     three refusals it can see are unreachable from it; it is a convenience and never the check. The
//     fourth ("the order names no ordering physician") is not visible from here at all, which is
//     precisely why the server answers all four separately.
//   • §2.10 — the reassessment cadence. 15 minutes behavioral, 120 medical, TIGHTEN-ONLY. The form
//     states the ceiling beside the field and lets a number through that exceeds it; the server answers
//     `RESTRAINT_INTERVAL_NOT_TIGHTENING` and the copy explains the direction, because a form that
//     silently clamps a clinician's number teaches them nothing about the rule.
//   • §2.3 D3 — RN coverage. Resolved inside the write transaction against `ipu_rn_coverage_window`;
//     nothing here reads a clock and disables a button on it.
//   • §2.2 — the discharge precondition is M6's, resolved through `AdmissionStatusReader` (#172). The
//     Discharge dialog has no checkbox for it and never had a right to one.
//   • Step-up on restraint apply, GIP attest and the IRC cap override is resolved from the M2 session.
//
// Every reason box counts characters against the domain floor. A restraint justification is not
// paperwork: it is the record of why a dying person was physically restrained, and it is what a surveyor
// reads. Counting in the form means a nurse learns it is 40 characters short while writing rather than
// after losing the text to a 422.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import {
  type AdmissionView,
  type ApplyRestraintBody,
  type BedOption,
  type DischargeReason,
  GIP_HOME_ASSESSMENT_MIN,
  GIP_RATIONALE_MIN,
  GIP_REASSESS_RATIONALE_MIN,
  IRC_CAP_DAYS,
  IRC_CAP_OVERRIDE_MAX_DAYS,
  IRC_CAP_OVERRIDE_REASON_MIN,
  type IrcEpisodeRow,
  type OrderOption,
  RESTRAINT_JUSTIFICATION_MIN,
  RESTRAINT_REASSESS_FLOOR_MINUTES,
  type RestraintCategory,
  type RestraintRow,
  type UnitOption,
  type VisitorRow,
  type WriteResult,
  applyRestraint,
  applyVisitorRestriction,
  assignBed,
  attestGipCriteria,
  checkInVisitor,
  checkOutVisitor,
  confirmTransfer,
  dischargeAdmission,
  initiateTransfer,
  liftVisitorRestriction,
  loadBedsForUnit,
  loadSignedOrdersForPatient,
  loadUnits,
  overrideIrcCap,
  reassessGipCriteria,
  reassessRestraint,
  releaseRestraint,
  requestBed,
  searchPhysicians,
} from "./ipu-api";

const shell = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.875rem",
} as const;
const title = { margin: 0, fontSize: "1.05rem", fontWeight: 600 } as const;
const meta = { margin: 0, fontSize: "0.75rem", color: "var(--color-on-surface-variant)" } as const;
const errorText = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" } as const;
const footer = { display: "flex", gap: "0.5rem", justifyContent: "flex-end" } as const;
const row2 = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" } as const;

/** Shared submit plumbing: one busy flag, one in-place error, close only on success. */
function useCeremony<T>(open: boolean, onDone: (v: T) => void, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
  }, [open]);
  const run = async (fn: () => Promise<WriteResult<T>>): Promise<void> => {
    setBusy(true);
    setError(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDone(res.value);
    onClose();
  };
  return { busy, error, run };
}

/** A textarea of "one per line" free text → the array the payload's list fields take. */
function lines(value: string): string[] {
  return value
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** "23 more characters" — counted against the domain floor, never used to disable the submit. */
function shortfall(value: string, min: number): number {
  return Math.max(0, min - value.trim().length);
}

function reasonHint(value: string, min: number): ReactNode {
  const missing = shortfall(value, min);
  return missing > 0
    ? `${missing} more character${missing === 1 ? "" : "s"} (minimum ${min}).`
    : `${value.trim().length} characters.`;
}

// ── admission lifecycle ────────────────────────────────────────────────────────────────────────────────

/** The five §2.2 transitions this surface offers from the admissions worklist. */
export type AdmissionAction =
  | "requestBed"
  | "assignBed"
  | "initiateTransfer"
  | "confirmTransfer"
  | "discharge";

const ADMISSION_COPY: Record<
  AdmissionAction,
  { readonly heading: string; readonly submit: string; readonly note: string }
> = {
  requestBed: {
    heading: "Request a bed",
    submit: "Send bed request",
    note: "The unit must have active RN coverage for the current hour (§2.3, CoP 418.110(e)); the server checks it when the request is made.",
  },
  assignBed: {
    heading: "Assign a bed",
    submit: "Confirm bed assignment",
    note: "The bed is reserved on assignment and becomes occupied once M6 acknowledges the level-of-care period and the admission activates. A bed that is not ready is refused.",
  },
  initiateTransfer: {
    heading: "Initiate a transfer",
    submit: "Initiate transfer",
    note: "A transfer to another unit is refused unless that unit has active RN coverage. The destination confirms the handover separately.",
  },
  confirmTransfer: {
    heading: "Confirm the transfer",
    submit: "Record handover",
    note: "Confirming records that the destination acknowledged the handover and releases the source bed for cleaning.",
  },
  discharge: {
    heading: "Discharge from the unit",
    submit: "Confirm discharge",
    // The single most important line in this file. The precondition is real and it is not this form's.
    note: "The M6 admission must already be discharged — the IPU stay is closed out behind that record, not ahead of it. The bed goes to cleaning and the assignment ends.",
  },
};

const DISCHARGE_REASONS: { value: DischargeReason; label: string }[] = [
  { value: "to_home", label: "To home" },
  { value: "to_facility", label: "To another facility" },
  { value: "to_other_hospice", label: "To another hospice" },
  { value: "revocation", label: "Benefit revoked" },
  { value: "expired_benefit", label: "Benefit expired" },
];

export function AdmissionActionModal({
  open,
  action,
  admissionId,
  onClose,
  onDone,
}: {
  open: boolean;
  action: AdmissionAction | null;
  admissionId: string | null;
  onClose: () => void;
  onDone: (v: AdmissionView) => void;
}): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<AdmissionView>(open, onDone, onClose);
  const [unitId, setUnitId] = useState("");
  const [bedId, setBedId] = useState("");
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [beds, setBeds] = useState<BedOption[]>([]);
  const [reason, setReason] = useState<DischargeReason>("to_home");
  const [targetKind, setTargetKind] =
    useState<NonNullable<Parameters<typeof initiateTransfer>[2]>["targetKind"]>("to_unit");
  const [transferReason, setTransferReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setUnitId("");
    setBedId("");
    setBeds([]);
    setReason("to_home");
    setTargetKind("to_unit");
    setTransferReason("");
  }, [open]);

  // The unit roster is needed by request-bed, assign-bed (to reach its beds) and a to_unit transfer.
  const needsUnits =
    action === "requestBed" || action === "assignBed" || action === "initiateTransfer";
  useEffect(() => {
    if (!open || !needsUnits) return;
    let cancelled = false;
    void loadUnits(client).then((u) => {
      if (!cancelled) setUnits(u);
    });
    return () => {
      cancelled = true;
    };
  }, [open, needsUnits, client]);

  // Beds are reached rooms-then-beds; there is no unit-wide bed list route.
  useEffect(() => {
    if (!open || action !== "assignBed" || !unitId) {
      return;
    }
    let cancelled = false;
    void loadBedsForUnit(client, unitId).then((b) => {
      if (!cancelled) setBeds(b);
    });
    return () => {
      cancelled = true;
    };
  }, [open, action, unitId, client]);

  if (!open || !action || !admissionId) return null;
  const copy = ADMISSION_COPY[action];

  const submit = (): void => {
    void run(() => {
      switch (action) {
        case "requestBed":
          return requestBed(client, admissionId, unitId);
        case "assignBed":
          return assignBed(client, admissionId, bedId);
        case "confirmTransfer":
          return confirmTransfer(client, admissionId);
        case "discharge":
          return dischargeAdmission(client, admissionId, reason);
        case "initiateTransfer":
          return initiateTransfer(client, admissionId, {
            targetKind,
            ...(targetKind === "to_unit" && unitId ? { destinationUnitId: unitId } : {}),
            ...(transferReason.trim() ? { reason: transferReason.trim() } : {}),
          });
      }
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={copy.heading}
      role={action === "discharge" ? "alertdialog" : "dialog"}
      width="34rem"
    >
      <div style={shell}>
        <h2 style={title}>{copy.heading}</h2>
        <p style={meta}>{copy.note}</p>

        {action === "requestBed" || (action === "initiateTransfer" && targetKind === "to_unit") ? (
          <SelectField
            label="Unit"
            required
            value={unitId}
            onChange={(e) => setUnitId(e.target.value)}
            options={[
              { value: "", label: "Select a unit" },
              ...units.map((u) => ({ value: u.id, label: u.displayName })),
            ]}
          />
        ) : null}

        {action === "assignBed" ? (
          <>
            <SelectField
              label="Unit"
              required
              value={unitId}
              onChange={(e) => {
                setUnitId(e.target.value);
                setBedId("");
              }}
              options={[
                { value: "", label: "Select a unit" },
                ...units.map((u) => ({ value: u.id, label: u.displayName })),
              ]}
            />
            <SelectField
              label="Bed"
              required
              value={bedId}
              onChange={(e) => setBedId(e.target.value)}
              // Beds that are not ready are LISTED, with their status. Hiding them would leave a
              // coordinator with an empty picker and no explanation.
              hint="A bed that is not ready is refused by the server, with its current cleaning status."
              options={[
                { value: "", label: unitId ? "Select a bed" : "Choose a unit first" },
                ...beds.map((b) => ({
                  value: b.id,
                  label: `${b.bedLabel} — ${b.cleaningStatus.replace(/_/g, " ")}`,
                })),
              ]}
            />
          </>
        ) : null}

        {action === "initiateTransfer" ? (
          <>
            <SelectField
              label="Transfer to"
              required
              value={targetKind}
              onChange={(e) => setTargetKind(e.target.value as typeof targetKind)}
              options={[
                { value: "to_unit", label: "Another inpatient unit" },
                { value: "to_home", label: "Home" },
                { value: "to_facility", label: "Another facility" },
              ]}
            />
            <TextAreaField
              label="Reason"
              value={transferReason}
              onChange={(e) => setTransferReason(e.target.value)}
              hint="Optional. Recorded on the transfer."
            />
          </>
        ) : null}

        {action === "discharge" ? (
          <SelectField
            label="Discharge reason"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value as DischargeReason)}
            options={DISCHARGE_REASONS}
          />
        ) : null}

        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone={action === "discharge" ? "danger" : "primary"}
            onClick={submit}
            disabled={busy}
          >
            {busy ? "Working…" : copy.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── restraint ──────────────────────────────────────────────────────────────────────────────────────────

const RESTRAINT_KINDS: { value: ApplyRestraintBody["restraintKind"]; label: string }[] = [
  { value: "soft_limb", label: "Soft limb restraint" },
  { value: "posey_vest", label: "Posey vest" },
  { value: "mitt", label: "Mitt" },
  { value: "side_rail_4", label: "Four side rails raised" },
];

export function ApplyRestraintModal({
  open,
  admissionId,
  patientId,
  onClose,
  onDone,
}: {
  open: boolean;
  admissionId: string;
  patientId: string;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<unknown>(open, onDone, onClose);
  const [restraintKind, setRestraintKind] =
    useState<ApplyRestraintBody["restraintKind"]>("soft_limb");
  const [category, setCategory] = useState<RestraintCategory>("behavioral");
  const [orderingOrderId, setOrderingOrderId] = useState("");
  const [justification, setJustification] = useState("");
  const [interval, setInterval] = useState("15");
  const [orders, setOrders] = useState<OrderOption[]>([]);

  useEffect(() => {
    if (!open) return;
    setRestraintKind("soft_limb");
    setCategory("behavioral");
    setOrderingOrderId("");
    setJustification("");
    setInterval("15");
  }, [open]);

  // The category floor is the DEFAULT interval, not a clamp: switching category moves the field to the
  // floor for that category, and the clinician may still tighten it further.
  useEffect(() => {
    setInterval(String(RESTRAINT_REASSESS_FLOOR_MINUTES[category]));
  }, [category]);

  useEffect(() => {
    if (!open || !patientId) return;
    let cancelled = false;
    void loadSignedOrdersForPatient(client, patientId).then((o) => {
      if (!cancelled) setOrders(o);
    });
    return () => {
      cancelled = true;
    };
  }, [open, patientId, client]);

  if (!open) return null;
  const floor = RESTRAINT_REASSESS_FLOOR_MINUTES[category];

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="Apply a restraint"
      role="alertdialog"
      width="38rem"
    >
      <div style={shell}>
        <h2 style={title}>Apply a restraint</h2>
        <p style={meta}>
          A restraint requires a signed physician order — CoP 418.110 permits none without one, even
          in an emergency. The default IPU posture is restraint-free.
        </p>
        <div style={row2}>
          <SelectField
            label="Restraint"
            required
            value={restraintKind}
            onChange={(e) =>
              setRestraintKind(e.target.value as ApplyRestraintBody["restraintKind"])
            }
            options={RESTRAINT_KINDS}
          />
          <SelectField
            label="Category"
            required
            value={category}
            onChange={(e) => setCategory(e.target.value as RestraintCategory)}
            options={[
              { value: "behavioral", label: "Behavioral" },
              { value: "medical", label: "Medical" },
            ]}
          />
        </div>
        <SelectField
          label="Physician order"
          required
          value={orderingOrderId}
          onChange={(e) => setOrderingOrderId(e.target.value)}
          hint={
            orders.length === 0
              ? "This patient has no signed orders. A restraint cannot be applied without one."
              : "Signed orders for this patient. The server re-resolves the order and refuses if it is another patient's, unsigned, or names no ordering physician."
          }
          options={[
            { value: "", label: "Select the authorising order" },
            ...orders.map((o) => ({
              value: o.id,
              label: `${o.kind.replace(/_/g, " ")} — ${o.status}`,
            })),
          ]}
        />
        <TextAreaField
          label="Clinical justification"
          required
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          hint={reasonHint(justification, RESTRAINT_JUSTIFICATION_MIN)}
          style={{ minHeight: "8rem" }}
        />
        <TextField
          label="Reassessment interval (minutes)"
          required
          type="number"
          min={1}
          value={interval}
          onChange={(e) => setInterval(e.target.value)}
          hint={`A ${category} restraint is reassessed at least every ${floor} minutes. This may be tightened below ${floor} and never loosened above it.`}
        />
        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone="danger"
            onClick={() =>
              void run(() =>
                applyRestraint(client, admissionId, {
                  restraintKind,
                  category,
                  orderingOrderId,
                  restraintJustificationText: justification,
                  reassessmentIntervalMinutes: Number(interval),
                }),
              )
            }
            disabled={busy}
          >
            {busy ? "Working…" : "Confirm and apply"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ReassessRestraintModal({
  open,
  restraint,
  onClose,
  onDone,
}: {
  open: boolean;
  restraint: RestraintRow | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<unknown>(open, onDone, onClose);
  const [outcome, setOutcome] = useState<"continue" | "modify" | "release">("continue");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setOutcome("continue");
    setNotes("");
  }, [open]);

  if (!open || !restraint) return null;
  const intervalMinutes = restraint.reassessmentIntervalMinutes;

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Reassess this restraint" width="34rem">
      <div style={shell}>
        <h2 style={title}>Reassess this restraint</h2>
        <p style={meta}>
          {restraint.restraintKind.replace(/_/g, " ")} · {restraint.category} · reassessed every{" "}
          {intervalMinutes} minutes. The next reassessment is scheduled one interval from now.
        </p>
        <SelectField
          label="Outcome"
          required
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as typeof outcome)}
          options={[
            { value: "continue", label: "Continue — the restraint remains necessary" },
            { value: "modify", label: "Modify — the restraint continues with changes" },
            { value: "release", label: "Release — the restraint is no longer necessary" },
          ]}
        />
        <TextAreaField
          label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          hint="Optional. Recorded on the reassessment."
        />
        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone="primary"
            onClick={() =>
              void run(() =>
                reassessRestraint(client, restraint.id, {
                  outcome,
                  // The next due instant is computed from the restraint's OWN interval, so the cadence
                  // a physician set is what the board counts down to.
                  nextDueAt: new Date(Date.now() + intervalMinutes * 60_000).toISOString(),
                  ...(notes.trim() ? { notes: notes.trim() } : {}),
                }),
              )
            }
            disabled={busy}
          >
            {busy ? "Working…" : "Record reassessment"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ReleaseRestraintModal({
  open,
  restraint,
  onClose,
  onDone,
}: {
  open: boolean;
  restraint: RestraintRow | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<unknown>(open, onDone, onClose);
  if (!open || !restraint) return null;
  return (
    <Modal open={open} onClose={onClose} ariaLabel="Release this restraint" width="30rem">
      <div style={shell}>
        <h2 style={title}>Release this restraint</h2>
        <p style={meta}>
          Releasing the {restraint.restraintKind.replace(/_/g, " ")} ends the reassessment cadence
          and closes the record. Reapplying later requires a new physician order.
        </p>
        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone="primary"
            onClick={() => void run(() => releaseRestraint(client, restraint.id))}
            disabled={busy}
          >
            {busy ? "Working…" : "Release restraint"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── GIP criteria (CoP 418.108) ─────────────────────────────────────────────────────────────────────────

type CriterionKind =
  | "acute_symptom_management"
  | "imminent_death_terminal_care"
  | "medications_treatments_inpatient_only";

const CRITERION_OPTIONS: { value: CriterionKind; label: string }[] = [
  { value: "acute_symptom_management", label: "Acute symptom management not manageable at home" },
  { value: "imminent_death_terminal_care", label: "Terminal care of an imminently dying patient" },
  {
    value: "medications_treatments_inpatient_only",
    label: "Medications or treatments requiring an inpatient setting",
  },
];

const IMMINENT_SIGNS = [
  "terminal_secretions",
  "cheyne_stokes_breathing",
  "apneic_episodes",
  "mottling",
  "cold_extremities",
  "unresponsiveness",
  "hypotension_terminal",
  "terminal_agitation",
  "other_documented",
] as const;

/**
 * The GIP attestation.
 *
 * CoP 418.108 permits exactly THREE criteria for general inpatient care, and the payload is a
 * discriminated union over them. All three arms are offered rather than the easiest one: a hospice
 * whose only available criterion were "imminent death" would be pushed toward attesting something
 * untrue about a patient admitted for symptom management, which is a worse failure than a longer form.
 */
export function AttestGipModal({
  open,
  admissionId,
  onClose,
  onDone,
}: {
  open: boolean;
  admissionId: string;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<unknown>(open, onDone, onClose);
  const [criterion, setCriterion] = useState<CriterionKind>("acute_symptom_management");
  const [physicianId, setPhysicianId] = useState("");
  const [rationale, setRationale] = useState("");

  // acute_symptom_management
  const [symptom, setSymptom] = useState("");
  const [severity, setSeverity] = useState("5");
  const [durationHours, setDurationHours] = useState("24");
  const [homeInterventions, setHomeInterventions] = useState("");
  const [plannedInterventions, setPlannedInterventions] = useState("");

  // imminent_death_terminal_care
  const [daysToDeath, setDaysToDeath] = useState("3");
  const [signs, setSigns] = useState<(typeof IMMINENT_SIGNS)[number][]>([]);
  const [homeAssessment, setHomeAssessment] = useState("");

  // medications_treatments_inpatient_only
  const [rxNormCode, setRxNormCode] = useState("");
  const [medDisplayName, setMedDisplayName] = useState("");
  const [whyInpatient, setWhyInpatient] = useState("");

  useEffect(() => {
    if (!open) return;
    setCriterion("acute_symptom_management");
    setPhysicianId("");
    setRationale("");
    setSymptom("");
    setSeverity("5");
    setDurationHours("24");
    setHomeInterventions("");
    setPlannedInterventions("");
    setDaysToDeath("3");
    setSigns([]);
    setHomeAssessment("");
    setRxNormCode("");
    setMedDisplayName("");
    setWhyInpatient("");
  }, [open]);

  const loadPhysicians = useCallback(
    async ({ query }: { query: string }) => {
      const results = await searchPhysicians(client, query);
      return {
        options: results.map((p) => ({
          id: p.id,
          label: p.displayName,
          searchLabel: `${p.displayName} ${p.identifierValue}`,
          description: p.identifierValue ? `NPI ${p.identifierValue}` : undefined,
        })),
      };
    },
    [client],
  );

  const body = useMemo(() => {
    switch (criterion) {
      case "acute_symptom_management":
        return {
          criterion_kind: "acute_symptom_management" as const,
          uncontrolled_symptoms: [
            {
              symptom: symptom.trim(),
              severity_score: Number(severity),
              duration_hours: Number(durationHours),
              interventions_attempted_in_home: lines(homeInterventions),
            },
          ],
          planned_inpatient_interventions: lines(plannedInterventions),
          rationale: rationale.trim(),
        };
      case "imminent_death_terminal_care":
        return {
          criterion_kind: "imminent_death_terminal_care" as const,
          clinical_estimate_days_to_death: Number(daysToDeath),
          signs_of_imminent_death: signs,
          rationale_for_inpatient_setting: rationale.trim(),
          home_environment_assessment_text: homeAssessment.trim(),
        };
      case "medications_treatments_inpatient_only":
        return {
          criterion_kind: "medications_treatments_inpatient_only" as const,
          named_medications: rxNormCode.trim()
            ? [
                {
                  rx_norm_code: rxNormCode.trim(),
                  display_name: medDisplayName.trim(),
                  why_inpatient_only_text: whyInpatient.trim(),
                },
              ]
            : [],
          named_treatments: [],
          rationale: rationale.trim(),
        };
    }
  }, [
    criterion,
    symptom,
    severity,
    durationHours,
    homeInterventions,
    plannedInterventions,
    rationale,
    daysToDeath,
    signs,
    homeAssessment,
    rxNormCode,
    medDisplayName,
    whyInpatient,
  ]);

  if (!open) return null;

  const rationaleLabel =
    criterion === "imminent_death_terminal_care"
      ? "Rationale for the inpatient setting"
      : "Clinical rationale";

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Attest GIP criteria" width="40rem">
      <div style={shell}>
        <h2 style={title}>Attest the GIP criterion</h2>
        <p style={meta}>
          CoP 418.108 permits general inpatient care under exactly three criteria. The attestation
          names the physician making it and is what a GIP admission is confirmed on.
        </p>
        <SelectField
          label="Criterion"
          required
          value={criterion}
          onChange={(e) => setCriterion(e.target.value as CriterionKind)}
          options={CRITERION_OPTIONS}
        />
        <EntityLookupField
          label="Attesting physician"
          required
          value={physicianId}
          onChange={(v) => setPhysicianId(v)}
          loadOptions={loadPhysicians}
          placeholder="Search the physician register"
          hint="From the canonical physician register (M40), searched by name or NPI."
        />

        {criterion === "acute_symptom_management" ? (
          <>
            <TextField
              label="Uncontrolled symptom"
              required
              value={symptom}
              onChange={(e) => setSymptom(e.target.value)}
            />
            <div style={row2}>
              <TextField
                label="Severity (1–10)"
                required
                type="number"
                min={1}
                max={10}
                value={severity}
                onChange={(e) => setSeverity(e.target.value)}
              />
              <TextField
                label="Duration (hours)"
                required
                type="number"
                min={0}
                value={durationHours}
                onChange={(e) => setDurationHours(e.target.value)}
              />
            </div>
            <TextAreaField
              label="Interventions attempted in the home"
              required
              value={homeInterventions}
              onChange={(e) => setHomeInterventions(e.target.value)}
              hint="One per line."
            />
            <TextAreaField
              label="Planned inpatient interventions"
              required
              value={plannedInterventions}
              onChange={(e) => setPlannedInterventions(e.target.value)}
              hint="One per line."
            />
          </>
        ) : null}

        {criterion === "imminent_death_terminal_care" ? (
          <>
            <TextField
              label="Clinical estimate — days to death"
              required
              type="number"
              min={0}
              max={14}
              value={daysToDeath}
              onChange={(e) => setDaysToDeath(e.target.value)}
            />
            <fieldset
              style={{
                border: "1px solid var(--color-outline-variant)",
                borderRadius: "var(--radius-md)",
                padding: "0.75rem",
              }}
            >
              <legend style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                Signs of imminent death
              </legend>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.35rem" }}>
                {IMMINENT_SIGNS.map((sign) => (
                  <label key={sign} style={{ display: "flex", gap: "0.4rem", fontSize: "0.8rem" }}>
                    <input
                      type="checkbox"
                      checked={signs.includes(sign)}
                      onChange={(e) =>
                        setSigns((prev) =>
                          e.target.checked ? [...prev, sign] : prev.filter((s) => s !== sign),
                        )
                      }
                    />
                    {sign.replace(/_/g, " ")}
                  </label>
                ))}
              </div>
            </fieldset>
            <TextAreaField
              label="Home environment assessment"
              required
              value={homeAssessment}
              onChange={(e) => setHomeAssessment(e.target.value)}
              hint={reasonHint(homeAssessment, GIP_HOME_ASSESSMENT_MIN)}
            />
          </>
        ) : null}

        {criterion === "medications_treatments_inpatient_only" ? (
          <>
            <div style={row2}>
              <TextField
                label="RxNorm code"
                required
                value={rxNormCode}
                onChange={(e) => setRxNormCode(e.target.value)}
              />
              <TextField
                label="Medication name"
                required
                value={medDisplayName}
                onChange={(e) => setMedDisplayName(e.target.value)}
              />
            </div>
            <TextAreaField
              label="Why this requires an inpatient setting"
              required
              value={whyInpatient}
              onChange={(e) => setWhyInpatient(e.target.value)}
              hint={reasonHint(whyInpatient, 50)}
            />
          </>
        ) : null}

        <TextAreaField
          label={rationaleLabel}
          required
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          hint={reasonHint(rationale, GIP_RATIONALE_MIN)}
          style={{ minHeight: "8rem" }}
        />

        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone="primary"
            onClick={() =>
              void run(() =>
                attestGipCriteria(client, admissionId, {
                  attestingPhysicianId: physicianId,
                  data: body,
                }),
              )
            }
            disabled={busy}
          >
            {busy ? "Working…" : "Record attestation"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ReassessGipModal({
  open,
  admissionId,
  onClose,
  onDone,
}: {
  open: boolean;
  admissionId: string;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<unknown>(open, onDone, onClose);
  const [stillMet, setStillMet] = useState("true");
  const [rationale, setRationale] = useState("");
  useEffect(() => {
    if (!open) return;
    setStillMet("true");
    setRationale("");
  }, [open]);
  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} ariaLabel="Reassess the GIP criterion" width="34rem">
      <div style={shell}>
        <h2 style={title}>Reassess the GIP criterion</h2>
        <p style={meta}>
          GIP is reassessed as the stay continues. A criterion no longer met is what moves the
          patient back to a routine level of care.
        </p>
        <SelectField
          label="Is the criterion still met?"
          required
          value={stillMet}
          onChange={(e) => setStillMet(e.target.value)}
          options={[
            { value: "true", label: "Yes — general inpatient care remains necessary" },
            { value: "false", label: "No — the criterion is no longer met" },
          ]}
        />
        <TextAreaField
          label="Rationale"
          required
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          hint={reasonHint(rationale, GIP_REASSESS_RATIONALE_MIN)}
          style={{ minHeight: "7rem" }}
        />
        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone="primary"
            onClick={() =>
              void run(() =>
                reassessGipCriteria(client, admissionId, stillMet === "true", rationale),
              )
            }
            disabled={busy}
          >
            {busy ? "Working…" : "Record criterion reassessment"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── IRC cap override ───────────────────────────────────────────────────────────────────────────────────

export function IrcCapOverrideModal({
  open,
  admissionId,
  episode,
  onClose,
  onDone,
}: {
  open: boolean;
  admissionId: string;
  episode: IrcEpisodeRow | null;
  onClose: () => void;
  onDone: (v: IrcEpisodeRow) => void;
}): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<IrcEpisodeRow>(open, onDone, onClose);
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("1");
  useEffect(() => {
    if (!open) return;
    setReason("");
    setDays("1");
  }, [open]);
  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="Override the respite cap"
      role="alertdialog"
      width="34rem"
    >
      <div style={shell}>
        <h2 style={title}>Override the respite cap</h2>
        <p style={meta}>
          Inpatient respite is capped at {IRC_CAP_DAYS} consecutive days. An override extends it by
          at most {IRC_CAP_OVERRIDE_MAX_DAYS} and may be invoked once per episode. Days beyond the
          effective cap are not covered.
          {episode ? ` This episode is on day ${episode.consecutiveDayCount}.` : ""}
        </p>
        <TextField
          label="Extension (days)"
          required
          type="number"
          min={1}
          max={IRC_CAP_OVERRIDE_MAX_DAYS}
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
        <TextAreaField
          label="Reason"
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint={reasonHint(reason, IRC_CAP_OVERRIDE_REASON_MIN)}
          style={{ minHeight: "8rem" }}
        />
        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone="danger"
            onClick={() =>
              void run(() => overrideIrcCap(client, admissionId, reason, Number(days)))
            }
            disabled={busy}
          >
            {busy ? "Working…" : "Invoke override"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── visitors ───────────────────────────────────────────────────────────────────────────────────────────

const RELATIONSHIPS = [
  "spouse",
  "parent",
  "child",
  "sibling",
  "grandparent",
  "grandchild",
  "in_law",
  "aunt_uncle",
  "cousin",
  "friend",
  "clergy",
  "volunteer",
  "caregiver_paid",
  "legal_representative",
  "other",
] as const;

export function CheckInVisitorModal({
  open,
  admissionId,
  onClose,
  onDone,
}: {
  open: boolean;
  admissionId: string;
  onClose: () => void;
  onDone: (v: VisitorRow) => void;
}): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<VisitorRow>(open, onDone, onClose);
  const [visitorName, setVisitorName] = useState("");
  const [relationship, setRelationship] = useState<(typeof RELATIONSHIPS)[number]>("spouse");
  const [feverFree, setFeverFree] = useState(true);
  const [symptomFree, setSymptomFree] = useState(true);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setVisitorName("");
    setRelationship("spouse");
    setFeverFree(true);
    setSymptomFree(true);
    setNotes("");
  }, [open]);

  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} ariaLabel="Check in a visitor" width="34rem">
      <div style={shell}>
        <h2 style={title}>Check in a visitor</h2>
        <p style={meta}>
          A restriction in force on this unit or patient can refuse the check-in, and a mask
          requirement is recorded on the visit. §2.7 evaluates consent for a non-immediate-family
          visitor.
        </p>
        <TextField
          label="Visitor name"
          required
          value={visitorName}
          onChange={(e) => setVisitorName(e.target.value)}
        />
        <SelectField
          label="Relationship to the patient"
          required
          value={relationship}
          onChange={(e) => setRelationship(e.target.value as (typeof RELATIONSHIPS)[number])}
          options={RELATIONSHIPS.map((r) => ({ value: r, label: r.replace(/_/g, " ") }))}
        />
        {/*
          The screening outcome is a free-shaped record on the wire (`Record<string, unknown>`), which
          issue 170 recorded as a decision rather than a defect: what an IPU visitor screening asks is a
          clinical and infection-control question, not a frontend one. These two are the screening every
          such policy contains; the note carries whatever else was asked.
        */}
        <fieldset
          style={{
            border: "1px solid var(--color-outline-variant)",
            borderRadius: "var(--radius-md)",
            padding: "0.75rem",
          }}
        >
          <legend style={{ fontSize: "0.8rem", fontWeight: 600 }}>Screening</legend>
          <label style={{ display: "flex", gap: "0.4rem", fontSize: "0.85rem" }}>
            <input
              type="checkbox"
              checked={feverFree}
              onChange={(e) => setFeverFree(e.target.checked)}
            />
            No fever
          </label>
          <label
            style={{ display: "flex", gap: "0.4rem", fontSize: "0.85rem", marginTop: "0.35rem" }}
          >
            <input
              type="checkbox"
              checked={symptomFree}
              onChange={(e) => setSymptomFree(e.target.checked)}
            />
            No respiratory symptoms
          </label>
        </fieldset>
        <TextAreaField
          label="Screening notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          hint="Optional. Recorded with the screening outcome."
        />
        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone="primary"
            onClick={() =>
              void run(() =>
                checkInVisitor(client, {
                  ipuAdmissionId: admissionId,
                  visitorName: visitorName.trim(),
                  relationship,
                  screeningOutcome: {
                    feverFree,
                    symptomFree,
                    ...(notes.trim() ? { notes: notes.trim() } : {}),
                  },
                }),
              )
            }
            disabled={busy}
          >
            {busy ? "Working…" : "Record check-in"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function CheckOutVisitorModal({
  open,
  visitor,
  onClose,
  onDone,
}: {
  open: boolean;
  visitor: VisitorRow | null;
  onClose: () => void;
  onDone: (v: VisitorRow) => void;
}): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<VisitorRow>(open, onDone, onClose);
  if (!open || !visitor) return null;
  return (
    <Modal open={open} onClose={onClose} ariaLabel="Check out this visitor" width="30rem">
      <div style={shell}>
        <h2 style={title}>Check out this visitor</h2>
        {/* The copy says what the act does. That this visitor was, until recently, check-outable only
            by the session that checked them in is a note for the file header, not something to put in
            front of a nurse. */}
        <p style={meta}>
          Recording the departure closes the visit and takes this visitor off the unit's count.
        </p>
        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone="primary"
            onClick={() => void run(() => checkOutVisitor(client, visitor.id))}
            disabled={busy}
          >
            {busy ? "Working…" : "Check out visitor"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── visitor restrictions ───────────────────────────────────────────────────────────────────────────────

const RESTRICTION_KINDS = [
  { value: "full_block", label: "Full block — no visitors" },
  { value: "immediate_family_only", label: "Immediate family only" },
  { value: "mask_required", label: "Mask required" },
  { value: "time_limited", label: "Time limited" },
  { value: "no_overnight", label: "No overnight visitors" },
] as const;

export function ApplyRestrictionModal({
  open,
  patientId,
  onClose,
  onDone,
}: {
  open: boolean;
  patientId: string;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<unknown>(open, onDone, onClose);
  const [restrictionKind, setRestrictionKind] =
    useState<(typeof RESTRICTION_KINDS)[number]["value"]>("mask_required");
  const [rationale, setRationale] = useState("");
  useEffect(() => {
    if (!open) return;
    setRestrictionKind("mask_required");
    setRationale("");
  }, [open]);
  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} ariaLabel="Apply a visitor restriction" width="34rem">
      <div style={shell}>
        <h2 style={title}>Apply a visitor restriction</h2>
        <p style={meta}>
          Scoped to this patient. A restriction stays in force until it is lifted, and it is what
          refuses a visitor check-in at the door.
        </p>
        <SelectField
          label="Restriction"
          required
          value={restrictionKind}
          onChange={(e) =>
            setRestrictionKind(e.target.value as (typeof RESTRICTION_KINDS)[number]["value"])
          }
          options={RESTRICTION_KINDS.map((r) => ({ value: r.value, label: r.label }))}
        />
        <TextAreaField
          label="Rationale"
          required
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          hint="Recorded on the restriction and read by whoever later decides to lift it."
        />
        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone="primary"
            onClick={() =>
              void run(() =>
                applyVisitorRestriction(client, {
                  scope: "patient",
                  patientId,
                  restrictionKind,
                  rationale: rationale.trim(),
                  sourceKind: "per_patient_clinical",
                }),
              )
            }
            disabled={busy}
          >
            {busy ? "Working…" : "Record restriction"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function LiftRestrictionModal({
  open,
  restrictionId,
  onClose,
  onDone,
}: {
  open: boolean;
  restrictionId: string | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<unknown>(open, onDone, onClose);
  if (!open || !restrictionId) return null;
  return (
    <Modal open={open} onClose={onClose} ariaLabel="Lift this restriction" width="30rem">
      <div style={shell}>
        <h2 style={title}>Lift this restriction</h2>
        <p style={meta}>
          Lifting takes the restriction out of force immediately. The row is retained as the record
          of when it applied and why.
        </p>
        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone="primary"
            onClick={() => void run(() => liftVisitorRestriction(client, restrictionId))}
            disabled={busy}
          >
            {busy ? "Working…" : "Confirm lift"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
