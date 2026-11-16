import {
  DetailPageLayout,
  EmptyState,
  Glyph,
  PageHeader,
  type ReadStatus,
  StatusPill,
  cardSurface,
  formatDateOnly,
  isoToLocalInput,
  settleRead,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { NameLabel, patientNameOf } from "../../shell/name-display";
import { type PatientNames, usePatientNames } from "../../shell/patient-names";
import { useSession } from "../../shell/session";
import {
  type AuthorDiscipline,
  RECORD_UNCONFIRMED,
  authorDisciplinesForRoles,
  failedResultOutcomeUnknown,
  recordTimepoint,
  withRequestTimeout,
} from "./hope-api";
import { AuthorDisciplineField } from "./hope-author-discipline-field";
import { completeSfvPath } from "./hope-paths";
import { HopeListReadState } from "./hope-read-state";
import { DEFAULT_DATE_HINT } from "./hope-record-modal";
import { LoadingRegion, useRetryFocus } from "./hope-retry-focus";
import { WORKFLOW_TONE, rfaLabel, stateLabel } from "./hope-status";
import { useFocusOnNewError } from "./use-focus-on-new-error";

type FixedKind = "01_admission" | "02_huv1" | "03_huv2" | "05_discharge";
type DischargeReason = "death" | "revocation" | "transfer_to_hospice" | "live_discharge";

interface WorkflowTimepoint {
  kind: FixedKind;
  status: string;
  windowStart: string | null;
  windowEnd: string | null;
  lateDeadline: string | null;
  assessmentId: string | null;
}
interface WorkflowSfv {
  id: string;
  status: string;
  triggeringAssessmentId: string;
  triggeringRfaKind: string | null;
  dueAt: string;
  completingAssessmentId: string | null;
}
interface WorkflowState {
  admissionId: string;
  patientId: string | null;
  admissionStatus: string | null;
  admissionAt: string | null;
  admissionAssessment: WorkflowTimepoint;
  huv1: WorkflowTimepoint;
  huv2: WorkflowTimepoint;
  sfvs: WorkflowSfv[];
  dischargeAssessment: WorkflowTimepoint;
}

const TIMEPOINT_PARAM_TO_KIND: Record<string, FixedKind> = {
  "01_admission": "01_admission",
  "02_huv1": "02_huv1",
  "03_huv2": "03_huv2",
  "05_discharge": "05_discharge",
};
const LATE_REASONS = [
  { value: "hospitalization", label: "Patient hospitalization" },
  { value: "pto", label: "Staff time off" },
  { value: "family_meeting_deferral", label: "Family meeting deferral" },
  { value: "refused", label: "Patient or family refused" },
  { value: "missed", label: "Missed visit" },
  { value: "pandemic_cohort", label: "Pandemic cohorting" },
  { value: "other", label: "Other" },
] as const;

export function HopeTimepointCapture(): JSX.Element {
  const { admissionId, kind: rawKind } = useParams<{ admissionId: string; kind: string }>();
  const kind = rawKind ? TIMEPOINT_PARAM_TO_KIND[rawKind] : undefined;
  return <HopeCaptureWorkspace admissionId={admissionId} kind={kind} sfvId={undefined} />;
}

export function HopeSfvCapture(): JSX.Element {
  const { admissionId, sfvId } = useParams<{ admissionId: string; sfvId: string }>();
  return <HopeCaptureWorkspace admissionId={admissionId} kind={undefined} sfvId={sfvId} />;
}

function HopeCaptureWorkspace({
  admissionId,
  kind,
  sfvId,
}: {
  admissionId?: string;
  kind?: FixedKind;
  sfvId?: string;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [state, setState] = useState<WorkflowState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readStatus, setReadStatus] = useState<ReadStatus>("ok");
  const retry = useRetryFocus(loading, readStatus === "ok" ? null : readStatus);
  const [actionError, setActionError] = useState<string | null>(null);
  // A refusal takes focus: the Create button is disabled while the write is out, and a browser that drops focus from a
  // disabled control (Firefox, Safari) would leave the keyboard user at the top of the page.
  const actionErrorRef = useFocusOnNewError<HTMLParagraphElement>(actionError);
  const [targetDate, setTargetDate] = useState(isoToLocalInput(new Date().toISOString()));
  // The date opens at the current time: said so, beside the field, until the clinician has entered one (as the record dialog does).
  const [dateEdited, setDateEdited] = useState(false);
  // The disciplines the ACTING user may be attributed as (their own role keys, as the server checks them): one is preselected,
  // several make the clinician choose, none blocks the capture with a message. A fixed list sent a discipline the server then
  // refused (403) to anyone who did not hold that exact role.
  const session = useSession();
  const roles = session?.roles;
  const disciplines = useMemo(() => authorDisciplinesForRoles(roles ?? []), [roles]);
  const [chosenDiscipline, setChosenDiscipline] = useState<AuthorDiscipline | "">("");
  const discipline: AuthorDiscipline | "" =
    chosenDiscipline !== ""
      ? chosenDiscipline
      : disciplines.length === 1
        ? (disciplines[0] ?? "")
        : "";
  const [lateReason, setLateReason] = useState("");
  // Not pre-selected: the discharge reason decides which sections the record needs, so the clinician chooses it.
  const [dischargeReason, setDischargeReason] = useState<DischargeReason | "">("");
  // A reply that arrives after the clinician has left must not pull them to the draft it created, and a rejected request must not
  // start a re-read for a screen nobody is on. (Those two guards in submitTimepoint are the only ones needed: React 18 treats a state
  // update on an unmounted component as a no-op.)
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * The workflow read. A rejected, stalled or bodiless-502 read is a `failed` read (with Retry), never a spinner that does not
   * end or a workflow that is "not available"; a refused one is `denied`, and so is a 404: hope.scope answers an admission
   * outside the caller's caseload with it (deny-as-not-found), so Retry cannot make it appear.
   */
  const readWorkflow = useCallback(
    async () =>
      admissionId
        ? await settleRead(
            withRequestTimeout((signal) =>
              client.GET("/api/v1/admissions/{admissionId}/hope", {
                params: { path: { admissionId } },
                signal,
              }),
            ),
            "denied",
          )
        : { status: "failed" as const, res: undefined },
    [admissionId, client],
  );

  const latestLoad = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latestLoad.current;
    setLoading(true);
    const { status, res } = await readWorkflow();
    if (mine !== latestLoad.current) return;
    if (status === "ok" && res?.data) setState(res.data as WorkflowState);
    setReadStatus(status === "ok" && !res?.data ? "failed" : status);
    setLoading(false);
  }, [readWorkflow]);

  /**
   * Re-reads the workflow WITHOUT leaving the form (no loading region: the typed date, the focus and the explanation that
   * follows stay where they are). Null when it could not be read: the page then keeps the state it has.
   */
  const rereadWorkflow = useCallback(async (): Promise<WorkflowState | null> => {
    const { status, res } = await readWorkflow();
    if (status !== "ok" || !res?.data) return null;
    const fresh = res.data as WorkflowState;
    setState(fresh);
    return fresh;
  }, [readWorkflow]);

  useEffect(() => {
    void load();
  }, [load]);

  const patientNames = usePatientNames(state?.patientId ? [state.patientId] : []);

  const item = useMemo(() => (state && kind ? timepointOf(state, kind) : null), [kind, state]);
  const sfv = useMemo(() => state?.sfvs.find((s) => s.id === sfvId) ?? null, [sfvId, state]);
  const title = sfv ? "Symptom Follow-Up" : item ? `${rfaLabel(item.kind)} Assessment` : "HOPE";

  const targetIso = fromDatetimeLocal(targetDate);
  const submitTimepoint = useCallback(async () => {
    if (!admissionId || !item || discipline === "" || targetIso === null) return;
    // The discharge reason is the clinician's choice (and the control is only there on a discharge).
    if (item.kind === "05_discharge" && dischargeReason === "") return;
    // The late reason is a required input of a late item, as in the record dialog: the form says so and does not send without it.
    if (item.status === "late" && lateReason.trim() === "") return;
    setBusy(true);
    setActionError(null);
    try {
      // The same bounded, reply-classifying write the record dialog uses: a request nobody answers ends as "could not
      // confirm" (not a form stuck on "Recording..."), and a gateway fault or an empty reply is worded as one.
      const res = await recordTimepoint(client, admissionId, {
        rfaKind: item.kind,
        targetDate: targetIso,
        authorDiscipline: discipline,
        data: { J: { J2051: { entries: [] } } },
        // Only what is on screen: the reason control exists only for a late item, and the route may have moved on to another.
        lateCompletionReasonCode:
          item.status === "late" ? lateReason.trim() || undefined : undefined,
        dischargeReason: item.kind === "05_discharge" ? dischargeReason || undefined : undefined,
      });
      if (!mounted.current) return;
      if (!res.ok) {
        if (isWindowRefusal(res.code, item)) {
          // The screen's picture of the window is the one read at load, and the server judged the typed date (and a later
          // moment). Re-read it quietly, so the controls (the late reason, or the notice that the period has ended) match the
          // refusal, then say whose it was: a window that moved, or the date the clinician typed.
          const fresh = await rereadWorkflow();
          setActionError(
            windowRefusalMessage(res.code, item, fresh ? timepointOf(fresh, item.kind) : null),
          );
          return;
        }
        setActionError(messageForBackendCode(res.code) ?? res.message);
        // An empty 5xx or a fault of the server's own may have created the draft after all: its words say to check the record, and
        // this page offers Create until it knows one exists, so it reads the workflow again (quietly, and not awaited: busy is freed).
        if (failedResultOutcomeUnknown(res)) void rereadWorkflow();
        return;
      }
      navigate(`/hope/assessments/${res.value.id}`);
    } catch {
      setActionError(RECORD_UNCONFIRMED);
      // No answer at all (offline, a reset, a timeout): the same, unless the clinician has already left.
      if (mounted.current) void rereadWorkflow();
    } finally {
      setBusy(false);
    }
  }, [
    admissionId,
    client,
    discipline,
    dischargeReason,
    item,
    lateReason,
    navigate,
    rereadWorkflow,
    targetIso,
  ]);

  if (loading) return <LoadingRegion label="Loading HOPE workflow…" regionRef={retry.loadingRef} />;
  if (readStatus !== "ok" || !state)
    return (
      <div ref={retry.errorRef} tabIndex={-1}>
        <HopeListReadState
          status={readStatus === "denied" ? "denied" : "failed"}
          subject="the HOPE workflow for this admission"
          failedTitle="Unable to load HOPE workflow"
          onRetry={() => {
            retry.retried();
            void load();
          }}
        />
      </div>
    );
  if (!sfv && !item)
    return (
      <EmptyState title="HOPE item not found" description="This workflow item is not available." />
    );

  const status = sfv?.status ?? item?.status ?? "not_applicable";
  const canSubmit = sfv
    ? sfv.status === "open" || sfv.status === "overdue"
    : item?.status === "open" || item?.status === "late";
  // What blocks Create is a missing INPUT (a discipline, a date, a discharge reason, a late reason). Whether the window is still open
  // stays the server's call: the page's picture of it was read at load, so it is not used to predict a refusal.
  const submitBlocked =
    busy ||
    discipline === "" ||
    targetIso === null ||
    (item?.status === "late" && lateReason.trim() === "") ||
    (item?.kind === "05_discharge" && dischargeReason === "");

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={title}
          actions={
            <button
              type="button"
              onClick={() => navigate(`/admissions/${state.admissionId}/hope`)}
              style={ghostBtn}
            >
              HOPE Overview
            </button>
          }
        >
          <span style={metaLine}>
            Patient{" "}
            <span className="wx-data-md">{patientLabel(state.patientId, patientNames)}</span>
            {state.admissionAt ? ` · Admission ${fmtAdmissionDate(state.admissionAt)}` : ""}
          </span>
        </PageHeader>
      }
    >
      <section style={cardStyle}>
        <div style={headerRow}>
          <div>
            <h2 style={sectionTitle}>
              {sfv ? "Symptom follow-up completion" : "HOPE assessment capture"}
            </h2>
            <p style={bodyText}>
              {sfv
                ? `Triggered by ${sfv.triggeringRfaKind ? rfaLabel(sfv.triggeringRfaKind) : "a moderate/severe symptom assessment"}.`
                : guidanceFor(item)}
            </p>
          </div>
          <StatusPill label={workflowLabel(status)} tone={WORKFLOW_TONE[status] ?? "neutral"} />
        </div>

        {/* Outside the form on purpose: a refusal about the window can re-read it into a state with no form, and the explanation
            (which holds focus) must outlive that. */}
        {actionError ? (
          <p
            ref={actionErrorRef}
            tabIndex={-1}
            role="alert"
            aria-live="assertive"
            style={errorText}
          >
            {actionError}
          </p>
        ) : null}

        {item ? (
          <div style={factsGrid}>
            <Fact label="Window" value={formatWindow(item.windowStart, item.windowEnd)} />
            <Fact label="Late deadline" value={fmtDate(item.lateDeadline)} />
          </div>
        ) : null}
        {sfv ? (
          <div style={factsGrid}>
            <Fact label="Due" value={fmtDate(sfv.dueAt)} />
            <Fact label="Trigger" value={sfv.triggeringAssessmentId} mono />
          </div>
        ) : null}

        {item?.assessmentId ? (
          <button
            type="button"
            onClick={() => navigate(`/hope/assessments/${item.assessmentId}`)}
            style={primaryBtn}
          >
            <Glyph name="file-text" size={14} />{" "}
            {item.status === "completed" ? "View completed assessment" : "Continue draft"}
          </button>
        ) : !canSubmit ? (
          <output style={noticeBox}>
            <Glyph
              name={
                status === "workflow_not_initialized" || status === "expired" ? "block" : "info"
              }
              size={16}
            />
            <span>{unavailableMessage(status, item)}</span>
          </output>
        ) : sfv ? (
          // The follow-up is answered (J2053A-H) in the triggering assessment's "Complete SFV" dialog. This page has
          // no such fields, and the server refuses an SFV completion without them, so it never submits one.
          <>
            <p style={bodyText}>
              The follow-up questions (J2053) are answered in the assessment that triggered this
              visit. Open it and the completion dialog opens for you.
            </p>
            <button
              type="button"
              onClick={() => navigate(completeSfvPath(sfv.triggeringAssessmentId))}
              style={primaryBtn}
            >
              <Glyph name="file-text" size={14} /> Open the triggering assessment
            </button>
          </>
        ) : (
          <form
            style={formGrid}
            onSubmit={(ev) => {
              ev.preventDefault();
              void submitTimepoint();
            }}
          >
            <label style={labelStyle} htmlFor="hope-target-date">
              Target date/time
            </label>
            <input
              id="hope-target-date"
              type="datetime-local"
              value={targetDate}
              onChange={(ev) => {
                setTargetDate(ev.target.value);
                setDateEdited(true);
              }}
              required
              aria-invalid={targetIso === null}
              aria-describedby={
                targetIso === null
                  ? "hope-target-date-error"
                  : dateEdited
                    ? undefined
                    : "hope-target-date-hint"
              }
              style={inputStyle}
            />
            {dateEdited ? null : (
              <p id="hope-target-date-hint" style={bodyText}>
                {DEFAULT_DATE_HINT}
              </p>
            )}
            {targetIso === null ? (
              <p id="hope-target-date-error" role="alert" style={errorText}>
                Enter a valid target date and time.
              </p>
            ) : null}
            <AuthorDisciplineField
              disciplines={disciplines}
              value={discipline}
              onChange={(value) => setChosenDiscipline(disciplines.find((d) => d === value) ?? "")}
              disabled={busy}
              noneMessage="None of your roles can be recorded as a HOPE author discipline, so this assessment cannot be attributed. Ask an administrator to review your role grants."
            />
            {item?.status === "late" ? (
              <>
                <label style={labelStyle} htmlFor="late-reason">
                  Late completion reason
                </label>
                <select
                  id="late-reason"
                  value={lateReason}
                  onChange={(ev) => setLateReason(ev.target.value)}
                  style={inputStyle}
                >
                  <option value="">Select a reason</option>
                  {LATE_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            {item?.kind === "05_discharge" ? (
              <>
                <label style={labelStyle} htmlFor="discharge-reason">
                  Discharge reason
                </label>
                <select
                  id="discharge-reason"
                  value={dischargeReason}
                  onChange={(ev) => setDischargeReason(ev.target.value as DischargeReason | "")}
                  style={inputStyle}
                >
                  <option value="">Select a reason</option>
                  <option value="live_discharge">Live discharge</option>
                  <option value="death">Death</option>
                  <option value="revocation">Revocation</option>
                  <option value="transfer_to_hospice">Transfer to hospice</option>
                </select>
              </>
            ) : null}
            <button
              type="submit"
              disabled={submitBlocked}
              style={submitBlocked ? disabledBtn : primaryBtn}
            >
              <Glyph name="clipboard-check" size={14} />{" "}
              {busy ? "Recording..." : "Create HOPE draft"}
            </button>
          </form>
        )}
      </section>
    </DetailPageLayout>
  );
}

function Fact({
  label,
  value,
  mono = false,
}: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div style={factStyle}>
      <span style={labelStyle}>{label}</span>
      <strong className={mono ? "wx-data-md" : undefined} style={factValue}>
        {value}
      </strong>
    </div>
  );
}

