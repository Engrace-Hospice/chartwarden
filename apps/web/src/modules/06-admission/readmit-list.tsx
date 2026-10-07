import { EmptyState, Glyph, Panel } from "@wardenx/ui";
// apps/web/src/modules/06-admission — "Readmit" (`/admissions/readmit`, nav: Admissions, right after Discharge /
// transfer). The patients who can come back: live discharges, revocations and transfers out of the last 90 days
// (deaths never), whose patient has no later admission — the discharge worklist's `recently_discharged` bucket, drawn
// with the hub's own table. Each row's "Readmit…" opens the readmission workflow (`/admissions/:id/readmit`).
//
// Who sees which rows is decided by the SERVER: an intake role org-wide, a nurse / physician / NP / PA at their own
// site (the `admission_clinical_site_scope` rule), everyone else their caseload. The rows carry the patient's name and
// MRN because a former patient's chart is usually off the caller's caseload — which is also why the name is not a
// chart link here. The page is gated on `admission.create` (screens.ts); the server enforces it on the readmission.
import { type JSX, useState } from "react";
import { useSession } from "../../shell/session";
import {
  ListState,
  RecentlyDischargedTable,
  usePatients,
  useWorklist,
} from "./discharge-worklist-ui";
import { RECENTLY_DISCHARGED_DAYS, hubAbilities, matchesPatient } from "./discharges-hub-model";

export function ReadmitList(): JSX.Element {
  const session = useSession();
  const can = hubAbilities(session?.permissions);
  const recent = useWorklist("recently_discharged", true);
  const patients = usePatients(recent.items);
  const [search, setSearch] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  const rows = recent.items.filter((r) =>
    matchesPatient(patients[r.patientId] ?? undefined, search),
  );

  return (
    <div className="wx-with-rail">
      <div className="wx-with-rail-main">
        <header className="wx-page-head">
          <div>
            <h1 style={{ fontSize: "1.875rem" }}>Readmit</h1>
            <p>
              Bring a patient back on service after a live discharge, a revocation or a transfer
              out.
            </p>
          </div>
        </header>

        <Panel
          title="Patients who can be readmitted"
          icon="rotate-ccw"
          description={`Live discharges, revocations and transfers out of the last ${RECENTLY_DISCHARGED_DAYS} days. Deaths are not listed.`}
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
                aria-label="Search patients who can be readmitted"
              />
            </label>
          </div>
          <ListState
            list={recent}
            emptyTitle="No one to readmit"
            emptyText={`Patients discharged alive from your site in the last ${RECENTLY_DISCHARGED_DAYS} days appear here.`}
          >
            {rows.length === 0 ? (
              <div className="wx-list-state">
                <EmptyState
                  title="No matching patients"
                  description="Try a different name or MRN."
                />
              </div>
            ) : (
              <RecentlyDischargedTable
                rows={rows}
                patients={patients}
                canReadmit={can.readmit}
                today={today}
                caption="Patients who can be readmitted"
                linkPatients={false}
              />
            )}
          </ListState>
        </Panel>
      </div>
      <aside className="wx-with-rail-side" aria-label="About readmission">
        <Panel title="Before you readmit" icon="info">
          <div style={{ display: "grid", gap: "0.75rem", fontSize: "0.8125rem" }}>
            <p style={{ margin: 0, color: "var(--color-on-surface-variant)" }}>
              A readmission is a new election. The workflow suggests the next benefit period from
              our history and checks it against Medicare (HETS) — another hospice may have served
              the patient since.
            </p>
            <p style={{ margin: 0, color: "var(--color-on-surface-variant)" }}>
              A third or later benefit period needs a face-to-face encounter before the admission
              can be activated, unless exceptional circumstances are documented.
            </p>
            <p style={{ margin: 0, color: "var(--color-on-surface-variant)" }}>
              Not listed? A patient who died, or who already has a newer admission, is not a
              readmission. Start a <b>New admission</b> for anyone else.
            </p>
          </div>
        </Panel>
      </aside>
    </div>
  );
}
