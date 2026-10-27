import {
  Button,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/18-evv — the M18 write ceremonies (#91).
//
// Four queues that a human has to work for a Medicaid EVV claim to survive, none of which had a control:
// the device roster (capture is refused without an APPROVED device, D8), the missing-EVV resolution
// backlog (an OPEN row is what blocks the visit downstream), the aggregator submission queue (a state
// rejection is fixed and resubmitted by an operator), and the geofence policy (what decides whether a
// capture reads `pass` or `outside_geofence` at all).
//
// WHAT THE SERVER OWNS, WHICH NOTHING HERE RE-DECIDES (ADR-0030 — no frontend authz).
//
//   • §2.2.4 D6 — who may attest, and until when. The 24h self-attest window, the 7d override window and
//     "are you the assigned clinician" are the machine's. This surface STATES them, so someone typing a
//     50-word attestation learns the window closed before they type it rather than after; it never
//     decides them, and it does not disable a control on its own reading of a clock.
//   • §2.2.2 tighten-only — the tenant may narrow below the 200m/50m platform floor and never loosen
//     past it. The form names the floor beside each field. The server answers 422.
//   • §2.3 — the supervisor override requires fresh M2 step-up, resolved from the session. Nothing here
//     asserts it; a 403 is the answer and it says what to do about it.
//
// The reason boxes count characters against the domain floor because a reason is the whole artefact
// here: the row it lands on is the record that a visit with no electronic verification was nonetheless
// delivered, and it is what an auditor reads. Until #165 every one of these was measured at the edge and
// then dropped before the write — so the count is against a floor that now has somewhere to land.
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  type AggregatorSubmissionView,
  type DeviceView,
  type GeofencePolicyView,
  type MissingResolutionView,
  PLATFORM_GEOFENCE_FLOOR,
  type PatientAddressOption,
  type PatientOption,
  REASON_MIN,
  SELF_ATTEST_WINDOW_HOURS,
  SUPERVISOR_OVERRIDE_WINDOW_DAYS,
  type WriteResult,
  approveDevice,
  cancelSubmission,
  clinicianAttestResolution,
  createPerAddressOverride,
  editTenantPolicy,
  loadPatientAddresses,
  rejectDevice,
  resubmitSubmission,
  retireDevice,
  searchPatients,
  supervisorOverrideResolution,
  suspendDevice,
} from "./evv-api";

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

/** "23 more characters" — counted against the domain floor, never used to disable the submit. */
function shortfall(value: string, min: number): number {
  return Math.max(0, min - value.trim().length);
}

// ── device lifecycle ───────────────────────────────────────────────────────────────────────────────────

/** The four D8 transitions this surface offers. Self-registration is the mobile flow (§5.2). */
export type DeviceAction = "approve" | "reject" | "suspend" | "retire";

const DEVICE_COPY: Record<
  DeviceAction,
  { readonly heading: string; readonly submit: string; readonly note: string }
> = {
  approve: {
    heading: "Approve this device",
    submit: "Approve device",
    // Worth stating: approval is not a formality, it is what makes the handset able to capture at all.
    note: "An approved device is what EVV capture requires — until this, every check-in from this handset is refused (D8).",
  },
  reject: {
    heading: "Reject this device",
    submit: "Reject device",
    note: "The clinician will need to register again from a different handset before they can capture.",
  },
  suspend: {
    heading: "Suspend this device",
    submit: "Suspend device",
    note: "Suspension stops capture immediately. Use it for a lost or compromised handset.",
  },
  retire: {
    heading: "Retire this device",
    submit: "Retire device",
    note: "Retirement is the end of this device's life on the platform. A reason is optional here.",
  },
};

export interface DeviceActionModalProps {
  readonly open: boolean;
  readonly action: DeviceAction;
  readonly deviceId: string;
  readonly modelDescription: string;
  readonly onClose: () => void;
  readonly onDone: (device: DeviceView) => void;
}

export function DeviceActionModal({
  open,
  action,
  deviceId,
  modelDescription,
  onClose,
  onDone,
}: DeviceActionModalProps): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<DeviceView>(open, onDone, onClose);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  if (!open) return null;
  const copy = DEVICE_COPY[action];
  // Approve takes no body; retire's reason is optional on the wire and has no column to land in
  // (#165 — `evv_device` carries `denial_reason` and `suspend_reason` and nothing for retirement).
  const needsReason = action === "reject" || action === "suspend";

  return (
    <Modal open={open} onClose={onClose} ariaLabel={copy.heading} role="alertdialog">
      <div style={shell}>
        <h2 id="evv-device-action-heading" style={title}>
          {copy.heading}
        </h2>
        <p style={meta}>
          {modelDescription} · {deviceId.slice(0, 8)}
        </p>
        <p style={meta}>{copy.note}</p>
        {action !== "approve" ? (
          <TextAreaField
            label={needsReason ? "Reason" : "Reason (optional)"}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            required={needsReason}
          />
        ) : null}
        {error ? <p style={errorText}>{error}</p> : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              run(() => {
                if (action === "approve") return approveDevice(client, deviceId);
                if (action === "reject") return rejectDevice(client, deviceId, reason);
                if (action === "suspend") return suspendDevice(client, deviceId, reason);
                return retireDevice(client, deviceId, reason);
              })
            }
            disabled={busy || (needsReason && reason.trim().length < REASON_MIN.free)}
          >
            {copy.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── missing-EVV resolution (§2.2.4 D6) ─────────────────────────────────────────────────────────────────

/** The two human closes. `closed_visit_voided` / `…_documented_at_encounter` / `…_system_checkout_received`
 *  are driven by M17/M8 and the check-out consumer, not by anyone working this queue. */
export type ResolutionAction = "clinician_attest" | "supervisor_override";

export interface ResolutionActionModalProps {
  readonly open: boolean;
  readonly action: ResolutionAction;
  readonly resolutionId: string;
  readonly visitId: string;
  readonly kind: string;
  readonly onClose: () => void;
  readonly onResolved: (row: MissingResolutionView) => void;
}

export function ResolutionActionModal({
  open,
  action,
  resolutionId,
  visitId,
  kind,
  onClose,
  onResolved,
}: ResolutionActionModalProps): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<MissingResolutionView>(open, onResolved, onClose);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  if (!open) return null;
  const isSelf = action === "clinician_attest";
  const min = isSelf ? REASON_MIN.clinicianAttest : REASON_MIN.supervisorOverride;
  const missing = shortfall(reason, min);

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={isSelf ? "Attest to this visit" : "Override as supervisor"}
      role="alertdialog"
    >
      <div style={shell}>
        <h2 id="evv-resolution-heading" style={title}>
          {isSelf ? "Attest to this visit" : "Override as supervisor"}
        </h2>
        <p style={meta}>
          {kind.replace(/_/g, " ")} · visit {visitId.slice(0, 8)}
        </p>
        <p style={meta}>
          {isSelf
            ? `You are recording that you delivered this visit even though the electronic capture did not arrive. Self-attestation is open to the assigned clinician for ${SELF_ATTEST_WINDOW_HOURS} hours after check-in (§7.3) — after that, a supervisor override is the route.`
            : `A supervisor override closes this row on the clinician's behalf, within ${SUPERVISOR_OVERRIDE_WINDOW_DAYS} days of the visit (§7.4). It requires a recent re-authentication.`}
        </p>
        <TextAreaField
          label="What happened, and how do you know the visit occurred?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={5}
          required
        />
        <p style={meta}>
          {missing > 0
            ? `${missing} more character${missing === 1 ? "" : "s"} — this attestation requires at least ${min}.`
            : `${reason.trim().length} characters. This text is the record an auditor reads.`}
        </p>
        {error ? <p style={errorText}>{error}</p> : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              run(() =>
                isSelf
                  ? clinicianAttestResolution(client, resolutionId, reason)
                  : supervisorOverrideResolution(client, resolutionId, reason),
              )
            }
            disabled={busy || missing > 0}
          >
            {isSelf ? "Record attestation" : "Record override"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── aggregator submissions (§2.2.5 D7) ─────────────────────────────────────────────────────────────────

export type SubmissionAction = "resubmit" | "cancel";

export interface SubmissionActionModalProps {
  readonly open: boolean;
  readonly action: SubmissionAction;
  readonly submissionId: string;
  readonly stateCode: string;
  readonly attemptCount: number;
  readonly onClose: () => void;
  readonly onDone: (row: AggregatorSubmissionView) => void;
}

export function SubmissionActionModal({
  open,
  action,
  submissionId,
  stateCode,
  attemptCount,
  onClose,
  onDone,
}: SubmissionActionModalProps): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<AggregatorSubmissionView>(open, onDone, onClose);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  if (!open) return null;
  const isResubmit = action === "resubmit";

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={isResubmit ? "Resubmit to the state aggregator" : "Cancel this submission"}
      role="alertdialog"
    >
      <div style={shell}>
        <h2 id="evv-submission-heading" style={title}>
          {isResubmit ? "Resubmit to the state aggregator" : "Cancel this submission"}
        </h2>
        <p style={meta}>
          {stateCode} · attempt {attemptCount} · {submissionId.slice(0, 8)}
        </p>
        <p style={meta}>
          {isResubmit
            ? "Resubmission queues this visit for the state again and increments the attempt count. Fix whatever the rejection named first — a resubmit of unchanged data is rejected the same way."
            : "Cancelling stops this visit ever reaching the state. Use it when the visit was voided, not when a submission failed — a failure is resubmitted."}
        </p>
        <TextAreaField
          label={isResubmit ? "What changed (optional)" : "Why is this being cancelled?"}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          required={!isResubmit}
        />
        {error ? <p style={errorText}>{error}</p> : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button
            onClick={() =>
              run(() =>
                isResubmit
                  ? resubmitSubmission(client, submissionId, reason)
                  : cancelSubmission(client, submissionId, reason),
              )
            }
            disabled={busy || (!isResubmit && reason.trim().length < REASON_MIN.free)}
          >
            {isResubmit ? "Queue resubmission" : "Cancel submission"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── geofence policy (§2.2.2 D3) ────────────────────────────────────────────────────────────────────────

export interface TenantPolicyModalProps {
  readonly open: boolean;
  readonly radiusM: number;
  readonly maxAccuracyM: number;
  readonly onClose: () => void;
  readonly onSaved: (policy: GeofencePolicyView) => void;
}

export function TenantPolicyModal({
  open,
  radiusM,
  maxAccuracyM,
  onClose,
  onSaved,
}: TenantPolicyModalProps): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<GeofencePolicyView>(open, onSaved, onClose);
  const [radius, setRadius] = useState(radiusM);
  const [accuracy, setAccuracy] = useState(maxAccuracyM);

  useEffect(() => {
    if (!open) return;
    setRadius(radiusM);
    setAccuracy(maxAccuracyM);
  }, [open, radiusM, maxAccuracyM]);

  if (!open) return null;
  // Stated, not enforced. The server owns tighten-only and answers 422; saying so before the round trip
  // is a courtesy, and the control stays enabled so a floor this build has stale numbers for cannot
  // lock someone out of a legal edit.
  const loosens =
    radius > PLATFORM_GEOFENCE_FLOOR.radiusM || accuracy > PLATFORM_GEOFENCE_FLOOR.maxAccuracyM;

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Tenant geofence policy">
      <div style={shell}>
        <h2 id="evv-tenant-policy-heading" style={title}>
          Tenant geofence policy
        </h2>
        <p style={meta}>
          These decide whether a capture reads inside the geofence or as a breach. The platform
          floor is {PLATFORM_GEOFENCE_FLOOR.radiusM}m radius /{" "}
          {PLATFORM_GEOFENCE_FLOOR.maxAccuracyM}m accuracy; a tenant may tighten below it and never
          loosen past it.
        </p>
        <div style={row2}>
          <TextField
            label="Radius (m)"
            type="number"
            min={50}
            max={1000}
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
          />
          <TextField
            label="Max accuracy (m)"
            type="number"
            min={5}
            max={100}
            value={accuracy}
            onChange={(e) => setAccuracy(Number(e.target.value))}
          />
        </div>
        {loosens ? (
          <p style={meta}>
            That is looser than the platform floor. The server will refuse it — tenant policy is
            tighten-only.
          </p>
        ) : null}
        {error ? <p style={errorText}>{error}</p> : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              run(() => editTenantPolicy(client, { radiusM: radius, maxAccuracyM: accuracy }))
            }
            disabled={busy}
          >
            Save policy
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export interface PerAddressOverrideModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSaved: (policy: GeofencePolicyView) => void;
}

/**
 * A per-address override, reached the same two-step way M17's day view reaches an address: find the
 * patient, then pick among theirs. This screen is org-scoped, so there is no patient in context — and
 * `patientAddressId` is the one input the route cannot do without.
 */
export function PerAddressOverrideModal({
  open,
  onClose,
  onSaved,
}: PerAddressOverrideModalProps): JSX.Element | null {
  const client = useApiClient();
  const { busy, error, run } = useCeremony<GeofencePolicyView>(open, onSaved, onClose);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PatientOption[]>([]);
  const [patientId, setPatientId] = useState("");
  const [addresses, setAddresses] = useState<PatientAddressOption[]>([]);
  const [addressId, setAddressId] = useState("");
  const [radius, setRadius] = useState(120);
  const [accuracy, setAccuracy] = useState(30);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setMatches([]);
    setPatientId("");
    setAddresses([]);
    setAddressId("");
    setRadius(120);
    setAccuracy(30);
    setReason("");
  }, [open]);

  const missing = useMemo(() => shortfall(reason, REASON_MIN.geofenceOverride), [reason]);
  if (!open) return null;

  const choosePatient = async (id: string): Promise<void> => {
    setPatientId(id);
    setAddressId("");
    const rows = await loadPatientAddresses(client, id);
    setAddresses(rows);
    if (rows.length === 1) setAddressId(rows[0]?.id ?? "");
  };

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Per-address geofence override" width="36rem">
      <div style={shell}>
        <h2 id="evv-override-heading" style={title}>
          Per-address geofence override
        </h2>
        <p style={meta}>
          For an address whose real arrival point does not match its geocode — a long driveway, a
          rural parcel, a facility whose entrance is on another street. Without one, every visit
          there records a geofence breach that is not one.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="evv-patient-search" style={meta}>
              Patient
            </label>
            <input
              id="evv-patient-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or MRN..."
              style={{ width: "100%", padding: "0.5rem" }}
            />
          </div>
          <Button
            tone="secondary"
            onClick={async () => setMatches(await searchPatients(client, query))}
            disabled={busy}
          >
            Search
          </Button>
        </div>
        {matches.length > 0 ? (
          <SelectField
            label="Match"
            value={patientId}
            onChange={(e) => void choosePatient(e.target.value)}
            options={[
              { value: "", label: "Select a patient..." },
              ...matches.map((m) => ({ value: m.id, label: m.label })),
            ]}
          />
        ) : null}
        {patientId ? (
          <SelectField
            label="Address"
            value={addressId}
            onChange={(e) => setAddressId(e.target.value)}
            options={[
              { value: "", label: "Select an address..." },
              ...addresses.map((a) => ({ value: a.id, label: a.label })),
            ]}
          />
        ) : null}
        <div style={row2}>
          <TextField
            label="Radius (m)"
            type="number"
            min={50}
            max={1000}
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
          />
          <TextField
            label="Max accuracy (m)"
            type="number"
            min={5}
            max={100}
            value={accuracy}
            onChange={(e) => setAccuracy(Number(e.target.value))}
          />
        </div>
        <TextAreaField
          label="Why does this address need its own geofence?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          required
        />
        <p style={meta}>
          {missing > 0
            ? `${missing} more character${missing === 1 ? "" : "s"} — an override requires at least ${REASON_MIN.geofenceOverride}.`
            : "This reason is retained with the override."}
        </p>
        {error ? <p style={errorText}>{error}</p> : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              run(() =>
                createPerAddressOverride(client, {
                  patientAddressId: addressId,
                  radiusM: radius,
                  maxAccuracyM: accuracy,
                  overrideReason: reason,
                }),
              )
            }
            disabled={busy || !addressId || missing > 0}
          >
            Save override
          </Button>
        </div>
      </div>
    </Modal>
  );
}