/** The capture-gate refusals that are about the window (or the date typed against it) rather than about what was entered. */
const WINDOW_MOVED =
  "The window for this assessment changed while you were on this page. Review the updated status.";
const WINDOW_UNREFRESHED =
  "The server refused this target date for the assessment window, and the page could not re-read the window. Check the date, or reload the page.";

/**
 * A window refusal the page cannot answer from what it loaded. A late item's missing reason it can (the reason control is on
 * screen), so that is not one. The server judges "before the window opens" on the typed date itself and everything else at the
 * later of the typed date and now, so the cause is the window moving OR the date typed: {@link windowRefusalMessage} tells which.
 */
function isWindowRefusal(code: string | null, item: WorkflowTimepoint): boolean {
  if (code === "M10_LATE_REASON_REQUIRED") return item.status !== "late";
  return code === "M10_TIMEPOINT_EXPIRED" || code === "M10_TIMEPOINT_NOT_OPEN";
}

const sameWindow = (a: WorkflowTimepoint, b: WorkflowTimepoint): boolean =>
  a.status === b.status &&
  a.windowStart === b.windowStart &&
  a.windowEnd === b.windowEnd &&
  a.lateDeadline === b.lateDeadline;

/**
 * Whose a window refusal was, from the window re-read after it (`fresh`, null when that read failed). A status or window that
 * differs from the loaded one means it moved on since; the same one means the clinician's typed date is what was refused (the
 * status is the server's own, judged at the re-read), so the message names the date and the bound it crossed.
 */
