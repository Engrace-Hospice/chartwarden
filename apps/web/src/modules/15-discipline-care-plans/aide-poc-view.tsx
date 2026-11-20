import { Button, Panel, StatusPill, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/15-discipline-care-plans — the AIDE POC VIEW (§5.1 #2 / #5).
//
// The 42 CFR §418.76(h) surface: the current Aide Plan of Care over the shared plan spine, plus the two
// things only this kind has — the 14-day supervisory NEXT-DUE ladder (§7.1) and the RN attestation ledger.
// The "Record supervisory visit" ceremony lives in `./supervisory-visit-modal`.
//
// Two server truths this screen shows rather than re-deriving:
//   • the cadence state (`on_time` / `due` / `overdue` / `gate_engaged`) is computed SERVER-side and rides
//     the plan read; `gate_engaged` is the CHHA encounter-sign block, so it is stated as such;
//   • the aide and supervising RN are shown by NAME, from the plan-scoped staff roster (`./aide-roster`).
import { useState } from "react";
import type { JSX } from "react";
import { useAideRoster } from "./aide-roster";
import {
  type PlanDetail,
  type SupervisoryVisitView,
  errorMessage,
  writeHeaders,
} from "./discipline-api";
import {
  CADENCE_STATUS_TONE,
  attestationModeLabel,
  dateTime,
  dueLabel,
  humanize,
  shortId,
  toneOf,
} from "./discipline-status";
import { Field, Notice, SummaryGrid } from "./discipline-ui";
import { DisciplinePlanWorkspace } from "./plan-workspace";
import { SupervisoryVisitModal } from "./supervisory-visit-modal";

function SupervisoryLedger({
  plan,
  reload,
}: { plan: PlanDetail; reload: () => Promise<void> }): JSX.Element {
  const client = useApiClient();
  const roster = useAideRoster(plan.planId);
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
      <Panel
        stack
        headingLevel={3}
        title="RN supervisory attestations"
        action={
          <Button tone="secondary" type="button" onClick={() => setOpen(true)}>
            Record supervisory visit
          </Button>
        }
      >
        <SummaryGrid>
          <Field label="Assigned aide" value={roster.nameOf(plan.aideMembershipId)} />
          <Field label="Supervising RN" value={roster.nameOf(plan.supervisingRnMembershipId)} />
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
        {error ? (
          <p role="alert" className="wx-text-error">
            {error}
          </p>
        ) : null}
        {roster.error ? (
          <span className="wx-text-muted">Names could not be loaded; showing short ids.</span>
        ) : null}
        {visits.length === 0 ? (
          <span className="wx-text-muted">
            No supervisory attestation recorded yet. The first one arms the 14-day cadence.
          </span>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Supervised</th>
                <th>Mode</th>
                <th>Performance</th>
                <th>Source</th>
                <th>Next due</th>
                <th>Signed</th>
                <th>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.supervisoryVisitId}>
                  <td>{dateTime(v.supervisoryAt)}</td>
                  <td>{attestationModeLabel(v.attestationMode)}</td>
                  <td>
                    <StatusPill
                      label={v.aidePerformanceSatisfactory ? "Satisfactory" : "Corrective action"}
                      tone={v.aidePerformanceSatisfactory ? "success" : "warning"}
                    />
                    {v.correctiveActions ? (
                      <div className="wx-text-muted">{v.correctiveActions}</div>
                    ) : null}
                  </td>
                  <td>
                    {v.sourceEncounterId ? (
                      shortId(v.sourceEncounterId)
                    ) : (
                      <span className="wx-text-muted">phone only — clock not re-armed</span>
                    )}
                  </td>
                  <td>{dateTime(v.nextDueAt)}</td>
                  <td>{dateTime(v.signedAt)}</td>
                  <td>
                    {v.signedAt ? null : (
                      <Button tone="secondary" type="button" onClick={() => void sign(v)}>
                        Sign
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {open ? (
        <SupervisoryVisitModal
          plan={plan}
          roster={roster}
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
