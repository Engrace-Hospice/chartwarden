import { Button, Glyph, Modal, StatusPill, t, useApiClient } from "@wardenx/ui";
import type { ApiClient, EntityLookupOption } from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, FormEvent, JSX, ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  AdmissionLookupField,
  MdmEntityLookupField,
  MembershipLookupField,
  PatientLookupField,
} from "../../shell/entity-lookups";
import { useSession } from "../../shell/session";
import { VISIT_TONE, stateLabel } from "./scheduling-status";

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

export function apiErrorMessage(error: unknown, fallback: string): string {
  const body = error as {
    message?: string;
    title?: string;
    detail?: string;
    code?: string;
    error?: { message?: string; title?: string; detail?: string; code?: string };
    issues?: Array<{ message?: string }>;
  } | null;
  const nested = body?.error;
  // §4.7 D8 — the pre-schedule gate refuses as `VISIT_PRE_SCHEDULE_GATE_UNMET` on create/publish and as
  // a 403 whose message is the bare constant `PRE_SCHEDULE_GATE_FAILED` on reassign/reschedule. Neither
  // is copy a scheduler can act on; the fix is a different clinician, not a retry, so say so.
  const d8Signal = [nested?.code, nested?.message, body?.code, body?.message];
  if (
    d8Signal.includes("VISIT_PRE_SCHEDULE_GATE_UNMET") ||
    d8Signal.includes("PRE_SCHEDULE_GATE_FAILED")
  )
    return "That clinician's discipline, active licence, caseload or approved time off does not allow this visit (§4.7 pre-schedule check). Choose a different clinician or time.";
  if (body?.issues?.length)
    return body.issues
      .map((i) => i.message)
      .filter(Boolean)
      .join("; ");
  if (body?.detail) return body.detail;
  if (body?.message) return body.message;
  if (body?.title) return body.title;
  if (nested?.detail) return nested.detail;
  if (nested?.message) return nested.message;
  if (nested?.title) return nested.title;
  if (nested?.code === "STEP_UP_REQUIRED") return "A fresh step-up is required for this action.";
  return fallback;
}