function windowRefusalMessage(
  code: string | null,
  item: WorkflowTimepoint,
  fresh: WorkflowTimepoint | null,
): string {
  if (fresh === null) return WINDOW_UNREFRESHED;
  if (!sameWindow(item, fresh)) return WINDOW_MOVED;
  // The bounds are instants, not calendar days: a date alone would send the clinician back with a time the server refuses again
  // (the start of the window in a US evening is the day before in UTC), so the bound is named with its time, in their zone.
  const at = (value: string | null): string => (value ? ` (${fmtDateTime(value)})` : "");
  if (code === "M10_TIMEPOINT_NOT_OPEN")
    return `The target date is before this assessment's window opens${at(item.windowStart)}. Choose a date and time at or after it.`;
  if (code === "M10_TIMEPOINT_EXPIRED")
    return `The target date is after the late deadline${at(item.lateDeadline)}. Choose a date and time at or before it.`;
  return `The target date is after the normal window closed${at(item.windowEnd)}. Choose a date and time inside the window.`;
}

/** This screen's own words for the other capture-gate refusals it can act on; null for any other code (the server's own message is shown). */
function messageForBackendCode(code: string | null): string | null {
  if (code === "M10_LATE_REASON_REQUIRED")
    return "This assessment is after the normal window. Select a late completion reason.";
  if (code === "M10_LATE_REASON_INVALID")
    return "That late completion reason is not accepted. Select a different reason.";
  if (code === "M10_VERSION_CONFLICT")
    return "This assessment changed since it was loaded. Reload and try again.";
  return null;
}

