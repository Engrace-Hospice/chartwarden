import {
  cardSurface,
  EmptyState,
  FilterBar,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/30-quality — M30 QAPI & INCIDENTS (§5.1, Track B / ADR-0030).
// Spec: docs/design/screens/compliance/WARDENX_UI_QAPI_INCIDENTS.md.
//
// The QAPI programme beside the incident register that feeds it. Reads GET /api/v1/quality/qapi/projects
// and /quality/incidents through the typed client.
//
// PHI POSTURE: an incident MAY carry a patient (`patientId` is nullable — not every incident is clinical),
// and the abuse-allegation rows are gated behind a separate permission and their own route. This screen
// shows the register WITHOUT patient identity: the server decides what the caller may see, and the list
// projection carries an id, not a name. Following a row to the patient is a navigation, not a disclosure
// this table performs on its own.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  INCIDENT_SEVERITY_TONE,
  INCIDENT_STATE_TONE,
  QAPI_PHASE_TONE,
  humanize,
  toneOf,
} from "./quality-status";

interface IncidentRow {
  incidentId: string;
  kind: string;
  state: string;
  severity: string;
  patientId: string | null;
  occurredAt: string;
  reportedAt: string;
  assignedToMembershipId: string | null;
}
interface ProjectRow {
  projectId: string;
  title: string;
  phase: string;
  charteredAt: string;
  completedAt: string | null;
}

const STATE_FILTERS = [
  "all",
  "reported",
  "triaged",
  "investigating",
  "resolved",
  "closed",
  "reopened",
];

const cell: CSSProperties = { padding: "0.55rem 0.75rem", textAlign: "left", verticalAlign: "middle" };
const head: CSSProperties = {
  ...cell,
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: t.onSurfaceVariant,
  fontWeight: 600,
};
const row: CSSProperties = { borderTop: `1px solid ${t.surfaceContainer}` };

export function QapiIncidents(): JSX.Element {
  const client = useApiClient();
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState("all");

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      const [iRes, pRes] = await Promise.all([
        client.GET("/api/v1/quality/incidents", { params: { query: { limit: 200 } } }),
        client.GET("/api/v1/quality/qapi/projects", { params: { query: { limit: 100 } } }),
      ]);
      if (!active) return;
      if (iRes.error) setError("Incident register unavailable — you may lack quality.incident.read.");
      else setIncidents(iRes.data?.items ?? []);
      if (!pRes.error) setProjects(pRes.data?.items ?? []);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const visible = useMemo(
    () => (stateFilter === "all" ? incidents : incidents.filter((i) => i.state === stateFilter)),
    [incidents, stateFilter],
  );

  const openCount = useMemo(
    () => incidents.filter((i) => i.state !== "closed" && i.state !== "resolved").length,
    [incidents],
  );
  const severeCount = useMemo(
    () => incidents.filter((i) => i.severity === "major" || i.severity === "sentinel").length,
    [incidents],
  );
  const activeProjects = useMemo(
    () => projects.filter((p) => p.completedAt === null).length,
    [projects],
  );

  return (
    <>
      <PageHeader title="QAPI & Incidents">
        <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
          The improvement programme and the incident register that feeds it.
        </p>
      </PageHeader>

      <KpiStrip>
        <KpiCard label="Open incidents" value={loading ? "—" : String(openCount)} />
        <KpiCard label="Major / sentinel" value={loading ? "—" : String(severeCount)} />
        <KpiCard label="Active QAPI projects" value={loading ? "—" : String(activeProjects)} />
        <KpiCard label="Total reported" value={loading ? "—" : String(incidents.length)} />
      </KpiStrip>

      <section style={cardSurface}>
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Incident register</h2>
        <FilterBar>
          {STATE_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setStateFilter(f)}
              style={{
                border: "none",
                background: stateFilter === f ? t.surfaceContainer : "transparent",
                color: stateFilter === f ? t.onSurface : t.onSurfaceVariant,
                padding: "0.3rem 0.7rem",
                borderRadius: "999px",
                cursor: "pointer",
                fontSize: "0.8rem",
              }}
            >
              {humanize(f)}
            </button>
          ))}
        </FilterBar>

        {loading ? (
          <LoadingSpinner />
        ) : error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : visible.length === 0 ? (
          <EmptyState
            title="No incidents"
            description={
              stateFilter === "all"
                ? "Nothing has been reported for this agency."
                : `No incidents in the ${humanize(stateFilter).toLowerCase()} state.`
            }
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={head}>Kind</th>
                <th style={head}>Severity</th>
                <th style={head}>State</th>
                <th style={head}>Occurred</th>
                <th style={head}>Reported</th>
                <th style={head}>Patient-linked</th>
                <th style={head}>Assigned</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((i) => (
                <tr key={i.incidentId} style={row}>
                  <td style={cell}>{humanize(i.kind)}</td>
                  <td style={cell}>
                    <StatusPill
                      tone={toneOf(INCIDENT_SEVERITY_TONE, i.severity)}
                      label={humanize(i.severity)}
                    />
                  </td>
                  <td style={cell}>
                    <StatusPill tone={toneOf(INCIDENT_STATE_TONE, i.state)} label={humanize(i.state)} />
                  </td>
                  <td style={cell}>{i.occurredAt.slice(0, 10)}</td>
                  <td style={cell}>{i.reportedAt.slice(0, 10)}</td>
                  {/* Yes/no only — the register does not disclose WHICH patient. */}
                  <td style={cell}>{i.patientId ? "Yes" : "No"}</td>
                  <td style={cell}>{i.assignedToMembershipId ? "Assigned" : "Unassigned"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ ...cardSurface, marginTop: "1rem" }}>
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>QAPI projects</h2>
        {projects.length === 0 ? (
          <EmptyState
            title="No QAPI projects"
            description="No improvement projects have been chartered under the current programme."
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={head}>Project</th>
                <th style={head}>Phase</th>
                <th style={head}>Chartered</th>
                <th style={head}>Completed</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.projectId} style={row}>
                  <td style={cell}>{p.title}</td>
                  <td style={cell}>
                    <StatusPill tone={toneOf(QAPI_PHASE_TONE, p.phase)} label={humanize(p.phase)} />
                  </td>
                  <td style={cell}>{p.charteredAt.slice(0, 10)}</td>
                  <td style={cell}>{p.completedAt?.slice(0, 10) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
