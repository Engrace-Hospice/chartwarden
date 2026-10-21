import { Button, Modal, SelectField, TextAreaField, TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/14-idg — the §2.2/§2.7/D8/§7.8 write ceremonies that are not the decision
// recorder (#91): attendance check-in, agenda add, action-item assignment, the meeting lifecycle
// transitions, and the §7.8 minutes amendment request.
//
// One file, five small modals, because they share every control but the body and they are all reached
// from the same two screens. `idg-decision-modal.tsx` is separate: the §2.6 payload union is nine
// discriminated shapes and carrying it here would bury everything else.
//
// THE ADJOURNMENT IS NOT AN ORDINARY CONFIRM. It is the §2.2 commit point: it emits every open
// decision to the cross-module seam, freezes the packets, stamps `last_idg_reviewed_at` — the only
// thing that resets the §418.56(d) 15-day review floor — and finalizes the minutes. It requires a
// FRESH step-up, which the server resolves from the caller's real session (F-028 removed the
// `x-step-up` header this route used to trust), so this dialog cannot make a session fresh: it states
// what is about to be committed, sends the request, and renders a 412 as the re-authentication prompt.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  type ActionItemView,
  type AgendaItemView,
  type AgendaKind,
  type AttendanceEligibility,
  type AttendanceStatus,
  type AttendanceView,
  type MeetingView,
  type WriteResult,
  addAgendaItem,
  adjournMeeting,
  cancelMeeting,
  createActionItem,
  loadAttendanceEligibility,
  recordAttendance,
  rescheduleMeeting,
  submitAmendment,
} from "./idg-api";
import { CareTeamStaffLookupField } from "../../shell/entity-lookups";
import { attendanceDisciplineLabel } from "./idg-disciplines";
import "./idg-lifecycle.css";

const ATTENDANCE_STATUSES = [
  "present",
  "tardy",
  "partial",
  "absent",
  "excused",
] as const satisfies readonly AttendanceStatus[];

const AGENDA_KINDS = [
  "patient_review",
  "carry_forward",
  "administrative_note",
  "family_meeting_setup",
  "other",
] as const satisfies readonly AgendaKind[];

const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

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

/** Shared submit plumbing: one busy flag, one in-place error, close only on success. */
function useCeremony<T>(open: boolean, onDone: (v: T) => void, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // F-081 — retain status + code: both step-up and stale-version refusals can be 412, but their recovery
  // actions are intentionally different.
  const [status, setStatus] = useState<number | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setStatus(null);
    setErrorCode(null);
  }, [open]);
  const run = async (fn: () => Promise<WriteResult<T>>): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus(null);
    setErrorCode(null);
    try {
      const res = await fn();
      setBusy(false);
      if (!res.ok) {
        setError(res.message);
        setStatus(res.status);
        setErrorCode(res.code);
        return;
      }
      onDone(res.value);
      onClose();
    } catch {
      setBusy(false);
      setError("The network request did not complete. Check your connection and try again.");
    }
  };
  return { busy, error, status, errorCode, run };
}

// ── §2.7 attendance check-in ───────────────────────────────────────────────────────────────────────────

export interface AttendanceModalProps {
  readonly open: boolean;
  readonly meetingId: string;
  readonly onClose: () => void;
  readonly onRecorded: (row: AttendanceView) => void;
  /** The org's staff, for a coordinator's "who is checking in" picker (id + display label). Empty => a raw id field. */
  readonly members?: readonly { readonly id: string; readonly label: string }[];
  /** The signed-in caller's membership id (the picker's default subject). */
  readonly callerMembershipId?: string | null;
}

/**
 * ATTENDANCE TRUST (M14 0286). The roster is what §4.7's `quorate_decision` counts and what the per-discipline note
 * authorization trusts, so the discipline is no longer typed: the SERVER says which disciplines the subject's real roles
 * confer (`GET .../attendance-eligibility`) and this modal offers only those. A non-coordinator checks THEMSELF in; a
 * coordinator picks the member and, for a discipline that member's roles do not confer, must tick an explicit
 * attestation (recorded, flagged "Attested by coordinator", never for themself). The server re-validates all of it.
 */