function timepointOf(state: WorkflowState, kind: FixedKind): WorkflowTimepoint {
  if (kind === "01_admission") return state.admissionAssessment;
  if (kind === "02_huv1") return state.huv1;
  if (kind === "03_huv2") return state.huv2;
  return state.dischargeAssessment;
}

function unavailableMessage(status: string, item: WorkflowTimepoint | null): string {
  if (status === "upcoming")
    return `${item ? rfaLabel(item.kind) : "This item"} opens ${fmtDate(item?.windowStart)}.`;
  if (status === "expired") return "The allowed capture period has expired.";
  if (status === "not_applicable") return "This item is not applicable for the current admission.";
  if (status === "workflow_not_initialized")
    return "This admission is missing its HOPE schedule. Use the existing admin repair path before recording.";
  if (status === "missed") return "The follow-up deadline passed without completion.";
  return "This workflow item is not available for capture.";
}

function guidanceFor(item: WorkflowTimepoint | null): string {
  if (!item) return "";
  if (item.status === "late")
    return `The normal window closed ${fmtDate(item.windowEnd)}. A late reason is required.`;
  if (item.status === "open") return `${rfaLabel(item.kind)} is ready to complete.`;
  if (item.status === "upcoming")
    return `${rfaLabel(item.kind)} opens ${fmtDate(item.windowStart)}.`;
  return workflowLabel(item.status);
}

