import {
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/15-discipline-care-plans — the VOLUNTEER COMPLIANCE GATES MANAGER (§5.1 #11).
// Spec: docs/design/screens/clinical/WARDENX_UI_VOLUNTEER_MANAGEMENT.md — "Use Work Queue."
//
// The coordinator's 42 CFR §418.78(b)/(d) grid: every recorded gate with the status the validity window
// ACTUALLY implies as of now, plus create / correct / revoke.
//
// The screen shows `effectiveStatus`, not the materialized `storedStatus`: the nightly watcher writes the
// stored column, so between runs a gate that expired at midnight still reads `satisfied` in the table it
// was written to. The server re-derives the effective value per read (§2.2.6) and that is what governs
// scheduling — showing the stale column would tell a coordinator a volunteer is clear when M17 will refuse
// them. Where the two disagree the row says so.
//
// This is a WORKFORCE-credential surface, not patient data: no patient identifier appears, which is why
// route 19 carries a documented read-audit waiver rather than a patient-less PHI read event.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { type GateView, errorMessage, listGates, writeHeaders } from "./discipline-api";
import {
  FAILING_GATE_STATUSES,
  GATE_STATUS_TONE,
  dueLabel,
  gateKindLabel,
  humanize,
  shortDate,
  shortId,
  toneOf,
} from "./discipline-status";
import {
  FilterRow,
  Modal,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  alertStyle,
  ghostButtonStyle,
  mutedStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  tdMono,
  th,
} from "./discipline-ui";

/** `volunteer_gate_kind` (enums.ts §3.2) — the seven 418.78 postures. */
const GATE_KINDS = [
  "background_check",
  "tb_screening",
  "confidentiality_agreement",
  "initial_training",
  "annual_ce",
  "assignment_specific_training",
  "vaccination_status",
] as const;

const KIND_FILTER_OPTIONS = [
  { value: "", label: "Any gate kind" },
  ...GATE_KINDS.map((k) => ({ value: k, label: gateKindLabel(k) })),
];
const KIND_OPTIONS = GATE_KINDS.map((k) => ({ value: k, label: gateKindLabel(k) }));
const EXPIRY_OPTIONS = [
  { value: "", label: "Any expiry" },
  { value: "7", label: "Expiring within 7 days" },
  { value: "14", label: "Expiring within 14 days" },
  { value: "30", label: "Expiring within 30 days" },
];

export function VolunteerComplianceGates(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<GateView[]>([]);
  const [volunteerFilter, setVolunteerFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [expiryFilter, setExpiryFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<GateView | null>(null);
  const [revoking, setRevoking] = useState<GateView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { page, error: err } = await listGates(client, {
      ...(volunteerFilter.trim() ? { volunteerMembershipId: volunteerFilter.trim() } : {}),
      ...(kindFilter ? { gateKind: kindFilter } : {}),
      ...(expiryFilter ? { expiringWithinDays: Number(expiryFilter) } : {}),
    });
    if (err) {
      setError(
        errorMessage(err, "The volunteer compliance gates are unavailable in this session."),
      );
      setLoading(false);
      return;
    }
    setRows(page?.data ?? []);
    setLoading(false);
  }, [client, volunteerFilter, kindFilter, expiryFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const failing = rows.filter((g) => FAILING_GATE_STATUSES.includes(g.effectiveStatus));
  const expiring = rows.filter((g) => g.effectiveStatus === "expiring_soon");
  const blockedVolunteers = new Set(failing.map((g) => g.volunteerMembershipId));
  const drifted = rows.filter((g) => g.storedStatus !== g.effectiveStatus);

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Volunteer compliance"
            breadcrumb="Admin — 42 CFR §418.78(b) / (d) gates"
            actions={
              <button type="button" style={ghostButtonStyle} onClick={() => setCreating(true)}>
                Record gate
              </button>
            }
          />
        }
        kpis={
          <KpiStrip>
            <KpiCard label="Gates tracked" value={rows.length} />
            <KpiCard label="Expiring soon" value={expiring.length} />
            <KpiCard label="Unmet gates" value={failing.length} />
            <KpiCard label="Volunteers blocked" value={blockedVolunteers.size} />
          </KpiStrip>
        }
        filters={
          <FilterRow>
            <TextField
              label="Volunteer membership id"
              value={volunteerFilter}
              onChange={setVolunteerFilter}
            />
            <SelectField
              label="Gate kind"
              value={kindFilter}
              options={KIND_FILTER_OPTIONS}
              onChange={setKindFilter}
            />
            <SelectField
              label="Expiry window"
              value={expiryFilter}
              options={EXPIRY_OPTIONS}
              onChange={setExpiryFilter}
            />
          </FilterRow>
        }
        table={
          rows.length === 0 ? (
            <EmptyState
              title="No gates"
              description="No compliance gate matches this filter. A volunteer with no recorded gate is not schedulable."
            />
          ) : (
            <>
              {actionError ? <p style={alertStyle}>{actionError}</p> : null}
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Volunteer</th>
                    <th style={th}>Gate</th>
                    <th style={th}>Valid from</th>
                    <th style={th}>Valid until</th>
                    <th style={th}>Evidence</th>
                    <th style={th}>Status</th>
                    <th style={th}>&nbsp;</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((g) => (
                    <tr key={g.gateId} style={rowLine}>
                      <td style={tdMono}>{shortId(g.volunteerMembershipId)}</td>
                      <td style={td}>{gateKindLabel(g.gateKind)}</td>
                      <td style={td}>{shortDate(g.validFrom)}</td>
                      <td style={td}>
                        {g.validUntil ? (
                          <>
                            {shortDate(g.validUntil)}
                            <div style={mutedStyle}>{dueLabel(g.validUntil)}</div>
                          </>
                        ) : (
                          <span style={mutedStyle}>no expiry</span>
                        )}
                      </td>
                      <td style={tdMono}>{shortId(g.sourceDocumentId)}</td>
                      <td style={td}>
                        <StatusPill
                          label={humanize(g.effectiveStatus)}
                          tone={toneOf(GATE_STATUS_TONE, g.effectiveStatus)}
                        />
                        {g.storedStatus !== g.effectiveStatus ? (
                          <div style={mutedStyle}>
                            last written as {humanize(g.storedStatus).toLowerCase()}
                          </div>
                        ) : null}
                        {g.revokedAt ? (
                          <div style={mutedStyle}>revoked {shortDate(g.revokedAt)}</div>
                        ) : null}
                      </td>
                      <td style={td}>
                        <div style={{ display: "flex", gap: t.space2 }}>
                          <button
                            type="button"
                            style={ghostButtonStyle}
                            onClick={() => setEditing(g)}
                          >
                            Correct
                          </button>
                          {g.revokedAt ? null : (
                            <button
                              type="button"
                              style={ghostButtonStyle}
                              onClick={() => setRevoking(g)}
                            >
                              Revoke
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        }
        detail={
          <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
            <Notice tone={failing.length > 0 ? "error" : "success"}>
              {failing.length === 0
                ? "Every tracked gate is satisfied or approaching expiry — no volunteer is blocked by this list."
                : `${blockedVolunteers.size} volunteer${blockedVolunteers.size === 1 ? "" : "s"} cannot be scheduled: an expired, revoked or not-yet-satisfied gate fails 418.78 and the scheduler refuses the assignment.`}
            </Notice>
            {drifted.length > 0 ? (
              <Notice tone="warning">
                {drifted.length} row{drifted.length === 1 ? "" : "s"} show a status the nightly
                watcher has not written yet. The status shown here — re-derived from the validity
                window — is the one the scheduler enforces.
              </Notice>
            ) : null}
            <span style={mutedStyle}>
              Alerts fire at 30 / 14 / 7 / 1 days before expiry. `Expiring soon` warns; it does not
              block.
            </span>
          </div>
        }
      />

      {creating ? (
        <GateFormModal
          title="Record compliance gate"
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
          onError={setActionError}
        />
      ) : null}

      {editing ? (
        <GateFormModal
          title={`Correct ${gateKindLabel(editing.gateKind)}`}
          gate={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
          onError={setActionError}
        />
      ) : null}

      {revoking ? (
        <RevokeGateModal
          gate={revoking}
          onClose={() => setRevoking(null)}
          onSaved={() => {
            setRevoking(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

/** Routes 20 / 21 — record a new gate, or correct a recorded one's window / evidence. */
function GateFormModal({
  title,
  gate,
  onClose,
  onSaved,
  onError,
}: {
  title: string;
  gate?: GateView;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string | null) => void;
}): JSX.Element {
  const client = useApiClient();
  const [volunteerMembershipId, setVolunteer] = useState(gate?.volunteerMembershipId ?? "");
  const [gateKind, setGateKind] = useState(gate?.gateKind ?? GATE_KINDS[0]);
  const [validFrom, setValidFrom] = useState(shortDateInput(gate?.validFrom));
  const [validUntil, setValidUntil] = useState(shortDateInput(gate?.validUntil));
  const [sourceDocumentId, setSourceDocument] = useState(gate?.sourceDocumentId ?? "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editingExisting = gate !== undefined;
  const canSubmit = editingExisting || (volunteerMembershipId.trim() !== "" && validFrom !== "");

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    onError(null);
    const common = {
      validUntil: validUntil === "" ? null : new Date(validUntil).toISOString(),
      sourceDocumentId: sourceDocumentId.trim() === "" ? null : sourceDocumentId.trim(),
      ...(notes.trim() === "" ? {} : { notes }),
    };
    const res = editingExisting
      ? await client.PATCH("/api/v1/volunteer-compliance-gates/{gateId}", {
          params: { path: { gateId: gate.gateId }, header: writeHeaders(gate.version) },
          body: common,
        } as never)
      : await client.POST("/api/v1/volunteer-compliance-gates", {
          params: { header: writeHeaders() },
          body: {
            volunteerMembershipId,
            gateKind,
            validFrom: new Date(validFrom).toISOString(),
            ...common,
          },
        } as never);
    setBusy(false);
    if (res.error) {
      setError(errorMessage(res.error, "The gate could not be saved."));
      return;
    }
    onSaved();
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit || busy}
          style={{ ...primaryButtonStyle, opacity: canSubmit && !busy ? 1 : 0.5 }}
        >
          {busy ? "Saving…" : "Save gate"}
        </button>
      }
    >
      {editingExisting ? (
        <span style={mutedStyle}>
          A correction changes the validity window and the evidence only. The volunteer and gate
          kind identify the row and cannot be re-pointed — record a new gate instead.
        </span>
      ) : null}
      <TextField
        label="Volunteer membership id"
        value={volunteerMembershipId}
        onChange={editingExisting ? () => undefined : setVolunteer}
      />
      <SelectField
        label="Gate kind"
        value={gateKind}
        options={KIND_OPTIONS}
        onChange={editingExisting ? () => undefined : setGateKind}
      />
      <TextField label="Valid from" type="date" value={validFrom} onChange={setValidFrom} />
      <TextField
        label="Valid until (blank = no expiry)"
        type="date"
        value={validUntil}
        onChange={setValidUntil}
      />
      <TextField label="Source document id" value={sourceDocumentId} onChange={setSourceDocument} />
      <TextAreaField label="Notes" value={notes} onChange={setNotes} rows={2} />
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}

/** Route 22 — revoke a satisfied gate. The reason is stored and the volunteer goes inactive at once. */
function RevokeGateModal({
  gate,
  onClose,
  onSaved,
}: { gate: GateView; onClose: () => void; onSaved: () => void }): JSX.Element {
  const client = useApiClient();
  const [revokedReason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await client.POST("/api/v1/volunteer-compliance-gates/{gateId}/revoke", {
      params: { path: { gateId: gate.gateId }, header: writeHeaders(gate.version) },
      body: { revokedReason },
    } as never);
    setBusy(false);
    if (res.error) {
      setError(errorMessage(res.error, "The gate could not be revoked."));
      return;
    }
    onSaved();
  }

  return (
    <Modal
      title={`Revoke ${gateKindLabel(gate.gateKind)}`}
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={() => void submit()}
          disabled={revokedReason.trim() === "" || busy}
          style={{ ...primaryButtonStyle, opacity: revokedReason.trim() === "" || busy ? 0.5 : 1 }}
        >
          {busy ? "Revoking…" : "Revoke gate"}
        </button>
      }
    >
      <Notice tone="error">
        Revoking fails this volunteer's 418.78 posture immediately: their active assignments are
        inactivated and the scheduler refuses new ones until the gate is satisfied again.
      </Notice>
      <TextAreaField
        label="Reason"
        value={revokedReason}
        onChange={setReason}
        rows={3}
        hint="Stored on the gate and carried into the expiry cascade audit."
      />
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}

/** An instant → the `<input type="date">` value it maps to (empty for null). */
function shortDateInput(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}
