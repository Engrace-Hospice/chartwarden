import { Button, Modal, SelectField, TextAreaField, TextField, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/17-scheduling — the §2.2 visit ceremonies (#91).
//
// A visit is the unit of hospice care delivery: it is what a clinician travels to, what an encounter
// documents, what EVV brackets, and what a claim's service line is built from. `apps/web/src/modules/
// 17-scheduling` had eight read screens and no way to schedule one, move one, reassign one or call one
// off.
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES (ADR-0030).
//
//   • §4.7 THE D8 PRE-SCHEDULE GATE. Whether the assigned clinician may take this visit purpose is
//     resolved from their active M3 role grants ∩ the scheduling vocabulary, with M17's own credential
//     read deciding whether the licence is currently active. The assignee picker offers the ACTIVE
//     ROSTER, not an eligibility list: filtering here would be a second, divergent implementation of
//     that rule, and `discipline-derivation.test.ts` exists because the repo has had that problem.
//   • THE CONFLICT RULES — double-booking, availability, approved time off. A move that collides is a
//     409 whose message names what it collided with.
//   • §2.2 the lifecycle, including that a RESCHEDULE closes the original visit and opens a new one.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import {
  type CancelReasonCode,
  type MembershipOption,
  type PatientAddressOption,
  type VisitPurpose,
  type VisitSetting,
  type VisitView,
  type WriteResult,
  cancelVisit,
  createVisit,
  markNoShow,
  reassignVisit,
  rescheduleVisit,
} from "./scheduling-api";

const PURPOSES = [
  ["routine_visit", "Routine visit"],
  ["prn", "PRN"],
  ["aide_poc", "Aide plan of care"],
  ["msw_assessment", "MSW assessment"],
  ["msw_followup", "MSW follow-up"],
  ["chaplain_assessment", "Chaplain assessment"],
  ["chaplain_visit", "Chaplain visit"],
  ["volunteer_visit", "Volunteer visit"],
  ["f2f", "Face-to-face encounter"],
  ["recert", "Recertification"],
] as const satisfies readonly (readonly [VisitPurpose, string])[];

const SETTINGS = [
  ["patient_home", "Patient home"],
  ["facility", "Facility"],
  ["inpatient_unit", "Inpatient unit"],
  ["telephonic", "Telephonic"],
] as const satisfies readonly (readonly [VisitSetting, string])[];

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

// ── schedule a visit ───────────────────────────────────────────────────────────────────────────────────

export interface ScheduleVisitModalProps {
  readonly open: boolean;
  readonly patientId: string;
  readonly admissionId: string;
  readonly addresses: readonly PatientAddressOption[];
  readonly memberships: readonly MembershipOption[];
  readonly onClose: () => void;
  readonly onScheduled: (visit: VisitView) => void;
}

export function ScheduleVisitModal({
  open,
  patientId,
  admissionId,
  addresses,
  memberships,
  onClose,
  onScheduled,
}: ScheduleVisitModalProps): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<VisitView>(open, onScheduled, onClose);
  const [purpose, setPurpose] = useState<VisitPurpose>("routine_visit");
  const [setting, setSetting] = useState<VisitSetting>("patient_home");
  const [assignee, setAssignee] = useState("");
  const [addressId, setAddressId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  useEffect(() => {
    if (!open) return;
    setPurpose("routine_visit");
    setSetting("patient_home");
    setAssignee(memberships.length === 1 ? (memberships[0]?.id ?? "") : "");
    setAddressId(addresses.length === 1 ? (addresses[0]?.id ?? "") : "");
    setStart("");
    setEnd("");
  }, [open, memberships, addresses]);

  if (!open) return null;

  // A home visit needs somewhere to go. Every other setting is sited by the facility or the unit, so the
  // server takes `patientAddressId: null` for them.
  const needsAddress = setting === "patient_home";
  const blocked =
    assignee === "" || start === "" || end === "" || (needsAddress && addressId === "");

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Schedule a visit"
      width="32rem"
    >
      <div style={shell}>
        <h2 style={title}>Schedule a visit</h2>
        <div style={row2}>
          <SelectField
            label="Purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as VisitPurpose)}
            options={PURPOSES.map(([value, label]) => ({ value, label }))}
          />
          <SelectField
            label="Setting"
            value={setting}
            onChange={(e) => setSetting(e.target.value as VisitSetting)}
            options={SETTINGS.map(([value, label]) => ({ value, label }))}
          />
        </div>
        <SelectField
          label="Assign to"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          options={[
            { value: "", label: "Select a clinician…" },
            ...memberships.map((m) => ({ value: m.id, label: m.label })),
          ]}
        />
        <p style={meta}>
          This is the org's active roster, not a list of who is eligible. The server applies the
          §4.7 D8 pre-schedule gate — the clinician's disciplines and whether their licence is
          current — and refuses an assignment it does not cover.
        </p>
        {needsAddress ? (
          addresses.length === 0 ? (
            <p style={meta}>
              This patient has no recorded address, so a home visit cannot be sited. Add one on the
              patient record, or choose another setting.
            </p>
          ) : (
            <SelectField
              label="Address"
              value={addressId}
              onChange={(e) => setAddressId(e.target.value)}
              options={[
                { value: "", label: "Select an address…" },
                ...addresses.map((a) => ({ value: a.id, label: a.label })),
              ]}
            />
          )
        ) : null}
        <div style={row2}>
          <TextField label="Starts" value={start} onChange={(e) => setStart(e.target.value)} />
          <TextField label="Ends" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
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
                createVisit(client, {
                  patientId,
                  admissionId,
                  patientAddressId: needsAddress ? addressId : null,
                  externalFacilityId: null,
                  assignedMembershipId: assignee,
                  visitPurpose: purpose,
                  visitSetting: setting,
                  scheduledStartedAt: new Date(start).toISOString(),
                  scheduledEndedAt: new Date(end).toISOString(),
                }),
              )
            }
            disabled={busy || blocked}
          >
            {busy ? "Scheduling…" : "Schedule"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── the per-visit ceremonies ───────────────────────────────────────────────────────────────────────────

export type VisitAction = "reschedule" | "reassign" | "cancel" | "no-show";

const CANCEL_CODES = [
  ["patient_request", "Patient request"],
  ["clinician_unavailable", "Clinician unavailable"],
  ["patient_hospitalized", "Patient hospitalised"],
  ["patient_died", "Patient died"],
  ["weather_or_safety", "Weather or safety"],
  ["duplicate", "Duplicate"],
  ["other", "Other"],
] as const;

export interface VisitActionModalProps {
  readonly open: boolean;
  readonly action: VisitAction;
  readonly visitId: string;
  readonly memberships: readonly MembershipOption[];
  readonly onClose: () => void;
  readonly onDone: () => void;
}

export function VisitActionModal({
  open,
  action,
  visitId,
  memberships,
  onClose,
  onDone,
}: VisitActionModalProps): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<unknown>(open, onDone, onClose);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [reasonCode, setReasonCode] = useState<string>(CANCEL_CODES[0][0]);
  const [assignee, setAssignee] = useState("");

  useEffect(() => {
    if (!open) return;
    setStart("");
    setEnd("");
    setReason("");
    setReasonCode(CANCEL_CODES[0][0]);
    setAssignee("");
  }, [open]);

  if (!open) return null;

  const label =
    action === "reschedule"
      ? "Reschedule visit"
      : action === "reassign"
        ? "Reassign visit"
        : action === "cancel"
          ? "Cancel visit"
          : "Record a no-show";

  const blocked =
    action === "reschedule"
      ? start === "" || end === "" || reason.trim() === ""
      : action === "reassign"
        ? assignee === ""
        : reason.trim() === "";

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

        {action === "reschedule" ? (
          <>
            <div style={row2}>
              <TextField
                label="New start"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
              <TextField label="New end" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
            <p style={meta}>
              Rescheduling closes this visit and opens a NEW one linked to it. Anything already
              pointing at this visit — a draft note, an EVV bracket — stays with the original.
            </p>
          </>
        ) : null}

        {action === "reassign" ? (
          <>
            <SelectField
              label="Reassign to"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              options={[
                { value: "", label: "Select a clinician…" },
                ...memberships.map((m) => ({ value: m.id, label: m.label })),
              ]}
            />
            <p style={meta}>
              The §4.7 D8 pre-schedule gate runs again against the new assignee — a discipline or
              licence that does not cover this purpose is refused by the server.
            </p>
          </>
        ) : null}

        {action === "cancel" ? (
          <SelectField
            label="Reason code"
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
            options={CANCEL_CODES.map(([value, l]) => ({ value, label: l }))}
          />
        ) : null}

        {action !== "reassign" ? (
          <TextAreaField
            label={action === "no-show" ? "What happened" : "Reason"}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
          />
        ) : null}

        {action === "no-show" ? (
          <p style={meta}>
            A no-show is not a cancellation: the clinician attended and the patient did not receive
            the visit. The §5.1 metrics count them separately, and only one of them reflects on
            scheduling.
          </p>
        ) : null}

        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}

        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button
            tone={action === "cancel" ? "danger" : "primary"}
            onClick={() =>
              run(() =>
                action === "reschedule"
                  ? rescheduleVisit(client, visitId, {
                      newScheduledStartedAt: new Date(start).toISOString(),
                      newScheduledEndedAt: new Date(end).toISOString(),
                      reason: reason.trim(),
                    })
                  : action === "reassign"
                    ? reassignVisit(client, visitId, assignee)
                    : action === "cancel"
                      ? cancelVisit(client, visitId, {
                          reason: reason.trim(),
                          reasonCode: reasonCode as CancelReasonCode,
                        })
                      : markNoShow(client, visitId, {
                          reason: reason.trim(),
                        } as Parameters<typeof markNoShow>[2]),
              )
            }
            disabled={busy || blocked}
          >
            {busy
              ? "Working…"
              : action === "reschedule"
                ? "Reschedule"
                : action === "reassign"
                  ? "Reassign"
                  : action === "cancel"
                    ? "Cancel visit"
                    : "Record no-show"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
