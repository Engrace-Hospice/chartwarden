import { Button, Glyph, Modal, StatusPill, t, toLocalInput, useApiClient } from "@chartwarden/ui";
import type { ApiClient, EntityLookupOption } from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, FormEvent, JSX, ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  AdmissionLookupField,
  MdmEntityLookupField,
  PatientLookupField,
} from "../../shell/entity-lookups";
import { useSession } from "../../shell/session";
import { stashStepUpDraft, stepUpRedirectFor, takeStepUpDraft } from "../../shell/step-up-redirect";
import { mapSchedulingApiError } from "./scheduling-errors";
import { VISIT_TONE, stateLabel } from "./scheduling-status";
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
] as const;

const VISIT_SETTINGS = ["patient_home", "facility", "inpatient_unit", "telephonic"] as const;

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
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (visit: VisitView) => void;
  initialPatient?: { id: string; label: string } | null;
}): JSX.Element | null {
  const client = useApiClient();
  const [patientId, setPatientId] = useState("");
  const [patientLabel, setPatientLabel] = useState("");
  const [admissionId, setAdmissionId] = useState("");
  const [clinicianId, setClinicianId] = useState("");
  const [clinicianLabel, setClinicianLabel] = useState("");
  const [visitPurpose, setVisitPurpose] = useState("routine_visit");
  const [visitSetting, setVisitSetting] = useState("patient_home");
  const [addressId, setAddressId] = useState("");
  const [addresses, setAddresses] = useState<
    Array<{ id: string; label: string; isPrimary: boolean; current: boolean }>
  >([]);
  const [facilityId, setFacilityId] = useState("");
  const [start, setStart] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60 * 1000)));
  const [end, setEnd] = useState(() => toLocalInput(new Date(Date.now() + 2 * 60 * 60 * 1000)));
  const [notes, setNotes] = useState("");
  const [reminder, setReminder] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eligibleClinicians, setEligibleClinicians] = useState<EligibleClinician[]>([]);
  const [eligibilityState, setEligibilityState] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [eligibilityHint, setEligibilityHint] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !initialPatient) return;
    setPatientId(initialPatient.id);
    setPatientLabel(initialPatient.label);
  }, [open, initialPatient]);

  useEffect(() => {
    if (!open || !patientId || admissionId) return;
    void client
      .GET("/api/v1/patients/{patientId}/admissions", {
        params: { path: { patientId } },
      })
      .then((result) => {
        const active = ((result.data?.items ?? []) as Array<{ id: string; state: string }>).filter(
          (admission) => admission.state === "active",
        );
        if (active.length === 1) setAdmissionId(active[0]!.id);
      });
  }, [admissionId, client, open, patientId]);

  function reset(): void {
    setPatientId("");
    setPatientLabel("");
    setAdmissionId("");
    setClinicianId("");
    setClinicianLabel("");
    setVisitPurpose("routine_visit");
    setVisitSetting("patient_home");
    setAddressId("");
    setAddresses([]);
    setFacilityId("");
    setNotes("");
    setReminder(false);
    setError(null);
    setEligibleClinicians([]);
    setEligibilityState("idle");
    setEligibilityHint(null);
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
      if (
        clinicianId &&
        !rows.some((clinician) => clinician.membershipId === clinicianId && clinician.eligible)
      ) {
        const selected = rows.find((clinician) => clinician.membershipId === clinicianId);
        setClinicianId("");
        setClinicianLabel("");
        setEligibilityHint(
          selected
            ? `Selected clinician removed: ${eligibilityReason(selected.reasonCodes)}`
            : "Selected clinician is no longer eligible for this visit.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, patientId, visitPurpose, start, end, clinicianId]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!patientId || !admissionId || !clinicianId) {
      setError("Select a patient, active admission, and clinician.");
      return;
    }
    if (Date.parse(isoFromLocal(end)) <= Date.parse(isoFromLocal(start))) {
      setError("Scheduled end must be after scheduled start.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const {
      data,
      error: err,
      response,
    } = await client.POST("/api/v1/visits", {
      body: {
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
      },
    } as never);
    setSubmitting(false);
    if (err || !data) {
      setError(mapSchedulingApiError(err, response?.status).message);
      return;
    }
    reset();
    onCreated(data as VisitView);
  }

  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={submitting ? undefined : onClose}
      ariaLabel="New Visit"
      width="42rem"
    >
      <form onSubmit={(event) => void submit(event)} style={modalBody}>
        <div style={modalHeader}>
          <div>
            <h2 style={modalTitle}>New Visit</h2>
            <p style={muted}>
              Schedule ownership stays in M17; Encounter draft seeding is backend-owned.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} style={iconButton}>
            <Glyph name="close" size={16} label="Close" />
          </button>
        </div>
        {error ? (
          <div role="alert" style={errorBanner}>
            {error}
          </div>
        ) : null}
        <div style={grid2}>
          <PatientLookupField
            label="Patient"
            value={patientId}
            valueLabel={patientLabel}
            onChange={(value, option) => {
              setPatientId(value);
              setPatientLabel(option?.searchLabel ?? "");
              setAdmissionId("");
              setAddressId("");
              setClinicianId("");
              setClinicianLabel("");
            }}
            required
          />
          <AdmissionLookupField
            label="Active admission"
            patientId={patientId}
            state="active"
            value={admissionId}
            onChange={(value) => setAdmissionId(value)}
            required
            disabled={!patientId}
          />
          <label style={field}>
            <span style={label}>Visit purpose *</span>
            <select
              value={visitPurpose}
              onChange={(e) => setVisitPurpose(e.target.value)}
              style={input}
            >
              {VISIT_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {stateLabel(p)}
                </option>
              ))}
            </select>
          </label>
          <label style={field}>
            <span style={label}>Visit setting *</span>
            <select
              value={visitSetting}
              onChange={(e) => setVisitSetting(e.target.value)}
              style={input}
            >
              {VISIT_SETTINGS.map((p) => (
                <option key={p} value={p}>
                  {stateLabel(p)}
                </option>
              ))}
            </select>
          </label>
          <label style={field}>
            <span style={label}>Scheduled start *</span>
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              style={input}
            />
          </label>
          <label style={field}>
            <span style={label}>Scheduled end *</span>
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              style={input}
            />
          </label>
          <label style={field}>
            <span style={label}>Assigned clinician *</span>
            <select
              value={clinicianId}
              onChange={(e) => {
                const selected = eligibleClinicians.find(
                  (clinician) => clinician.membershipId === e.target.value,
                );
                setClinicianId(e.target.value);
                setClinicianLabel(selected?.displayName ?? "");
              }}
              style={input}
              disabled={eligibilityState !== "ready"}
            >
              <option value="">
                {eligibilityState === "loading"
                  ? "Checking eligible clinicians…"
                  : "Select an eligible clinician…"}
              </option>
              {eligibleClinicians
                .filter((clinician) => clinician.eligible)
                .map((clinician) => (
                  <option key={clinician.membershipId} value={clinician.membershipId}>
                    {clinician.displayName} ·{" "}
                    {clinician.disciplines
                      .map((discipline) => discipline.toUpperCase())
                      .join(" / ")}
                  </option>
                ))}
            </select>
            {eligibilityState === "ready" &&
            eligibleClinicians.filter((clinician) => clinician.eligible).length === 0 ? (
              <small style={muted}>
                No eligible clinicians for this patient and visit context. Review the care team,
                credentials, or selected time.
              </small>
            ) : null}
            {eligibilityState === "error" ? (
              <small style={muted}>
                Eligible clinicians could not be checked. Try again before creating the visit.
              </small>
            ) : null}
            {eligibilityHint ? <output style={muted}>{eligibilityHint}</output> : null}
          </label>
          {visitSetting === "facility" ? (
            <MdmEntityLookupField
              kind="facility"
              label="External facility"
              value={facilityId}
              onChange={(value) => setFacilityId(value)}
            />
          ) : (
            <label style={field}>
              <span style={label}>Patient address</span>
              <select
                value={addressId}
                onChange={(e) => setAddressId(e.target.value)}
                style={input}
                disabled={!patientId}
              >
                <option value="">
                  {patientId ? "No address selected" : "Select a patient first"}
                </option>
                {addresses.map((address) => (
                  <option key={address.id} value={address.id}>
                    {address.label}
                    {address.current && address.isPrimary ? " (primary)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <label style={field}>
          <span style={label}>Scheduler notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
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
        <div style={actions}>
          <Button tone="tertiary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting}>
            <Glyph name="check" size={14} /> Create Visit
          </Button>
        </div>
      </form>
    </Modal>
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
