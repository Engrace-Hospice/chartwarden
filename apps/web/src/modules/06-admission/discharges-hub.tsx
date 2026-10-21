import { EmptyState, Glyph, Panel, StatusPill } from "@chartwarden/ui";
// apps/web/src/modules/06-admission — "Discharge / transfer" hub (`/admissions/discharges`, nav: Admissions, right
// below New admission). The one place to start or finish an end-of-episode workflow, drawn in the 2026-09-25 redesign
// idiom (page head, flat panels with list tables, a right context rail):
//   - Ready for discharge      active / on-hold admissions with no discharge on file → the discharge / revocation /
//                              transfer-out stepper or the death workflow (each action only for an actor holding it);
//   - Needs discharge details  ended stays whose record lacks the place of death / receiving care setting the final
//                              claim needs → the discharge-details screen;
//   - Awaiting for-cause cosign  (medical directors only) → the cosign screen;
//   - Recently discharged      live discharges / revocations / transfers out of the last 90 days → Readmit
//                              (admission.create) — the readmission workflow.
// Rows come from GET /api/v1/discharges/worklist (one bucket per call, caseload-narrowed server-side); names/MRNs
// from the patient read, only for the rows loaded. The server enforces every key on the workflows linked here.
import { type JSX, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fmtDate } from "../../shell/patient-context";
import { useSession } from "../../shell/session";
import { ADMISSION_TONE, stateLabel } from "./admission-status";
import { REASONS } from "./discharge-workflow-model";
import {
  ListState,
  PatientCell,
  RecentlyDischargedTable,
  mrnOf,
  usePatients,
  useWorklist,
} from "./discharge-worklist-ui";
import {
  MISSING_LABEL,
  endLabel,
  hubAbilities,
  matchesPatient,
  patientName,
} from "./discharges-hub-model";