function toLocalInput(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(
    value.getHours(),
  )}:${pad(value.getMinutes())}`;
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

export function SchedulingNav({ onNewVisit }: { onNewVisit?: () => void }): JSX.Element {
  const location = useLocation();
  const session = useSession();
  const permissions = session?.permissions;
  const canCreate = hasPermission(permissions, "visit.create");
  const tabs = [
    { href: "/scheduling/day", label: "Day", permission: "visit.read_team" },
    { href: "/scheduling/week", label: "Week", permission: "visit.read_team" },
    { href: "/me/visits", label: "My Visits", permission: "visit.read" },
    { href: "/scheduling/recurring", label: "Recurring", permission: "recurring_visit.read" },
    { href: "/scheduling/proposals", label: "Proposals", permission: "visit.proposal.read" },
    { href: "/scheduling/time-off", label: "Time Off", permission: "time_off.read_team" },
  ] as const;
  const visibleTabs = tabs.filter((tab) => hasPermission(permissions, tab.permission));
  return (
    <div style={navShell}>
      <nav aria-label="Scheduling sections" style={navTabs}>
        {visibleTabs.map(({ href, label }) => {
          const active = location.pathname === href;
          return (
            <Link key={href} to={href} style={{ ...navLink, ...(active ? navLinkActive : null) }}>
              {label}
            </Link>
          );
        })}
      </nav>
      {canCreate && onNewVisit ? (
        <Button size="sm" onClick={onNewVisit}>
          <Glyph name="calendar" size={14} /> New Visit
        </Button>
      ) : null}
    </div>
  );
}

export function NewVisitModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (visit: VisitView) => void;
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
  const [facilityId, setFacilityId] = useState("");
  const [start, setStart] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60 * 1000)));
  const [end, setEnd] = useState(() => toLocalInput(new Date(Date.now() + 2 * 60 * 60 * 1000)));
  const [notes, setNotes] = useState("");
  const [reminder, setReminder] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset(): void {
    setPatientId("");
    setPatientLabel("");
    setAdmissionId("");
    setClinicianId("");
    setClinicianLabel("");
    setVisitPurpose("routine_visit");
    setVisitSetting("patient_home");
    setAddressId("");
    setFacilityId("");
    setNotes("");
    setReminder(false);
    setError(null);
  }

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
    const { data, error: err } = await client.POST("/api/v1/visits", {
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
      setError(apiErrorMessage(err, "The visit could not be created."));
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
          <MembershipLookupField
            label="Assigned clinician"
            value={clinicianId}
            valueLabel={clinicianLabel}
            onChange={(value, option) => {
              setClinicianId(value);
              setClinicianLabel(option?.searchLabel ?? "");
            }}
            required
          />
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
              <input
                value={addressId}
                onChange={(e) => setAddressId(e.target.value)}
                style={input}
              />
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
  const [action, setAction] = useState<VisitAction | null>(null);
  const [reason, setReason] = useState("");
  const [reasonCode, setReasonCode] = useState("patient_request");
  const [clinicianId, setClinicianId] = useState("");
  const [start, setStart] = useState(toLocalInput(new Date(visit.scheduledStartedAt)));
  const [end, setEnd] = useState(toLocalInput(new Date(visit.scheduledEndedAt)));
  const [evvReason, setEvvReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      out.push({ action: "reassign", label: "Reassign", tone: "secondary", icon: "users" });
    if (visit.status === "published" && hasPermission(permissions, "visit.reschedule"))
      out.push({ action: "reschedule", label: "Reschedule", tone: "secondary", icon: "calendar" });
    if (
      ["published", "en_route", "in_visit"].includes(visit.status) &&
      hasPermission(permissions, "visit.cancel")
    )
      out.push({ action: "cancel", label: "Cancel", tone: "danger", icon: "block" });
    if (visit.status === "published" && hasPermission(permissions, "visit.mark_no_show"))
      out.push({ action: "no-show", label: "No-show", tone: "danger", icon: "alert" });
    return out;
  }, [permissions, visit.status]);

  async function mutate(): Promise<void> {
    if (!action) return;
    setBusy(true);
    setError(null);
    let result:
      | { data?: unknown; error?: unknown }
      | { data?: { original: VisitView; created: VisitView }; error?: unknown };
    if (action === "start") {
      result = await client.POST("/api/v1/visits/{visitId}/start", {
        params: { path: { visitId: visit.id } },
        body: evvReason.trim() ? { evvMissingReason: evvReason.trim() } : {},
      } as never);
    } else if (action === "arrive") {
      result = await client.POST("/api/v1/visits/{visitId}/arrive", {
        params: { path: { visitId: visit.id } },
        body: evvReason.trim() ? { evvMissingReason: evvReason.trim() } : {},
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
      setError(apiErrorMessage(result.error, "The visit action could not be completed."));
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
              onClick={() => setAction(b.action)}
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
              />
            </label>
          ) : null}
          {action === "reassign" || action === "reschedule" ? (
            <MembershipLookupField
              label={action === "reassign" ? "New clinician" : "New clinician"}
              value={clinicianId}
              onChange={(value) => setClinicianId(value)}
              required={action === "reassign"}
            />
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
              <span style={label}>Reason</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                style={textarea}
              />
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
}: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div style={fieldValue}>
      <span style={fieldValueLabel}>{label}</span>
      <span style={fieldValueText}>{children}</span>
    </div>
  );
}

const navShell: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0 1.5rem 0.75rem",
  flexWrap: "wrap",
};
const navTabs: CSSProperties = { display: "flex", gap: "0.35rem", flexWrap: "wrap" };
const navLink: CSSProperties = {
  padding: "0.4rem 0.75rem",
  borderRadius: "9999px",
  color: t.onSurfaceVariant,
  textDecoration: "none",
  fontSize: "0.8rem",
  fontWeight: 650,
};
const navLinkActive: CSSProperties = { background: t.primaryTint, color: t.primary };
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
const field: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.4rem" };
const label: CSSProperties = { fontSize: "0.8125rem", fontWeight: 650, color: t.onSurface };
const input: CSSProperties = {
  minHeight: "2.5rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.outlineVariant}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  padding: "0.45rem 0.65rem",
};
const textarea: CSSProperties = { ...input, resize: "vertical", fontFamily: t.fontSans };
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
const muted: CSSProperties = { margin: 0, color: t.onSurfaceVariant, fontSize: "0.8rem" };
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
const actionGrid: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "0.5rem" };
const fieldValue: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.1rem" };
const fieldValueLabel: CSSProperties = {
  fontSize: "0.72rem",
  color: t.onSurfaceVariant,
  fontWeight: 650,
};
const fieldValueText: CSSProperties = { fontSize: "0.88rem", color: t.onSurface };
