import { Button, Glyph, Modal, StatusPill, t, toLocalInput, useApiClient } from "@chartwarden/ui";
import type { ApiClient, EntityLookupOption } from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, JSX, ReactNode, RefObject } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  AdmissionLookupField,
  MdmEntityLookupField,
  PatientLookupField,
  admissionDateLabel,
} from "../../shell/entity-lookups";
import { useSession } from "../../shell/session";
import { stashStepUpDraft, stepUpRedirectFor, takeStepUpDraft } from "../../shell/step-up-redirect";
import { type NewVisitPrefill, moveWindowToDay } from "./new-visit-prefill";
import {
  type CreateVisitBody,
  type VisitPurpose,
  type VisitSetting,
  createVisit,
} from "./scheduling-api";
import { mapSchedulingApiError } from "./scheduling-errors";
import { VISIT_TONE, purposeLabel, stateLabel } from "./scheduling-status";
import {
  ASSIGNED_CLINICIAN_MESSAGE,
  EvvReasonField,
  evvReasonProblem,
  isAssignedClinicianRefusal,
} from "./visit-attestation";

export interface VisitView {
  id: string;
  organizationId?: string;
  patientId: string;
  admissionId: string;
  assignedMembershipId: string;
  visitPurpose: string;
  visitSetting: string;
  scheduledStartedAt: string;
  scheduledEndedAt: string;
  serviceDate: string;
  status: string;
  patientAddressId: string | null;
  externalFacilityId: string | null;
  rescheduledIntoVisitId: string | null;
}

export interface EncounterLink {
  id: string;
  patientId: string;
  admissionId: string;
  visitId: string | null;
  encounterType: string;
  discipline: string;
  serviceDate: string;
  status: string;
  signedAt: string | null;
  cosignedAt: string | null;
}

type VisitAction = "start" | "arrive" | "reassign" | "reschedule" | "cancel" | "no-show";

type EligibleClinician = {
  membershipId: string;
  displayName: string;
  disciplines: string[];
  eligible: boolean;
  reasonCodes: string[];
};

const eligibilityApi = (client: unknown) =>
  client as {
    GET: (path: string, options: unknown) => Promise<{ data?: unknown; error?: unknown }>;
  };
const eligibilityReason = (reasons: readonly string[]): string => {
  if (reasons.includes("CLINICIAN_CREDENTIAL_MISSING"))
    return "No active credential for the selected date.";
  if (reasons.includes("CLINICIAN_DISCIPLINE_NOT_ALLOWED"))
    return "This discipline cannot perform the selected visit type.";
  if (reasons.includes("CLINICIAN_ENCOUNTER_TYPE_UNSUPPORTED"))
    return "This discipline cannot yet be scheduled for the selected visit type.";
  if (reasons.includes("CLINICIAN_ON_PTO")) return "Unavailable during the selected time.";
  if (reasons.includes("CLINICIAN_NOT_IN_CASELOAD"))
    return "Not currently assigned to this patient's care team.";
  return "Not eligible for this visit.";
};

const VISIT_PURPOSES = [
  "routine_visit",
  "prn",
  "aide_poc",
  "msw_assessment",
  "msw_followup",
  "chaplain_visit",
  "chaplain_assessment",
  "volunteer_visit",
  "f2f",
  "recert",
  "loc_change",
  "pronouncement",
  "admission_visit",
  "discharge_visit",
  "huv1",
  "huv2",
  "sfv",
] as const satisfies readonly VisitPurpose[];

const VISIT_SETTINGS = [
  "patient_home",
  "facility",
  "inpatient_unit",
  "telephonic",
] as const satisfies readonly VisitSetting[];

type NewVisitStep = 1 | 2 | 3 | 4;
type EligibilityState = "idle" | "loading" | "ready" | "error";
type VisitAddress = { id: string; label: string; isPrimary: boolean; current: boolean };

function defaultVisitWindow(): { start: string; end: string } {
  const now = Date.now();
  return {
    start: toLocalInput(new Date(now + 60 * 60 * 1000)),
    end: toLocalInput(new Date(now + 2 * 60 * 60 * 1000)),
  };
}

const NEW_VISIT_STEPS: ReadonlyArray<{ step: NewVisitStep; label: string }> = [
  { step: 1, label: "Who and why" },
  { step: 2, label: "When and where" },
  { step: 3, label: "Who is available" },
  { step: 4, label: "Review and schedule" },
];

export function hasPermission(permissions: readonly string[] | undefined, key: string): boolean {
  return permissions?.includes(key) ?? false;
}