function workflowLabel(status: string): string {
  if (status === "open") return "Action required";
  if (status === "late") return "Late completion";
  if (status === "workflow_not_initialized") return "Workflow not initialized";
  return stateLabel(status);
}

function formatWindow(start: string | null, end: string | null): string {
  if (!start || !end) return "-";
  return `${fmtDate(start)} - ${fmtDate(end)}`;
}

/** The patient's name; the id if the viewer cannot read the patient; "unresolved" with no patient. */
function patientLabel(patientId: string | null, names: PatientNames): JSX.Element | string {
  if (!patientId) return "unresolved";
  const name = patientNameOf(names, patientId);
  return name === null ? patientId : <NameLabel value={name} />;
}

/** `admissionAt` is a date column serialized as midnight UTC: format it date-only so US zones do not show the day before. */
function fmtAdmissionDate(value: string): string {
  const formatted = formatDateOnly(value);
  return formatted === value ? fmtDate(value) : formatted;
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/** An instant as the viewer's own date AND time ("Sep 1, 2026, 8:00 PM"); the value itself when it is not a date. */
function fmtDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

/** The instant a datetime-local value means, or null when it is cleared, part-typed or out of range (never "now"). */
function fromDatetimeLocal(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const cardStyle: CSSProperties = {
  ...cardSurface,
  padding: "1rem 1.25rem",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};
const headerRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1rem",
  flexWrap: "wrap",
};
const sectionTitle: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  fontFamily: t.fontDisplay,
  fontSize: "1.05rem",
  fontWeight: 700,
};
const metaLine: CSSProperties = { color: t.onSurfaceVariant, fontSize: "0.85rem" };
const bodyText: CSSProperties = {
  margin: "0.2rem 0 0",
  color: t.onSurfaceVariant,
  fontSize: "0.85rem",
};
const factsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))",
  gap: "0.75rem",
};
const factStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.2rem" };
const labelStyle: CSSProperties = {
  color: t.muted,
  fontSize: "0.72rem",
  fontWeight: 700,
};
const factValue: CSSProperties = { color: t.onSurface, fontSize: "0.9rem" };
const formGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(12rem, 20rem)",
  gap: "0.55rem",
};
const inputStyle: CSSProperties = {
  minHeight: "2.25rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-outline-variant)",
  background: t.surfaceLowest,
  color: t.onSurface,
  padding: "0.45rem 0.6rem",
};
const primaryBtn: CSSProperties = {
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
  borderRadius: "var(--radius-md)",
  background: t.primary,
  color: t.onPrimary,
  border: "none",
  cursor: "pointer",
  fontSize: "0.82rem",
  fontWeight: 700,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.4rem",
};
const ghostBtn: CSSProperties = {
  ...primaryBtn,
  background: t.surfaceContainer,
  color: t.onSurface,
};
const disabledBtn: CSSProperties = { ...primaryBtn, opacity: 0.55, cursor: "not-allowed" };
const noticeBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  background: t.surfaceContainer,
  color: t.onSurface,
};
const errorText: CSSProperties = { margin: 0, color: t.error, fontSize: "0.85rem" };