export function DischargesHub(): JSX.Element {
  const session = useSession();
  const can = hubAbilities(session?.permissions);
  const ready = useWorklist("ready", true);
  const needs = useWorklist("needs_details", true);
  const cosign = useWorklist("awaiting_cosign", can.cosign);
  const recent = useWorklist("recently_discharged", true);
  const today = new Date().toISOString().slice(0, 10);
  const [search, setSearch] = useState("");

  const onScreen = useMemo(
    () => [...ready.items, ...needs.items, ...(can.cosign ? cosign.items : []), ...recent.items],
    [ready.items, needs.items, cosign.items, can.cosign, recent.items],
  );
  const patients = usePatients(onScreen);
  const readyRows = ready.items.filter((r) =>
    matchesPatient(patients[r.patientId] ?? undefined, search),
  );

  return (
    <div className="wx-with-rail">
      <div className="wx-with-rail-main">
        <header className="wx-page-head">
          <div>
            <h1 style={{ fontSize: "1.875rem" }}>Discharge / transfer</h1>
            <p>
              End a hospice stay — live discharge, revocation, transfer out or death — and finish
              the records billing still needs.
            </p>
          </div>
        </header>

        <Panel
          title="Ready for discharge"
          icon="user"
          description="Active and on-hold admissions with no discharge on file."
          flush
        >
          <div className="wx-filter-panel" style={{ border: 0, borderRadius: 0 }}>
            <label className="wx-search-field">
              <Glyph name="search" size={16} />
              <input
                type="search"
                placeholder="Search by patient name or MRN…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search admissions ready for discharge"
              />
            </label>
          </div>
          <ListState
            list={ready}
            emptyTitle="No admissions to discharge"
            emptyText="Active and on-hold admissions on your caseload appear here."
          >
            {readyRows.length === 0 ? (
              <div className="wx-list-state">
                <EmptyState
                  title="No matching patients"
                  description="Try a different name or MRN."
                />
              </div>
            ) : (
              <div className="wx-list-table-wrap">
                <table className="wx-list-table">
                  <caption className="wx-sr-only">Admissions ready for discharge</caption>
                  <thead>
                    <tr>
                      <th scope="col">Patient</th>
                      <th scope="col">MRN</th>
                      <th scope="col">Admitted</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="wx-sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {readyRows.map((r) => {
                      const name = patientName(patients[r.patientId] ?? undefined, "this patient");
                      return (
                        <tr key={r.admissionId}>
                          <PatientCell row={r} patients={patients} />
                          <td className="wx-nums">{mrnOf(patients, r.patientId)}</td>
                          <td className="wx-nums">{fmtDate(r.admissionAt)}</td>
                          <td>
                            <StatusPill
                              label={stateLabel(r.admissionState)}
                              tone={ADMISSION_TONE[r.admissionState] ?? "neutral"}
                            />
                          </td>
                          <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                            {can.discharge ? (
                              <Link
                                to={`/admissions/${r.admissionId}/discharge`}
                                className="wx-action-link"
                                aria-label={`Discharge or transfer ${name}`}
                              >
                                Discharge / transfer…
                              </Link>
                            ) : null}
                            {can.death ? (
                              <Link
                                to={`/admissions/${r.admissionId}/death`}
                                className="wx-action-link"
                                aria-label={`Record death for ${name}`}
                              >
                                Record death
                              </Link>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </ListState>
        </Panel>

        <Panel
          title="Needs discharge details"
          icon="receipt"
          description="Ended stays missing the place of death or the receiving care setting — the final claim is held until it is recorded."
          flush
        >
          <ListState
            list={needs}
            emptyTitle="Nothing missing"
            emptyText="Every ended stay has the details its final claim needs."
          >
            <div className="wx-list-table-wrap">
              <table className="wx-list-table">
                <caption className="wx-sr-only">Ended stays missing discharge details</caption>
                <thead>
                  <tr>
                    <th scope="col">Patient</th>
                    <th scope="col">MRN</th>
                    <th scope="col">Ended</th>
                    <th scope="col">Date</th>
                    <th scope="col">Missing</th>
                    <th scope="col">
                      <span className="wx-sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {needs.items.map((r) => (
                    <tr key={r.admissionId}>
                      <PatientCell row={r} patients={patients} />
                      <td className="wx-nums">{mrnOf(patients, r.patientId)}</td>
                      <td>{endLabel(r.dischargeType)}</td>
                      <td className="wx-nums">{fmtDate(r.effectiveDate ?? r.dischargedAt)}</td>
                      <td>
                        {r.missing ? (
                          <StatusPill label={MISSING_LABEL[r.missing]} tone="warning" />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Link
                          to={`/admissions/${r.admissionId}/discharge-details`}
                          className="wx-action-link"
                        >
                          Add details
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ListState>
        </Panel>

        <Panel
          title="Recently discharged"
          icon="rotate-ccw"
          description="Live discharges, revocations and transfers out of the last 90 days — patients who may come back. Deaths are not listed."
          flush
        >
          <ListState
            list={recent}
            emptyTitle="No recent live discharges"
            emptyText="Patients discharged alive in the last 90 days appear here."
          >
            <RecentlyDischargedTable
              rows={recent.items}
              patients={patients}
              canReadmit={can.readmit}
              today={today}
              caption="Recently discharged patients"
            />
          </ListState>
        </Panel>

        {can.cosign ? (
          <Panel
            title="Awaiting for-cause cosign"
            icon="shield-check"
            description="For-cause discharges take effect only after a medical director cosigns."
            flush
          >
            <ListState
              list={cosign}
              emptyTitle="No cosigns waiting"
              emptyText="For-cause discharges filed by the team appear here for your cosign."
            >
              <div className="wx-list-table-wrap">
                <table className="wx-list-table">
                  <caption className="wx-sr-only">For-cause discharges awaiting cosign</caption>
                  <thead>
                    <tr>
                      <th scope="col">Patient</th>
                      <th scope="col">MRN</th>
                      <th scope="col">Discharge date</th>
                      <th scope="col">
                        <span className="wx-sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {cosign.items.map((r) => (
                      <tr key={r.dischargeEventId ?? r.admissionId}>
                        <PatientCell row={r} patients={patients} />
                        <td className="wx-nums">{mrnOf(patients, r.patientId)}</td>
                        <td className="wx-nums">{fmtDate(r.effectiveDate)}</td>
                        <td style={{ textAlign: "right" }}>
                          {r.dischargeEventId ? (
                            <Link
                              to={`/discharges/${r.dischargeEventId}/cosign`}
                              className="wx-action-link"
                            >
                              Review &amp; cosign
                            </Link>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ListState>
          </Panel>
        ) : null}
      </div>

      <aside className="wx-with-rail-side" aria-label="Which workflow">
        <WhichWorkflowPanel />
      </aside>
    </div>
  );
}

/** The rail: which end-of-episode path fits, mirroring the reason hints in the discharge stepper. */
function WhichWorkflowPanel(): JSX.Element {
  const paths = [
    ...REASONS.map((r) => ({ key: r.value, label: r.label, hint: r.hint })),
    {
      key: "death",
      label: "Death",
      hint: "Record the death and pronouncement — its own workflow (Record death). Bereavement follow-up starts from it.",
    },
  ];
  return (
    <Panel title="Which workflow?" icon="info">
      <div style={{ display: "grid", gap: "0.75rem", fontSize: "0.8125rem" }}>
        <p style={{ margin: 0, color: "var(--color-on-surface-variant)" }}>
          Moving away and changing hospice are different: if another hospice in the new area takes
          over care, use <b>Transfer out</b> — the benefit period carries over and no new election
          is needed. Use <b>Moved out of service area</b> only when there is no immediate hospice
          hand-off.
        </p>
        <dl style={{ display: "grid", gap: "0.5rem", margin: 0 }}>
          {paths.map((p) => (
            <div key={p.key}>
              <dt style={{ fontWeight: 600, color: "var(--color-on-surface)" }}>{p.label}</dt>
              <dd style={{ margin: 0, color: "var(--color-on-surface-variant)" }}>{p.hint}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Panel>
  );
}