function isoFromLocal(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

export function formatInstant(value: string | null | undefined): string {
  if (!value) return "Not set";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function shortId(id: string | null | undefined): string {
  if (!id) return "Not set";
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** The shared shell owns Scheduling's route navigation; feature pages retain only this workflow action. */
export function NewVisitButton({
  onNewVisit,
}: {
  onNewVisit: () => void;
}): JSX.Element | null {
  const session = useSession();
  if (!hasPermission(session?.permissions, "visit.create")) return null;
  return (
    <Button size="sm" onClick={onNewVisit}>
      <Glyph name="calendar" size={14} /> New Visit
    </Button>
  );
}

export function NewVisitModal({
  open,
  onClose,
  onCreated,
  initialPatient,
  initialPrefill,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (visit: VisitView) => void;
  initialPatient?: { id: string; label: string } | null;
  /** A purpose and a day the form starts with (the visit note's "Schedule next visit"); both stay editable. */
  initialPrefill?: NewVisitPrefill | null;
}): JSX.Element | null {
  const client = useApiClient();
  const [patientId, setPatientId] = useState("");
  const [patientLabel, setPatientLabel] = useState("");
  const [admissionId, setAdmissionId] = useState("");
  const [admissionLabel, setAdmissionLabel] = useState("");
  const [clinicianId, setClinicianId] = useState("");
  const [clinicianLabel, setClinicianLabel] = useState("");
  const [visitPurpose, setVisitPurpose] = useState<VisitPurpose>("routine_visit");
  const [visitSetting, setVisitSetting] = useState<VisitSetting>("patient_home");
  const [addressId, setAddressId] = useState("");
  const [addresses, setAddresses] = useState<VisitAddress[]>([]);
  const [facilityId, setFacilityId] = useState("");
  const [start, setStart] = useState(() => defaultVisitWindow().start);
  const [end, setEnd] = useState(() => defaultVisitWindow().end);
  const [notes, setNotes] = useState("");
  const [reminder, setReminder] = useState(false);
  const [step, setStep] = useState<NewVisitStep>(1);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const currentStepRef = useRef<HTMLLIElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [supportReference, setSupportReference] = useState<string | null>(null);
  const [eligibleClinicians, setEligibleClinicians] = useState<EligibleClinician[]>([]);
  const [eligibilityState, setEligibilityState] = useState<EligibilityState>("idle");
  const [eligibilityHint, setEligibilityHint] = useState<string | null>(null);
  const [eligibilityRefresh, setEligibilityRefresh] = useState(0);

  useEffect(() => {
    if (!open || !initialPatient) return;
    setPatientId(initialPatient.id);
    setPatientLabel(initialPatient.label);
  }, [open, initialPatient]);

  // Keyed on the two values, not on the prefill object: a parent re-render hands over a new object and must not overwrite an edit.
  const prefillPurpose = initialPrefill?.purpose ?? null;
  const prefillDate = initialPrefill?.date ?? null;
  useEffect(() => {
    if (!open) return;
    if (prefillPurpose !== null) setVisitPurpose(prefillPurpose);
    if (prefillDate !== null) {
      const moved = moveWindowToDay(defaultVisitWindow(), prefillDate);
      setStart(moved.start);
      setEnd(moved.end);
    }
  }, [open, prefillPurpose, prefillDate]);

  // A step change can remove the focused button: advancing 3 -> 4 swaps Continue for Create Visit (distinct
  // keys, see the footer) and Back is absent on step 1. Focus would fall to <body>, where the modal's Escape
  // and Tab handling never see it, so land on the current step in the progress list; it also announces the step.
  const previousStep = useRef(step);
  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    const active = document.activeElement;
    if (!active || active === document.body) currentStepRef.current?.focus();
  }, [step]);

  useEffect(() => {
    let active = true;
    if (!open || !patientId || admissionId)
      return () => {
        active = false;
      };
    void client
      .GET("/api/v1/patients/{patientId}/admissions", {
        params: { path: { patientId } },
      })
      .then((result) => {
        if (!active) return;
        const activeAdmissions = (
          (result.data?.items ?? []) as Array<{
            id: string;
            state: string;
            admissionAt: string | null;
          }>
        ).filter((admission) => admission.state === "active");
        if (activeAdmissions.length === 1) {
          setAdmissionId(activeAdmissions[0]!.id);
          setAdmissionLabel(admissionDateLabel(activeAdmissions[0]!.admissionAt));
        }
      });
    return () => {
      active = false;
    };
  }, [admissionId, client, open, patientId]);

  function reset(): void {
    const window = defaultVisitWindow();
    setPatientId("");
    setPatientLabel("");
    setAdmissionId("");
    setAdmissionLabel("");
    setClinicianId("");
    setClinicianLabel("");
    setVisitPurpose("routine_visit");
    setVisitSetting("patient_home");
    setAddressId("");
    setAddresses([]);
    setFacilityId("");
    setStart(window.start);
    setEnd(window.end);
    setNotes("");
    setReminder(false);
    setStep(1);
    setError(null);
    setSupportReference(null);
    setEligibleClinicians([]);
    setEligibilityState("idle");
    setEligibilityHint(null);
  }

  function closeAndReset(): void {
    reset();
    onClose();
  }

  // Patient addresses are M5-owned.  Once a patient is chosen, select their current primary address
  // automatically; the select below deliberately remains editable for a temporary/facility address.
  useEffect(() => {
    let cancelled = false;
    if (!patientId) {
      setAddresses([]);
      setAddressId("");
      return;
    }
    void (async () => {
      const { data, error: addressError } = await client.GET("/api/v1/patients/{id}/addresses", {
        params: { path: { id: patientId } },
      });
      if (cancelled || addressError) return;
      const rows = (
        (data?.addresses ?? []) as Array<{
          id: string;
          line1: string;
          line2?: string | null;
          city: string;
          state?: string | null;
          postalCode?: string | null;
          isPrimary: boolean;
          current: boolean;
        }>
      ).map((address) => ({
        id: address.id,
        label: [address.line1, address.line2, address.city, address.state, address.postalCode]
          .filter(Boolean)
          .join(", "),
        isPrimary: address.isPrimary,
        current: address.current,
      }));
      setAddresses(rows);
      const primary =
        rows.find((address) => address.current && address.isPrimary) ??
        rows.find((address) => address.current);
      setAddressId(primary?.id ?? "");
    })();
    return () => {
      cancelled = true;
    };
  }, [client, patientId]);

  // The backend evaluates the same M17 facts as POST /visits. Never derive a second discipline or
  // credential policy in the browser; this only makes known-invalid choices unavailable sooner.
  useEffect(() => {
    void eligibilityRefresh;
    let cancelled = false;
    const validWindow = Date.parse(isoFromLocal(start)) < Date.parse(isoFromLocal(end));
    if (!patientId || !validWindow) {
      setEligibleClinicians([]);
      setEligibilityState("idle");
      return;
    }
    setEligibilityState("loading");
    setEligibilityHint(null);
    void (async () => {
      const result = await eligibilityApi(client).GET("/api/v1/scheduling/eligible-clinicians", {
        params: {
          query: {
            patientId,
            visitPurpose,
            scheduledStartedAt: isoFromLocal(start),
            scheduledEndedAt: isoFromLocal(end),
          },
        },
      });
      if (cancelled) return;
      if (result.error) {
        setEligibleClinicians([]);
        setEligibilityState("error");
        return;
      }
      const rows = (result.data ?? []) as EligibleClinician[];
      setEligibleClinicians(rows);
      setEligibilityState("ready");
      setClinicianId((current) => {
        if (
          !current ||
          rows.some((clinician) => clinician.membershipId === current && clinician.eligible)
        )
          return current;
        const selected = rows.find((clinician) => clinician.membershipId === current);
        setClinicianLabel("");
        setEligibilityHint(
          selected
            ? `Selected clinician removed: ${eligibilityReason(selected.reasonCodes)}`
            : "Selected clinician is no longer eligible for this visit.",
        );
        return "";
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [client, patientId, visitPurpose, start, end, eligibilityRefresh]);

  function advance(): void {
    setError(null);
    setSupportReference(null);
    if (step === 1) {
      if (!patientId || !admissionId) {
        setError("Select a patient and active admission before continuing.");
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      if (!start || !end || Date.parse(isoFromLocal(end)) <= Date.parse(isoFromLocal(start))) {
        setError("Scheduled end must be after scheduled start.");
        return;
      }
      setStep(3);
      return;
    }
    if (step === 3) {
      if (eligibilityState === "loading") {
        setError("Wait while eligible clinicians are checked.");
        return;
      }
      if (eligibilityState === "error") {
        setError("Eligible clinicians could not be checked. Retry before continuing.");
        return;
      }
      if (!clinicianId) {
        setError("Select an eligible clinician before continuing.");
        return;
      }
      setStep(4);
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (step !== 4 || submittingRef.current) return;
    if (!patientId || !admissionId || !clinicianId) {
      setError("Select a patient, active admission, and clinician.");
      return;
    }
    if (Date.parse(isoFromLocal(end)) <= Date.parse(isoFromLocal(start))) {
      setError("Scheduled end must be after scheduled start.");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setSupportReference(null);
    const body: CreateVisitBody = {
      patientId,
      admissionId,
      assignedMembershipId: clinicianId,
      visitPurpose,
      visitSetting,
      scheduledStartedAt: isoFromLocal(start),
      scheduledEndedAt: isoFromLocal(end),
      patientAddressId: addressId || null,
      externalFacilityId: visitSetting === "facility" ? facilityId || null : null,
      ...(notes.trim() ? { schedulerInternalNotes: notes.trim() } : {}),
      caregiverReminderOptIn: reminder,
    };
    try {
      const result = await createVisit(client, body);
      if (!result.ok) {
        setError(result.message);
        setSupportReference(result.correlationId ?? null);
        return;
      }
      reset();
      onCreated(result.value as VisitView);
    } catch {
      setError(
        "The visit could not be scheduled because the server could not be reached. Your draft is safe; try again.",
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={submitting ? undefined : closeAndReset}
      ariaLabel="New Visit"
      width="42rem"
    >
      <form onSubmit={(event) => void submit(event)} style={modalBody}>
        <div style={modalHeader}>
          <div>
            <h2 style={modalTitle}>New Visit</h2>
            <p style={muted}>
              Create a visit in four steps. Final eligibility and conflict checks happen when you
              schedule.
            </p>
          </div>
          <button type="button" onClick={closeAndReset} disabled={submitting} style={iconButton}>
            <Glyph name="close" size={16} label="Close" />
          </button>
        </div>
        <NewVisitProgress current={step} currentRef={currentStepRef} />
        {error ? (
          <div role="alert" style={errorBanner}>
            <strong>{error}</strong>
            {supportReference ? (
              <span style={{ display: "block", marginTop: "0.3rem", fontSize: "0.75rem" }}>
                Support reference: {supportReference}
              </span>
            ) : null}
          </div>
        ) : null}
        <div style={grid2}>
          {step === 1 ? (
            <WhoAndWhyStep
              patientId={patientId}
              patientLabel={patientLabel}
              admissionId={admissionId}
              admissionLabel={admissionLabel}
              visitPurpose={visitPurpose}
              onPatientChange={(value, option) => {
                setPatientId(value);
                setPatientLabel(option?.searchLabel ?? "");
                setAdmissionId("");
                setAdmissionLabel("");
                setAddressId("");
                setClinicianId("");
                setClinicianLabel("");
              }}
              onAdmissionChange={(value, option) => {
                setAdmissionId(value);
                setAdmissionLabel(option?.searchLabel ?? "");
              }}
              onPurposeChange={setVisitPurpose}
            />
          ) : null}
          {step === 2 ? (
            <WhenAndWhereStep
              patientId={patientId}
              visitSetting={visitSetting}
              start={start}
              end={end}
              addressId={addressId}
              addresses={addresses}
              facilityId={facilityId}
              onSettingChange={setVisitSetting}
              onStartChange={setStart}
              onEndChange={setEnd}
              onAddressChange={setAddressId}
              onFacilityChange={setFacilityId}
            />
          ) : null}
          {step === 3 ? (
            <ClinicianStep
              clinicianId={clinicianId}
              clinicians={eligibleClinicians}
              visitPurpose={visitPurpose}
              state={eligibilityState}
              hint={eligibilityHint}
              onChange={(value) => {
                const selected = eligibleClinicians.find(
                  (clinician) => clinician.membershipId === value,
                );
                setClinicianId(value);
                setClinicianLabel(selected?.displayName ?? "");
              }}
              onRetry={() => setEligibilityRefresh((value) => value + 1)}
            />
          ) : null}
          {step === 4 ? (
            <NewVisitReview
              patientLabel={patientLabel}
              visitPurpose={visitPurpose}
              visitSetting={visitSetting}
              start={start}
              end={end}
              clinicianLabel={clinicianLabel}
              locationLabel={
                visitSetting === "facility"
                  ? facilityId
                    ? "Selected facility"
                    : "No facility selected"
                  : (addresses.find((address) => address.id === addressId)?.label ??
                    "No address selected")
              }
            />
          ) : null}
        </div>
        {step === 4 ? (
          <>
            <label style={field}>
              <span style={label}>Scheduler notes</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                maxLength={1000}
                style={textarea}
              />
            </label>
            <label style={checkRow}>
              <input
                type="checkbox"
                checked={reminder}
                onChange={(e) => setReminder(e.target.checked)}
              />
              Caregiver reminder requested
            </label>
          </>
        ) : null}
        <div style={actions}>
          <Button tone="tertiary" onClick={closeAndReset} disabled={submitting}>
            Cancel
          </Button>
          <span style={{ flex: 1 }} />
          {step > 1 ? (
            <Button
              tone="tertiary"
              onClick={() => {
                setError(null);
                setSupportReference(null);
                setStep((step - 1) as NewVisitStep);
              }}
              disabled={submitting}
            >
              Back
            </Button>
          ) : null}
          {/* Distinct keys: without them React reuses one <button> for both, and a real click on
              "Continue to review" flips it to type="submit" before the click's default action runs,
              submitting the form and skipping the review step. */}
          {step < 4 ? (
            <Button key="advance" onClick={advance} disabled={submitting}>
              {step === 1
                ? "Continue to time and location"
                : step === 2
                  ? "Continue to clinician"
                  : "Continue to review"}
            </Button>
          ) : (
            <Button key="create" type="submit" loading={submitting} disabled={submitting}>
              <Glyph name="check" size={14} /> Create Visit
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function NewVisitProgress({
  current,
  currentRef,
}: {
  current: NewVisitStep;
  currentRef: RefObject<HTMLLIElement>;
}): JSX.Element {
  return (
    <ol className="wx-visit-wizard-steps" aria-label="Visit scheduling progress">
      {NEW_VISIT_STEPS.map((item) => (
        <li
          key={item.step}
          ref={item.step === current ? currentRef : undefined}
          tabIndex={item.step === current ? -1 : undefined}
          className={
            item.step === current ? "is-current" : item.step < current ? "is-complete" : ""
          }
          aria-current={item.step === current ? "step" : undefined}
        >
          <span aria-hidden="true">{item.step}</span>
          {item.label}
        </li>
      ))}
    </ol>
  );
}

interface WhoAndWhyStepProps {
  patientId: string;
  patientLabel: string;
  admissionId: string;
  admissionLabel: string;
  visitPurpose: VisitPurpose;
  onPatientChange: (value: string, option: EntityLookupOption | null) => void;
  onAdmissionChange: (value: string, option: EntityLookupOption | null) => void;
  onPurposeChange: (value: VisitPurpose) => void;
}

function WhoAndWhyStep({
  patientId,
  patientLabel,
  admissionId,
  admissionLabel,
  visitPurpose,
  onPatientChange,
  onAdmissionChange,
  onPurposeChange,
}: WhoAndWhyStepProps): JSX.Element {
  return (
    <>
      <PatientLookupField
        label="Patient"
        value={patientId}
        valueLabel={patientLabel}
        onChange={onPatientChange}
        required
      />
      <AdmissionLookupField
        label="Active admission"
        patientId={patientId}
        state="active"
        value={admissionId}
        valueLabel={admissionLabel}
        onChange={onAdmissionChange}
        required
        disabled={!patientId}
      />
      <label style={field}>
        <span style={label}>Visit purpose *</span>
        <select
          value={visitPurpose}
          onChange={(event) => onPurposeChange(event.target.value as VisitPurpose)}
          style={input}
        >
          {VISIT_PURPOSES.map((purpose) => (
            <option key={purpose} value={purpose}>
              {purposeLabel(purpose)}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

interface WhenAndWhereStepProps {
  patientId: string;
  visitSetting: VisitSetting;
  start: string;
  end: string;
  addressId: string;
  addresses: readonly VisitAddress[];
  facilityId: string;
  onSettingChange: (value: VisitSetting) => void;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onAddressChange: (value: string) => void;
  onFacilityChange: (value: string) => void;
}

function WhenAndWhereStep({
  patientId,
  visitSetting,
  start,
  end,
  addressId,
  addresses,
  facilityId,
  onSettingChange,
  onStartChange,
  onEndChange,
  onAddressChange,
  onFacilityChange,
}: WhenAndWhereStepProps): JSX.Element {
  return (
    <>
      <label style={field}>
        <span style={label}>Visit setting *</span>
        <select
          value={visitSetting}
          onChange={(event) => onSettingChange(event.target.value as VisitSetting)}
          style={input}
        >
          {VISIT_SETTINGS.map((setting) => (
            <option key={setting} value={setting}>
              {stateLabel(setting)}
            </option>
          ))}
        </select>
      </label>
      <label style={field}>
        <span style={label}>Scheduled start *</span>
        <input
          type="datetime-local"
          value={start}
          onChange={(event) => onStartChange(event.target.value)}
          style={input}
          required
        />
      </label>
      <label style={field}>
        <span style={label}>Scheduled end *</span>
        <input
          type="datetime-local"
          value={end}
          onChange={(event) => onEndChange(event.target.value)}
          style={input}
          required
        />
      </label>
      {visitSetting === "facility" ? (
        <MdmEntityLookupField
          kind="facility"
          label="External facility"
          value={facilityId}
          onChange={onFacilityChange}
        />
      ) : (
        <label style={field}>
          <span style={label}>Patient address</span>
          <select
            value={addressId}
            onChange={(event) => onAddressChange(event.target.value)}
            style={input}
            disabled={!patientId}
          >
            <option value="">{patientId ? "No address selected" : "Select a patient first"}</option>
            {addresses.map((address) => (
              <option key={address.id} value={address.id}>
                {address.label}
                {address.current && address.isPrimary ? " (primary)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="wx-visit-wizard-note">
        Times use your current local time zone. The server confirms the final assignment and
        conflict checks when the visit is created.
      </p>
    </>
  );
}

// Recertification kickoff and level-of-care change are RN visits (M17 purpose table); the physician or
// NP encounter of a recertification is the separate Face-to-Face purpose.
const RN_ONLY_PURPOSE_NOTE =
  "Recertification kickoff and level-of-care change visits are scheduled with an RN. The physician or NP encounter is Face-to-Face.";

interface ClinicianStepProps {
  clinicianId: string;
  clinicians: readonly EligibleClinician[];
  visitPurpose: VisitPurpose;
  state: EligibilityState;
  hint: string | null;
  onChange: (value: string) => void;
  onRetry: () => void;
}

function ClinicianStep({
  clinicianId,
  clinicians,
  visitPurpose,
  state,
  hint,
  onChange,
  onRetry,
}: ClinicianStepProps): JSX.Element {
  const eligible = clinicians.filter((clinician) => clinician.eligible);
  return (
    <div className="wx-visit-wizard-wide">
      <label style={field}>
        <span style={label}>Assigned clinician *</span>
        <select
          value={clinicianId}
          onChange={(event) => onChange(event.target.value)}
          style={input}
          disabled={state !== "ready"}
        >
          <option value="">
            {state === "loading"
              ? "Checking eligible clinicians…"
              : "Select an eligible clinician…"}
          </option>
          {eligible.map((clinician) => (
            <option key={clinician.membershipId} value={clinician.membershipId}>
              {clinician.displayName} ·{" "}
              {clinician.disciplines.map((discipline) => discipline.toUpperCase()).join(" / ")}
            </option>
          ))}
        </select>
      </label>
      {state === "loading" ? <output>Checking credentials and availability…</output> : null}
      {state === "ready" && eligible.length === 0 ? (
        <output className="wx-visit-wizard-state">
          <strong>No eligible clinicians found</strong>
          <span>
            Review the care team, credentials, visit purpose, or selected time. No assignment has
            been accepted yet.
          </span>
          {visitPurpose === "recert" || visitPurpose === "loc_change" ? (
            <span>{RN_ONLY_PURPOSE_NOTE}</span>
          ) : null}
        </output>
      ) : null}
      {state === "error" ? (
        <div className="wx-visit-wizard-state" role="alert">
          <strong>Clinician availability could not be checked</strong>
          <span>Your draft is safe. Retry before scheduling this visit.</span>
          <Button size="sm" tone="tertiary" onClick={onRetry}>
            Retry clinician check
          </Button>
        </div>
      ) : null}
      {hint ? <output className="wx-visit-wizard-state">{hint}</output> : null}
    </div>
  );
}

interface NewVisitReviewProps {
  patientLabel: string;
  visitPurpose: VisitPurpose;
  visitSetting: VisitSetting;
  start: string;
  end: string;
  clinicianLabel: string;
  locationLabel: string;
}

function NewVisitReview({
  patientLabel,
  visitPurpose,
  visitSetting,
  start,
  end,
  clinicianLabel,
  locationLabel,
}: NewVisitReviewProps): JSX.Element {
  const rows = [
    ["Patient", patientLabel || "Selected patient"],
    ["Visit", purposeLabel(visitPurpose)],
    ["When", `${formatInstant(isoFromLocal(start))} – ${formatInstant(isoFromLocal(end))}`],
    ["Clinician", clinicianLabel || "Selected clinician"],
    ["Setting", stateLabel(visitSetting)],
    ["Location", locationLabel],
  ] as const;
  return (
    <div className="wx-visit-wizard-review wx-visit-wizard-wide">
      <h3>Confirm visit details</h3>
      <dl>
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>
        Scheduling remains pending until the server accepts credentials, caseload, time off, and
        overlap checks.
      </p>
    </div>
  );
}

export function VisitActionPanel({
  visit,
  encounter,
  onChanged,
}: {
  visit: VisitView;
  encounter: EncounterLink | null;
  onChanged: (visit?: VisitView) => void;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const session = useSession();
  const location = useLocation();
  const draftKey = `visit-attest:${visit.id}`;
  // Returning from /step-up: reopen the start/arrive dialog with the attestation the user had typed.
  const [restored] = useState(() =>
    takeStepUpDraft<{ action: "start" | "arrive"; evvReason: string }>(draftKey),
  );
  const [action, setAction] = useState<VisitAction | null>(restored?.action ?? null);
  const [reason, setReason] = useState("");
  const [reasonCode, setReasonCode] = useState("patient_request");
  const [clinicianId, setClinicianId] = useState("");
  const [start, setStart] = useState(toLocalInput(new Date(visit.scheduledStartedAt)));
  const [end, setEnd] = useState(toLocalInput(new Date(visit.scheduledEndedAt)));
  const [evvReason, setEvvReason] = useState(restored?.evvReason ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [actionEligibleClinicians, setActionEligibleClinicians] = useState<EligibleClinician[]>([]);
  const [actionEligibilityState, setActionEligibilityState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [actionEligibilityHint, setActionEligibilityHint] = useState<string | null>(null);
  const [eligibilityRefresh, setEligibilityRefresh] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: eligibilityRefresh re-runs the eligibility read on "Retry"; it is a trigger, not read in the body.
  useEffect(() => {
    let cancelled = false;
    if (
      (action !== "reassign" && action !== "reschedule") ||
      Date.parse(isoFromLocal(start)) >= Date.parse(isoFromLocal(end))
    ) {
      setActionEligibleClinicians([]);
      setActionEligibilityState("idle");
      return;
    }
    setActionEligibilityState("loading");
    setActionEligibilityHint(null);
    void (async () => {
      const result = await eligibilityApi(client).GET("/api/v1/scheduling/eligible-clinicians", {
        params: {
          query: {
            patientId: visit.patientId,
            visitPurpose: visit.visitPurpose,
            scheduledStartedAt: isoFromLocal(start),
            scheduledEndedAt: isoFromLocal(end),
          },
        },
      });
      if (cancelled) return;
      if (result.error) {
        setActionEligibleClinicians([]);
        setActionEligibilityState("error");
        return;
      }
      const rows = (result.data ?? []) as EligibleClinician[];
      setActionEligibleClinicians(rows);
      setActionEligibilityState("ready");
      setClinicianId((previous) => {
        const candidateId = previous || (action === "reschedule" ? visit.assignedMembershipId : "");
        if (!candidateId) return previous;
        const candidate = rows.find((clinician) => clinician.membershipId === candidateId);
        if (candidate?.eligible) return candidateId;
        setActionEligibilityHint(
          `${candidate?.displayName ?? "The current clinician"} is no longer available: ${eligibilityReason(candidate?.reasonCodes ?? [])}`,
        );
        return "";
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    action,
    client,
    eligibilityRefresh,
    end,
    start,
    visit.assignedMembershipId,
    visit.patientId,
    visit.visitPurpose,
  ]);

  const permissions = session?.permissions;
  const buttons = useMemo(() => {
    const out: Array<{
      action: VisitAction;
      label: string;
      tone?: "primary" | "secondary" | "danger";
      icon: "clock" | "check" | "users" | "calendar" | "block" | "alert";
    }> = [];
    if (visit.status === "published" && hasPermission(permissions, "visit.start"))
      out.push({ action: "start", label: "Start", icon: "clock" });
    if (visit.status === "en_route" && hasPermission(permissions, "visit.start"))
      out.push({ action: "arrive", label: "Check in", icon: "check" });
    if (
      ["published", "en_route"].includes(visit.status) &&
      hasPermission(permissions, "visit.reassign")
    )
      out.push({
        action: "reassign",
        label: "Reassign",
        tone: "secondary",
        icon: "users",
      });
    if (visit.status === "published" && hasPermission(permissions, "visit.reschedule"))
      out.push({
        action: "reschedule",
        label: "Reschedule",
        tone: "secondary",
        icon: "calendar",
      });
    if (
      ["published", "en_route", "in_visit"].includes(visit.status) &&
      hasPermission(permissions, "visit.cancel")
    )
      out.push({
        action: "cancel",
        label: "Cancel",
        tone: "danger",
        icon: "block",
      });
    if (visit.status === "published" && hasPermission(permissions, "visit.mark_no_show"))
      out.push({
        action: "no-show",
        label: "No-show",
        tone: "danger",
        icon: "alert",
      });
    return out;
  }, [permissions, visit.status]);

  async function mutate(): Promise<void> {
    if (!action) return;
    if (action === "start" || action === "arrive") {
      const problem = evvReasonProblem(evvReason);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const reasonRequired = action === "reschedule" || action === "cancel";
    if (reasonRequired && reason.trim().length < 20) {
      setFieldErrors({ reason: "Please enter at least 20 characters." });
      setBusy(false);
      return;
    }
    if (
      action === "reschedule" &&
      Date.parse(isoFromLocal(end)) <= Date.parse(isoFromLocal(start))
    ) {
      setFieldErrors({
        scheduledEndedAt: "The visit end time must be later than the start time.",
      });
      setBusy(false);
      return;
    }
    if (
      (action === "start" || action === "arrive") &&
      evvReason.trim() &&
      evvReason.trim().length < 40
    ) {
      setFieldErrors({
        evvMissingReason: "Please enter at least 40 characters.",
      });
      setBusy(false);
      return;
    }
    let result:
      | { data?: unknown; error?: unknown; response?: Response }
      | {
          data?: { original: VisitView; created: VisitView };
          error?: unknown;
          response?: Response;
        };
    if (action === "start") {
      result = await client.POST("/api/v1/visits/{visitId}/start", {
        params: { path: { visitId: visit.id } },
        body: { evvMissingReason: evvReason.trim() },
      });
    } else if (action === "arrive") {
      result = await client.POST("/api/v1/visits/{visitId}/arrive", {
        params: { path: { visitId: visit.id } },
        body: { evvMissingReason: evvReason.trim() },
      });
    } else if (action === "reassign") {
      result = await client.POST("/api/v1/visits/{visitId}/reassign", {
        params: { path: { visitId: visit.id } },
        body: {
          newAssignedMembershipId: clinicianId,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      } as never);
    } else if (action === "reschedule") {
      result = await client.POST("/api/v1/visits/{visitId}/reschedule", {
        params: { path: { visitId: visit.id } },
        body: {
          newScheduledStartedAt: isoFromLocal(start),
          newScheduledEndedAt: isoFromLocal(end),
          ...(clinicianId ? { newAssignedMembershipId: clinicianId } : {}),
          reason: reason.trim(),
        },
      } as never);
    } else if (action === "cancel") {
      result = await client.POST("/api/v1/visits/{visitId}/cancel", {
        params: { path: { visitId: visit.id } },
        body: { reasonCode, reason: reason.trim() },
      } as never);
    } else {
      result = await client.POST("/api/v1/visits/{visitId}/no-show", {
        params: { path: { visitId: visit.id } },
        body: { reason: reason.trim() },
      } as never);
    }
    setBusy(false);
    if (result.error) {
      if (action === "start" || action === "arrive") {
        const stepUp = stepUpRedirectFor(result.error, `${location.pathname}${location.search}`);
        if (stepUp) {
          stashStepUpDraft(draftKey, { action, evvReason });
          navigate(stepUp);
          return;
        }
        if (isAssignedClinicianRefusal(result.error)) {
          setError(ASSIGNED_CLINICIAN_MESSAGE);
          return;
        }
      }
      setError(mapSchedulingApiError(result.error, result.response?.status).message);
      return;
    }
    const payload = result.data as
      | VisitView
      | { original: VisitView; created: VisitView }
      | undefined;
    setAction(null);
    setReason("");
    setEvvReason("");
    setClinicianId("");
    if (payload && "created" in payload) {
      onChanged(payload.original);
      navigate(`/scheduling/visits/${payload.created.id}`);
      return;
    }
    onChanged(payload as VisitView | undefined);
  }

  return (
    <>
      <div style={panel}>
        <h2 style={panelTitle}>Visit actions</h2>
        <div style={actionGrid}>
          {buttons.map((b) => (
            <Button
              key={b.action}
              tone={b.tone ?? "primary"}
              size="sm"
              onClick={() => {
                setError(null);
                setFieldErrors({});
                setActionEligibilityHint(null);
                setClinicianId("");
                setAction(b.action);
              }}
            >
              <Glyph name={b.icon} size={14} /> {b.label}
            </Button>
          ))}
          <Button
            size="sm"
            tone="secondary"
            onClick={() =>
              encounter
                ? navigate(`/patients/${encounter.patientId}/encounters/${encounter.id}`)
                : void onChanged()
            }
          >
            <Glyph name="file-text" size={14} />{" "}
            {encounter ? "Open Encounter" : "Refresh Encounter"}
          </Button>
        </div>
        {!encounter ? (
          <p style={muted}>
            Draft Encounter is created asynchronously after publish. Refresh if it is still
            processing.
          </p>
        ) : (
          <p style={muted}>
            Linked Encounter: <StatusPill label={stateLabel(encounter.status)} tone="neutral" />
          </p>
        )}
      </div>
      <Modal
        open={action !== null}
        onClose={busy ? undefined : () => setAction(null)}
        ariaLabel="Visit action"
        width="34rem"
      >
        <div style={modalBody}>
          <div style={modalHeader}>
            <h2 style={modalTitle}>{action ? actionTitle(action) : "Visit action"}</h2>
            <button
              type="button"
              onClick={() => setAction(null)}
              disabled={busy}
              style={iconButton}
            >
              <Glyph name="close" size={16} label="Close" />
            </button>
          </div>
          {error ? (
            <div role="alert" style={errorBanner}>
              {error}
            </div>
          ) : null}
          {action === "start" || action === "arrive" ? (
            <label style={field}>
              <span style={label}>EVV missing reason</span>
              <textarea
                value={evvReason}
                onChange={(e) => setEvvReason(e.target.value)}
                rows={3}
                style={textarea}
                aria-invalid={Boolean(fieldErrors.evvMissingReason)}
              />
              {fieldErrors.evvMissingReason ? (
                <span role="alert" style={{ color: "var(--color-error)", fontSize: "0.85em" }}>
                  {fieldErrors.evvMissingReason}
                </span>
              ) : null}
            </label>
          ) : null}
          {action === "reassign" || action === "reschedule" ? (
            <label style={field}>
              <span style={label}>{action === "reassign" ? "New clinician *" : "Clinician"}</span>
              {actionEligibilityState === "loading" ? (
                <small style={muted}>Checking clinician availability…</small>
              ) : null}
              <select
                value={clinicianId}
                onChange={(event) => setClinicianId(event.target.value)}
                style={input}
                disabled={actionEligibilityState !== "ready"}
              >
                <option value="">
                  {action === "reschedule"
                    ? "Select an eligible clinician…"
                    : "Select a new clinician…"}
                </option>
                {actionEligibleClinicians
                  .filter(
                    (clinician) =>
                      clinician.eligible &&
                      (action !== "reassign" ||
                        clinician.membershipId !== visit.assignedMembershipId),
                  )
                  .map((clinician) => (
                    <option key={clinician.membershipId} value={clinician.membershipId}>
                      {clinician.displayName} ·{" "}
                      {clinician.disciplines
                        .map((discipline) => discipline.toUpperCase())
                        .join(" / ")}
                    </option>
                  ))}
              </select>
              {actionEligibilityState === "ready" &&
              actionEligibleClinicians.filter(
                (clinician) =>
                  clinician.eligible &&
                  (action !== "reassign" || clinician.membershipId !== visit.assignedMembershipId),
              ).length === 0 ? (
                <small style={muted}>
                  No eligible clinicians available. No other clinician currently meets the
                  requirements for this patient, visit type, and time.
                </small>
              ) : null}
              {actionEligibilityState === "error" ? (
                <small style={muted}>
                  Clinician availability could not be checked. Please try again.
                </small>
              ) : null}
              {actionEligibilityHint ? (
                <output style={muted}>{actionEligibilityHint}</output>
              ) : null}
            </label>
          ) : null}
          {action === "reschedule" ? (
            <div style={grid2}>
              <label style={field}>
                <span style={label}>New start</span>
                <input
                  type="datetime-local"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  style={input}
                  aria-invalid={Boolean(fieldErrors.scheduledEndedAt)}
                />
              </label>
              <label style={field}>
                <span style={label}>New end</span>
                <input
                  type="datetime-local"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  style={input}
                />
              </label>
            </div>
          ) : null}
          {fieldErrors.scheduledEndedAt ? (
            <span role="alert" style={{ color: "var(--color-error)", fontSize: "0.85em" }}>
              {fieldErrors.scheduledEndedAt}
            </span>
          ) : null}
          {action === "cancel" ? (
            <label style={field}>
              <span style={label}>Reason code</span>
              <select
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value)}
                style={input}
              >
                <option value="patient_request">Patient request</option>
                <option value="clinical_hold">Clinical hold</option>
                <option value="staff_unavailable">Staff unavailable</option>
                <option value="other">Other</option>
              </select>
            </label>
          ) : null}
          {action && ["reassign", "reschedule", "cancel", "no-show"].includes(action) ? (
            <label style={field}>
              <span style={label}>
                {action === "reschedule"
                  ? "Reason for rescheduling *"
                  : action === "cancel"
                    ? "Reason for cancellation *"
                    : "Reason"}
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                style={textarea}
                aria-invalid={Boolean(fieldErrors.reason)}
              />
              {action === "reschedule" || action === "cancel" ? (
                <small style={muted}>
                  {reason.trim().length < 20
                    ? `${reason.trim().length} / 20 minimum`
                    : `${reason.trim().length} characters`}{" "}
                  · Please provide enough context for the care team.
                </small>
              ) : null}
              {fieldErrors.reason ? (
                <span role="alert" style={{ color: "var(--color-error)", fontSize: "0.85em" }}>
                  {fieldErrors.reason}
                </span>
              ) : null}
            </label>
          ) : null}
          {action === "reschedule" ? (
            <p style={muted}>
              This preserves lineage: the original Visit becomes rescheduled and a new Visit is
              published.
            </p>
          ) : null}
          <div style={actions}>
            <Button tone="tertiary" onClick={() => setAction(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              tone={action === "cancel" || action === "no-show" ? "danger" : "primary"}
              loading={busy}
              disabled={
                busy ||
                ((action === "reassign" || action === "reschedule") &&
                  (!clinicianId || actionEligibilityState !== "ready")) ||
                ((action === "reschedule" || action === "cancel") && reason.trim().length < 20) ||
                (action === "reschedule" &&
                  Date.parse(isoFromLocal(end)) <= Date.parse(isoFromLocal(start))) ||
                ((action === "start" || action === "arrive") &&
                  evvReason.trim().length > 0 &&
                  evvReason.trim().length < 40)
              }
              onClick={() => void mutate()}
            >
              Confirm
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export async function findLinkedEncounter(
  client: ApiClient,
  visit: { id: string; patientId: string; admissionId?: string | null },
): Promise<EncounterLink | null> {
  const { data } = await client.GET("/api/v1/encounters", {
    params: {
      query: {
        patientId: visit.patientId,
        ...(visit.admissionId ? { admissionId: visit.admissionId } : {}),
        limit: 50,
      },
    },
  } as never);
  const encounters = ((data as { encounters?: EncounterLink[] } | undefined)?.encounters ??
    []) as EncounterLink[];
  return encounters.find((encounter) => encounter.visitId === visit.id) ?? null;
}

function actionTitle(action: VisitAction): string {
  if (action === "start") return "Start Visit";
  if (action === "arrive") return "Check in";
  if (action === "reassign") return "Reassign Visit";
  if (action === "reschedule") return "Reschedule Visit";
  if (action === "cancel") return "Cancel Visit";
  return "Mark No-show";
}

export function FieldValue({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div style={fieldValue}>
      <span style={fieldValueLabel}>{label}</span>
      <span style={fieldValueText}>{children}</span>
    </div>
  );
}

const modalBody: CSSProperties = {
  padding: "1.25rem",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};
const modalHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
};
const modalTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  color: t.onSurface,
};
const grid2: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))",
  gap: "0.85rem",
};
const field: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};
const label: CSSProperties = {
  fontSize: "0.8125rem",
  fontWeight: 650,
  color: t.onSurface,
};
const input: CSSProperties = {
  minHeight: "2.5rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.outlineVariant}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  padding: "0.45rem 0.65rem",
};
const textarea: CSSProperties = {
  ...input,
  resize: "vertical",
  fontFamily: t.fontSans,
};
const checkRow: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "center",
  fontSize: "0.85rem",
  color: t.onSurface,
};
const actions: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.6rem",
  flexWrap: "wrap",
};
const muted: CSSProperties = {
  margin: 0,
  color: t.onSurfaceVariant,
  fontSize: "0.8rem",
};
const errorBanner: CSSProperties = {
  padding: "0.7rem 0.85rem",
  borderRadius: t.radiusMd,
  color: t.error,
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  fontSize: "0.82rem",
};
const iconButton: CSSProperties = {
  border: "none",
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
  borderRadius: "9999px",
  width: "2rem",
  height: "2rem",
  display: "grid",
  placeItems: "center",
  cursor: "pointer",
};
const panel: CSSProperties = {
  borderRadius: t.radiusMd,
  background: t.surfaceContainer,
  padding: "1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};
const panelTitle: CSSProperties = {
  margin: 0,
  fontSize: "0.95rem",
  color: t.onSurface,
  fontWeight: 700,
};
const actionGrid: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem",
};
const fieldValue: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.1rem",
};
const fieldValueLabel: CSSProperties = {
  fontSize: "0.72rem",
  color: t.onSurfaceVariant,
  fontWeight: 650,
};
const fieldValueText: CSSProperties = {
  fontSize: "0.88rem",
  color: t.onSurface,
};