export function AttendanceModal({
  open,
  meetingId,
  onClose,
  onRecorded,
  members = [],
  callerMembershipId = null,
}: AttendanceModalProps): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<AttendanceView>(open, onRecorded, onClose);
  const [membershipId, setMembershipId] = useState("");
  const [discipline, setDiscipline] = useState<string>("");
  const [status, setStatus] = useState<AttendanceStatus>("present");
  const [attest, setAttest] = useState(false);
  const [self, setSelf] = useState<AttendanceEligibility | null>(null);
  const [subject, setSubject] = useState<AttendanceEligibility | null>(null);
  const [eligibilityError, setEligibilityError] = useState<string | null>(null);

  // The caller's own eligibility (also reveals whether they are a coordinator) — once per open.
  useEffect(() => {
    if (!open) return;
    setMembershipId("");
    setDiscipline("");
    setStatus("present");
    setAttest(false);
    setSelf(null);
    setSubject(null);
    setEligibilityError(null);
    let active = true;
    void loadAttendanceEligibility(client, meetingId).then((res) => {
      if (!active) return;
      if (!res.ok) {
        setEligibilityError(res.message);
        return;
      }
      setSelf(res.value);
      setSubject(res.value);
      setMembershipId(res.value.membershipId);
    });
    return () => {
      active = false;
    };
  }, [open, client, meetingId]);

  const isCoordinator = self?.isCoordinator === true;
  const callerId = self?.membershipId ?? callerMembershipId;
  const isSelf = membershipId === "" || membershipId === callerId;

  // A coordinator re-asks the server about whoever they picked (the caller's own answer is already in hand).
  useEffect(() => {
    if (!open || !isCoordinator || membershipId === "" || self === null) return;
    if (membershipId === self.membershipId) {
      setSubject(self);
      return;
    }
    let active = true;
    setSubject(null);
    setEligibilityError(null);
    void loadAttendanceEligibility(client, meetingId, membershipId).then((res) => {
      if (!active) return;
      if (!res.ok) {
        setEligibilityError(res.message);
        return;
      }
      setSubject(res.value);
    });
    return () => {
      active = false;
    };
  }, [open, isCoordinator, membershipId, self, client, meetingId]);

  const offered: readonly string[] =
    subject === null
      ? []
      : attest && !isSelf
        ? subject.attestableDisciplines
        : subject.heldDisciplines;
  // Keep the selection inside what is currently offered (first option by default).
  useEffect(() => {
    if (offered.length === 0) {
      if (discipline !== "") setDiscipline("");
    } else if (!offered.includes(discipline)) {
      setDiscipline(offered[0] ?? "");
    }
  }, [offered, discipline]);

  if (!open) return null;

  const held = subject?.heldDisciplines ?? [];
  const attesting = attest && !isSelf && discipline !== "" && !held.includes(discipline);
  const canSubmit = !busy && subject !== null && discipline !== "" && membershipId.trim() !== "";

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Check in an attendee"
      width="28rem"
    >
      <div style={shell}>
        <h2 style={title}>{isCoordinator ? "Check in an attendee" : "Check yourself in"}</h2>
        {isCoordinator ? (
          members.length > 0 ? (
            <SelectField
              label="Attendee"
              value={membershipId}
              onChange={(e) => {
                setMembershipId(e.target.value);
                setAttest(false);
              }}
              options={members.map((m) => ({
                value: m.id,
                label: m.id === callerId ? `${m.label} (you)` : m.label,
              }))}
            />
          ) : (
            <TextField
              label="Membership id"
              value={membershipId}
              onChange={(e) => {
                setMembershipId(e.target.value);
                setAttest(false);
              }}
            />
          )
        ) : null}
        <SelectField
          label="Discipline"
          value={discipline}
          onChange={(e) => setDiscipline(e.target.value)}
          options={
            offered.length > 0
              ? offered.map((d) => ({ value: d, label: attendanceDisciplineLabel(d) }))
              : [{ value: "", label: subject === null ? "Loading…" : "No discipline available" }]
          }
        />
        {subject !== null && held.length === 0 ? (
          <p style={meta}>
            {isSelf
              ? "None of your roles carries an IDG discipline, so you cannot check in as one. Ask the meeting coordinator."
              : "This member's roles carry no IDG discipline. A coordinator may attest one below."}
          </p>
        ) : null}
        {isCoordinator && !isSelf ? (
          <label
            style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", fontSize: "0.8rem" }}
          >
            <input
              type="checkbox"
              checked={attest}
              onChange={(e) => setAttest(e.target.checked)}
              aria-label="Attest a discipline this member does not hold"
            />
            <span>
              Attest a discipline this member does not hold. It is recorded under your name and
              shown on the roster as "Attested by coordinator".
            </span>
          </label>
        ) : null}
        <SelectField
          label="Participation"
          value={status}
          onChange={(e) => setStatus(e.target.value as AttendanceStatus)}
          options={ATTENDANCE_STATUSES.map((s) => ({ value: s, label: humanize(s) }))}
        />
        <p style={meta}>
          The roster is what §4.7's `quorate_decision` counts. The server checks the discipline
          against the attendee's real roles; recording an attendee never grants them anything.
        </p>
        {eligibilityError || error ? (
          <p role="alert" style={errorText}>
            {error ?? eligibilityError}
          </p>
        ) : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              run(() =>
                recordAttendance(client, meetingId, {
                  membershipId,
                  discipline,
                  status,
                  ...(attesting ? { coordinatorAttested: true } : {}),
                }),
              )
            }
            disabled={!canSubmit}
          >
            {busy ? "Checking in…" : "Check in"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── §2.7 agenda ────────────────────────────────────────────────────────────────────────────────────────

export interface AgendaModalProps {
  readonly open: boolean;
  readonly meetingId: string;
  readonly patients: readonly { readonly id: string; readonly label: string }[];
  readonly onClose: () => void;
  readonly onAdded: (row: AgendaItemView) => void;
}

export function AgendaModal({
  open,
  meetingId,
  patients,
  onClose,
  onAdded,
}: AgendaModalProps): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<AgendaItemView>(open, onAdded, onClose);
  const [kind, setKind] = useState<AgendaKind>("patient_review");
  const [patientId, setPatientId] = useState("");

  useEffect(() => {
    if (!open) return;
    setKind("patient_review");
    setPatientId(patients.length === 1 ? (patients[0]?.id ?? "") : "");
  }, [open, patients]);

  if (!open) return null;

  const needsPatient = kind === "patient_review" || kind === "carry_forward";

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Add an agenda item"
      width="28rem"
    >
      <div style={shell}>
        <h2 style={title}>Add an agenda item</h2>
        <SelectField
          label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as AgendaKind)}
          options={AGENDA_KINDS.map((k) => ({ value: k, label: humanize(k) }))}
        />
        {needsPatient ? (
          <SelectField
            label="Patient"
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
            options={[
              { value: "", label: "Select a patient…" },
              ...patients.map((p) => ({ value: p.id, label: p.label })),
            ]}
          />
        ) : null}
        <p style={meta}>
          The agenda is append-only: the server has no delete grant and no tombstone column for it,
          so there is no Remove control here rather than one that reports a removal that did not
          happen.
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
            onClick={() =>
              run(() =>
                addAgendaItem(client, meetingId, {
                  kind,
                  ...(needsPatient && patientId !== "" ? { patientId } : {}),
                }),
              )
            }
            disabled={busy || (needsPatient && patientId === "")}
          >
            {busy ? "Adding…" : "Add to agenda"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── D8 action item ─────────────────────────────────────────────────────────────────────────────────────

export interface ActionItemModalProps {
  readonly open: boolean;
  readonly meetingId: string;
  readonly patients: readonly { readonly id: string; readonly label: string }[];
  /** Prefilled when the item is raised from a decision row, so the follow-up carries its provenance. */
  readonly decisionId?: string | null;
  readonly onClose: () => void;
  readonly onCreated: (row: ActionItemView) => void;
}

export function ActionItemModal({
  open,
  meetingId,
  patients,
  decisionId,
  onClose,
  onCreated,
}: ActionItemModalProps): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<ActionItemView>(open, onCreated, onClose);
  const [assignee, setAssignee] = useState("");
  const [assigneeLabel, setAssigneeLabel] = useState("");
  const [patientId, setPatientId] = useState("");
  const [dueDate, setDueDate] = useState("");

  useEffect(() => {
    if (!open) return;
    setAssignee("");
    setAssigneeLabel("");
    setPatientId(patients.length === 1 ? (patients[0]?.id ?? "") : "");
    // A week out — the D8 default a coordinator overrides rather than types from scratch.
    const d = new Date();
    d.setDate(d.getDate() + 7);
    setDueDate(d.toISOString().slice(0, 10));
  }, [open, patients]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Assign an action item"
      width="28rem"
    >
      <div style={shell}>
        <h2 style={title}>Assign an action item</h2>
        <CareTeamStaffLookupField
          label="Assign to"
          value={assignee}
          valueLabel={assigneeLabel}
          appearance="modal"
          onChange={(value, option) => {
            setAssignee(value);
            setAssigneeLabel(option?.searchLabel ?? "");
          }}
        />
        <SelectField
          label="Patient (optional)"
          value={patientId}
          onChange={(e) => setPatientId(e.target.value)}
          options={[
            { value: "", label: "No patient" },
            ...patients.map((p) => ({ value: p.id, label: p.label })),
          ]}
        />
        <TextField label="Due" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
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
            onClick={() =>
              run(() =>
                createActionItem(client, meetingId, {
                  assignedToMembershipId: assignee.trim(),
                  patientId: patientId === "" ? null : patientId,
                  dueDate: new Date(`${dueDate}T00:00:00.000Z`).toISOString(),
                  ...(decisionId ? { decisionId } : {}),
                }),
              )
            }
            disabled={busy || assignee.trim() === "" || dueDate === ""}
          >
            {busy ? "Assigning…" : "Assign"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── §2.2 lifecycle: adjourn / cancel / reschedule ──────────────────────────────────────────────────────

export type LifecycleAction = "adjourn" | "cancel" | "reschedule";

export interface LifecycleModalProps {
  readonly open: boolean;
  readonly action: LifecycleAction;
  readonly meetingId: string;
  /** Rendered in the adjourn dialog so the coordinator sees what the commit point is about to commit. */
  readonly pending?: {
    readonly scheduledStart?: string;
    readonly decisions: number;
    readonly patients: number;
    readonly quorumMet?: boolean | null;
    readonly packetCount?: number | null;
  };
  readonly onClose: () => void;
  readonly onDone: (meeting: MeetingView) => void;
}

export function LifecycleModal({
  open,
  action,
  meetingId,
  pending,
  onClose,
  onDone,
}: LifecycleModalProps): JSX.Element | null {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { busy, error, status, errorCode, run } = useCeremony<MeetingView>(open, onDone, onClose);
  const [reason, setReason] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReason("");
    setStart("");
    setEnd("");
    setConfirmed(false);
  }, [open]);

  if (!open) return null;

  const label =
    action === "adjourn"
      ? "Adjourn the meeting"
      : action === "cancel"
        ? "Cancel the meeting"
        : "Reschedule the meeting";
  const blocked =
    (action !== "adjourn" && reason.trim().length === 0) ||
    (action === "reschedule" && (start === "" || end === "")) ||
    (action === "adjourn" && !confirmed);

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={label}
      width="30rem"
      accent={action === "cancel" ? "alert" : "primary"}
    >
      <div style={shell}>
        <h2 style={title}>{label}</h2>

        {action === "adjourn" ? (
          <>
            <div className="wx-idg-finalize-summary" aria-label="Finalization summary">
              <div>
                <span>Meeting</span>
                <strong>
                  {pending?.scheduledStart
                    ? new Date(pending.scheduledStart).toLocaleString("en-US", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })
                    : "Date unavailable"}
                </strong>
              </div>
              <div>
                <span>Patients</span>
                <strong>{pending ? pending.patients : "Unavailable"}</strong>
              </div>
              <div>
                <span>Open decisions</span>
                <strong>{pending ? pending.decisions : "Unavailable"}</strong>
              </div>
              <div>
                <span>Quorum</span>
                <strong>
                  {pending?.quorumMet === true
                    ? "Met"
                    : pending?.quorumMet === false
                      ? "Not met"
                      : "Unavailable"}
                </strong>
              </div>
              <div>
                <span>Packets</span>
                <strong>
                  {pending?.packetCount == null
                    ? "Unavailable"
                    : `${pending.packetCount} available`}
                </strong>
              </div>
            </div>
            <p style={meta}>
              Finalizing emits the open decisions, freezes the packets, updates each included
              patient's review date, and signs an immutable minutes snapshot. Historical attendance,
              agenda and decisions cannot then be edited through ordinary workflows.
            </p>
            <p style={meta}>
              It requires a fresh re-authentication (D13). If your session has gone stale the server
              refuses and says so; re-authenticate and adjourn again.
            </p>
            <label className="wx-idg-finalize-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>I understand that this finalizes the meeting record and minutes.</span>
            </label>
          </>
        ) : (
          <TextAreaField
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
          />
        )}

        {action === "reschedule" ? (
          <>
            <TextField label="New start" value={start} onChange={(e) => setStart(e.target.value)} />
            <TextField label="New end" value={end} onChange={(e) => setEnd(e.target.value)} />
            <p style={meta}>
              The server refuses a move that pushes an included patient past their 15-day review
              floor unless you hold the override permission and a fresh step-up (GAP-020/091).
            </p>
          </>
        ) : null}

        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}

        <div style={footer}>
          {/*
            F-081 — the way to DO what the refusal asks. The dialog told a coordinator to
            "re-authenticate and adjourn again" and offered no route to it: `/step-up` is a chromeless
            screen with no nav entry, reached only by a redirect, and M14 was the one module that
            described the requirement without performing that redirect (M6/M8/M23/M39 all route a
            step-up-shaped refusal through their own `authFailureRedirect`). So the instruction was
            unfollowable and the D13 commit point had no path through it from the UI at all.

            Offered only on the 412, and only after one has actually happened: a permanent "step up"
            button next to every commit point would train people to re-authenticate before they are
            asked, which is the opposite of what a freshness window is for.
          */}
          {errorCode === "STEP_UP_REQUIRED" ? (
            <Button
              tone="secondary"
              onClick={() =>
                navigate(
                  `/step-up?returnTo=${encodeURIComponent(location.pathname + location.search)}`,
                )
              }
            >
              Re-authenticate
            </Button>
          ) : null}
          {(status === 409 || (status === 412 && errorCode !== "STEP_UP_REQUIRED")) ? (
            <Button tone="secondary" onClick={() => navigate(0)} disabled={busy}>
              Refresh meeting
            </Button>
          ) : null}
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone={action === "cancel" ? "danger" : "primary"}
            onClick={() =>
              run(() =>
                action === "adjourn"
                  ? adjournMeeting(client, meetingId)
                  : action === "cancel"
                    ? cancelMeeting(client, meetingId, reason.trim())
                    : rescheduleMeeting(client, meetingId, {
                        reason: reason.trim(),
                        newScheduledStart: new Date(start).toISOString(),
                        newScheduledEnd: new Date(end).toISOString(),
                      }),
              )
            }
            disabled={busy || blocked}
          >
            {busy
              ? "Working…"
              : action === "adjourn"
                ? "Finalize & Adjourn"
                : action === "cancel"
                  ? "Cancel meeting"
                  : "Reschedule"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── §7.8 minutes amendment ─────────────────────────────────────────────────────────────────────────────

export interface AmendmentModalProps {
  readonly open: boolean;
  readonly minutesId: string;
  readonly onClose: () => void;
  readonly onSubmitted: (receipt: { amendmentId: string; minutesId: string }) => void;
}

export function AmendmentModal({
  open,
  minutesId,
  onClose,
  onSubmitted,
}: AmendmentModalProps): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<{ amendmentId: string; minutesId: string }>(
    open,
    onSubmitted,
    onClose,
  );
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setReason("");
  }, [open]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Request an amendment"
      width="30rem"
    >
      <div style={shell}>
        <h2 style={title}>Request an amendment</h2>
        <p style={meta}>
          Final minutes are immutable — the write-audit trigger refuses a content update. This files
          a REQUEST against them (the §164.526 pattern), leaving the original record intact.
        </p>
        <TextAreaField
          label="What should be corrected, and why"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
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
            onClick={() => run(() => submitAmendment(client, minutesId, reason.trim()))}
            disabled={busy || reason.trim().length === 0}
          >
            {busy ? "Submitting…" : "Submit request"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
