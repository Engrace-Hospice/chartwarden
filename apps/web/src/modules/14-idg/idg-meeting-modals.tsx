import { Button, Modal, SelectField, TextAreaField, TextField, useApiClient } from "@wardenx/ui";
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
  type AttendanceStatus,
  type AttendanceView,
  type MeetingView,
  type WriteResult,
  addAgendaItem,
  adjournMeeting,
  cancelMeeting,
  createActionItem,
  recordAttendance,
  rescheduleMeeting,
  submitAmendment,
} from "./idg-api";

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

/**
 * The four disciplines §2.7's `IDG_REQUIRED_QUORUM` looks for, plus the ones that routinely attend.
 * These are M3 ROLE KEYS. Offering them is not a claim about who may attend — the server decides
 * nothing about attendance from this list; it is the vocabulary the roster records.
 */
const DISCIPLINES = [
  "rn_case_manager",
  "hospice_physician",
  "medical_director",
  "msw",
  "chaplain",
  "np",
  "hospice_aide",
  "bereavement_coordinator",
  "volunteer_coordinator",
] as const;

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
  // F-081 — the refusal's STATUS, not just its copy. 412 is the D13 step-up, and the difference between
  // telling someone to re-authenticate and taking them somewhere they can is the whole of this field.
  const [status, setStatus] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setStatus(null);
  }, [open]);
  const run = async (fn: () => Promise<WriteResult<T>>): Promise<void> => {
    setBusy(true);
    setError(null);
    setStatus(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      setStatus(res.status);
      return;
    }
    onDone(res.value);
    onClose();
  };
  return { busy, error, status, run };
}

// ── §2.7 attendance check-in ───────────────────────────────────────────────────────────────────────────

export interface AttendanceModalProps {
  readonly open: boolean;
  readonly meetingId: string;
  readonly onClose: () => void;
  readonly onRecorded: (row: AttendanceView) => void;
}

export function AttendanceModal({
  open,
  meetingId,
  onClose,
  onRecorded,
}: AttendanceModalProps): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<AttendanceView>(open, onRecorded, onClose);
  const [membershipId, setMembershipId] = useState("");
  const [discipline, setDiscipline] = useState<string>(DISCIPLINES[0]);
  const [status, setStatus] = useState<AttendanceStatus>("present");

  useEffect(() => {
    if (!open) return;
    setMembershipId("");
    setDiscipline(DISCIPLINES[0]);
    setStatus("present");
  }, [open]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Check in an attendee"
      width="28rem"
    >
      <div style={shell}>
        <h2 style={title}>Check in an attendee</h2>
        <TextField
          label="Membership id"
          value={membershipId}
          onChange={(e) => setMembershipId(e.target.value)}
        />
        <SelectField
          label="Discipline"
          value={discipline}
          onChange={(e) => setDiscipline(e.target.value)}
          options={DISCIPLINES.map((d) => ({ value: d, label: humanize(d) }))}
        />
        <SelectField
          label="Participation"
          value={status}
          onChange={(e) => setStatus(e.target.value as AttendanceStatus)}
          options={ATTENDANCE_STATUSES.map((s) => ({ value: s, label: humanize(s) }))}
        />
        <p style={meta}>
          The roster is what §4.7's `quorate_decision` counts. Recording an attendee never grants
          them anything — the server decides quorum from these rows, and refuses a non-quorate
          decision.
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
              run(() => recordAttendance(client, meetingId, { membershipId, discipline, status }))
            }
            disabled={busy || membershipId.trim() === ""}
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
  const [patientId, setPatientId] = useState("");
  const [dueDate, setDueDate] = useState("");

  useEffect(() => {
    if (!open) return;
    setAssignee("");
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
        <TextField
          label="Assign to (membership id)"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
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
  readonly pending?: { readonly decisions: number; readonly patients: number };
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
  const { busy, error, status, run } = useCeremony<MeetingView>(open, onDone, onClose);
  const [reason, setReason] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  useEffect(() => {
    if (!open) return;
    setReason("");
    setStart("");
    setEnd("");
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
    (action === "reschedule" && (start === "" || end === ""));

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
            <p style={meta}>
              Adjourning is the §2.2 commit point. It emits{" "}
              {pending ? `${pending.decisions} open decision(s)` : "every open decision"} to the
              downstream modules, freezes the packets, resets the 15-day review floor for{" "}
              {pending ? `${pending.patients} patient(s)` : "each included patient"} (42 CFR
              418.56(d)), and finalizes the minutes — which are immutable afterwards.
            </p>
            <p style={meta}>
              It requires a fresh re-authentication (D13). If your session has gone stale the server
              refuses and says so; re-authenticate and adjourn again.
            </p>
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
          {status === 412 ? (
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
                ? "Adjourn"
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
