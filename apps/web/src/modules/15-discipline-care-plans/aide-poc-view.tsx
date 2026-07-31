import { StatusPill, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/15-discipline-care-plans — the AIDE POC VIEW + SUPERVISORY MODAL (§5.1 #2 / #5).
//
// The 42 CFR §418.76(h) surface: the current Aide Plan of Care over the shared plan spine, plus the two
// things only this kind has — the 14-day supervisory NEXT-DUE ladder (§7.1) and the RN attestation ledger.
//
// Three server truths this screen shows rather than re-deriving:
//   • the cadence state (`on_time` / `due` / `overdue` / `gate_engaged`) is computed SERVER-side and rides
//     the plan read; `gate_engaged` is the CHHA encounter-sign block, so it is stated as such;
//   • a PHONE-only supervision (no source encounter) is recorded for survey discoverability but does NOT
//     re-arm the clock (§2.2.4 D3) — the modal says so at the point of capture, not after the fact;
//   • only the plan's NAMED supervising RN (or a covering Clinical Supervisor / DON) may attest — that is
//     the `aide_supervisor_eligible` ABAC on routes 15/16, and a refusal is surfaced verbatim.
import { useState } from "react";
import type { JSX } from "react";
import {
  type PlanDetail,
  type SupervisoryVisitView,
  errorMessage,
  writeHeaders,
} from "./discipline-api";
import {
  Card,
  Field,
  Modal,
  Notice,
  SelectField,
  SummaryGrid,
  TextAreaField,
  TextField,
  alertStyle,
  ghostButtonStyle,
  mutedStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./discipline-ui";
import {
  CADENCE_STATUS_TONE,
  attestationModeLabel,
  dateTime,
  dueLabel,
  humanize,
  shortId,
  toneOf,
} from "./discipline-status";
import { DisciplinePlanWorkspace } from "./plan-workspace";

const MODE_OPTIONS = [
  { value: "aide_present", label: "Aide present" },
  { value: "observation_of_work", label: "Observation of the aide's work" },
];

/** The §4.2 narrative floor the server enforces (`minLength: 40`) — surfaced before the round trip. */
const NARRATIVE_MIN = 40;

function SupervisoryVisitModal({
  plan,
  onClose,
  onRecorded,
}: {
  plan: PlanDetail;
  onClose: () => void;
  onRecorded: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [aideMembershipId, setAide] = useState(plan.aideMembershipId ?? "");
  const [supervisingRnMembershipId, setRn] = useState(plan.supervisingRnMembershipId ?? "");
  const [sourceEncounterId, setEncounter] = useState("");
  const [supervisoryAt, setAt] = useState(new Date().toISOString().slice(0, 16));
  const [attestationMode, setMode] = useState("aide_present");
  const [satisfactory, setSatisfactory] = useState(true);
  const [correctiveActions, setCorrective] = useState("");
  const [narrative, setNarrative] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phoneOnly = sourceEncounterId.trim().length === 0;
  const canSubmit =
    aideMembershipId.trim().length > 0 &&
    supervisingRnMembershipId.trim().length > 0 &&
    narrative.trim().length >= NARRATIVE_MIN &&
    (satisfactory || correctiveActions.trim().length > 0) &&
    !busy;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await client.POST("/api/v1/discipline-plans/{planId}/aide-supervisory-visits", {
      params: { path: { planId: plan.planId }, header: writeHeaders() },
      body: {
        aideMembershipId,
        supervisingRnMembershipId,
        sourceEncounterId: phoneOnly ? null : sourceEncounterId,
        supervisoryAt: new Date(supervisoryAt).toISOString(),
        attestationMode,
        aidePerformanceSatisfactory: satisfactory,
        correctiveActions: correctiveActions.trim() === "" ? null : correctiveActions,
        supervisoryNarrative: narrative,
      },
    } as never);
    setBusy(false);
    if (res.error) {
      setError(
        errorMessage(
          res.error,
          "The supervisory attestation was not recorded. Only this plan's supervising RN (or a covering supervisor) may attest.",
        ),
      );
      return;
    }
    onRecorded();
  }

  return (
    <Modal
      title="Record supervisory visit"
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          style={{ ...primaryButtonStyle, opacity: canSubmit ? 1 : 0.5 }}
        >
          {busy ? "Recording…" : "Record attestation"}
        </button>
      }
    >
      <TextField label="Aide membership id" value={aideMembershipId} onChange={setAide} />
      <TextField
        label="Supervising RN membership id"
        value={supervisingRnMembershipId}
        onChange={setRn}
      />
      <TextField
        label="Source encounter id (leave blank for a phone-only contact)"
        value={sourceEncounterId}
        onChange={setEncounter}
      />
      <TextField
        label="Supervisory date and time"
        type="datetime-local"
        value={supervisoryAt}
        onChange={setAt}
      />
      <SelectField
        label="Attestation mode"
        value={attestationMode}
        options={MODE_OPTIONS}
        onChange={setMode}
      />
      <label
        style={{ display: "flex", alignItems: "center", gap: t.space2, fontSize: "0.82rem", color: t.onSurface }}
      >
        <input
          type="checkbox"
          checked={satisfactory}
          onChange={(e) => setSatisfactory(e.target.checked)}
        />
        Aide performance satisfactory
      </label>
      {!satisfactory ? (
        <TextAreaField
          label="Corrective actions"
          value={correctiveActions}
          onChange={setCorrective}
          rows={3}
          hint="Required when performance is not satisfactory."
        />
      ) : null}
      <TextAreaField
        label="Supervisory narrative"
        value={narrative}
        onChange={setNarrative}
        rows={5}
        hint={`At least ${NARRATIVE_MIN} characters — the survey-facing record of what was supervised.`}
      />
      {phoneOnly ? (
        <Notice tone="warning">
          A supervision with no source encounter is recorded for survey discoverability but does NOT
          re-arm the 14-day clock.
        </Notice>
      ) : null}
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}

function SupervisoryLedger({
  plan,
  reload,
}: { plan: PlanDetail; reload: () => Promise<void> }): JSX.Element {
  const client = useApiClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Route 16 — sign the attestation (step-up + `aide_supervisor_eligible`). */
  async function sign(visit: SupervisoryVisitView): Promise<void> {
    setError(null);
    const res = await client.POST(
      "/api/v1/discipline-plans/{planId}/aide-supervisory-visits/{visitId}/sign",
      {
        params: {
          path: { planId: plan.planId, visitId: visit.supervisoryVisitId },
          header: writeHeaders(visit.version),
        },
        body: {},
      } as never,
    );
    if (res.error) {
      setError(
        errorMessage(
          res.error,
          "The attestation was not signed. Signing requires a recently re-authenticated session.",
        ),
      );
      return;
    }
    await reload();
  }

  const visits = [...plan.supervisoryVisits].sort(
    (a, b) => Date.parse(b.supervisoryAt) - Date.parse(a.supervisoryAt),
  );

  return (
    <>
      <Card
        title="RN supervisory attestations"
        actions={
          <button type="button" style={ghostButtonStyle} onClick={() => setOpen(true)}>
            Record supervisory visit
          </button>
        }
      >
        <SummaryGrid>
          <Field label="Assigned aide" value={shortId(plan.aideMembershipId)} mono />
          <Field label="Supervising RN" value={shortId(plan.supervisingRnMembershipId)} mono />
          <Field
            label="Cadence"
            value={
              plan.supervisoryCadence
                ? `${plan.supervisoryCadence.cadenceDays} days`
                : plan.supervisoryCadenceDaysOverride
                  ? `${plan.supervisoryCadenceDaysOverride} days (tenant override)`
                  : "14 days"
            }
          />
        </SummaryGrid>
        {error ? <p style={alertStyle}>{error}</p> : null}
        {visits.length === 0 ? (
          <span style={mutedStyle}>
            No supervisory attestation recorded yet. The first one arms the 14-day cadence.
          </span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Supervised</th>
                <th style={th}>Mode</th>
                <th style={th}>Performance</th>
                <th style={th}>Source</th>
                <th style={th}>Next due</th>
                <th style={th}>Signed</th>
                <th style={th}>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.supervisoryVisitId} style={rowLine}>
                  <td style={td}>{dateTime(v.supervisoryAt)}</td>
                  <td style={td}>{attestationModeLabel(v.attestationMode)}</td>
                  <td style={td}>
                    <StatusPill
                      label={v.aidePerformanceSatisfactory ? "Satisfactory" : "Corrective action"}
                      tone={v.aidePerformanceSatisfactory ? "success" : "warning"}
                    />
                    {v.correctiveActions ? (
                      <div style={mutedStyle}>{v.correctiveActions}</div>
                    ) : null}
                  </td>
                  <td style={td}>
                    {v.sourceEncounterId ? (
                      shortId(v.sourceEncounterId)
                    ) : (
                      <span style={mutedStyle}>phone only — clock not re-armed</span>
                    )}
                  </td>
                  <td style={td}>{dateTime(v.nextDueAt)}</td>
                  <td style={td}>{dateTime(v.signedAt)}</td>
                  <td style={td}>
                    {v.signedAt ? null : (
                      <button type="button" style={ghostButtonStyle} onClick={() => void sign(v)}>
                        Sign
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {open ? (
        <SupervisoryVisitModal
          plan={plan}
          onClose={() => setOpen(false)}
          onRecorded={() => {
            setOpen(false);
            void reload();
          }}
        />
      ) : null}
    </>
  );
}

export function AidePocView(): JSX.Element {
  return (
    <DisciplinePlanWorkspace
      kind="aide_poc"
      renderNotice={(plan) => {
        const cadence = plan.supervisoryCadence;
        if (!cadence) return null;
        const tone =
          cadence.status === "gate_engaged" || cadence.status === "overdue"
            ? "error"
            : cadence.status === "due"
              ? "warning"
              : "success";
        return (
          <Notice tone={tone}>
            <strong>Next supervisory visit {dueLabel(cadence.nextDueAt)}</strong> (
            {dateTime(cadence.nextDueAt)}) —{" "}
            <StatusPill
              label={humanize(cadence.status)}
              tone={toneOf(CADENCE_STATUS_TONE, cadence.status)}
            />
            {cadence.status === "gate_engaged"
              ? " A new aide visit cannot be signed until a supervisory attestation is recorded, or a Clinical Supervisor documents an override."
              : cadence.hoursOverdue > 0
                ? ` ${cadence.hoursOverdue} hours past due.`
                : ""}
          </Notice>
        );
      }}
      renderExtras={(plan, reload) => <SupervisoryLedger plan={plan} reload={reload} />}
    />
  );
}
