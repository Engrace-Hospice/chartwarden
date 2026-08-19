import {
  Card,
  CursorPagination,
  DataTable,
  EmptyState,
  FilterBar,
  KpiStrip,
  LoadingSpinner,
  MetricCard,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  t,
  useApiClient,
} from "@wardenx/ui";
import type { DataTableColumn, paths } from "@wardenx/ui";
// QAPI queue: the list stays identity-free; the authorized detail panel intentionally omits patient IDs
// and kind-specific payload because they are unnecessary for this triage surface.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  INCIDENT_SEVERITY_TONE,
  INCIDENT_STATE_TONE,
  QAPI_PHASE_TONE,
  humanize,
  readErrorMessage,
  toneOf,
} from "./quality-status";

type IncidentRow =
  paths["/api/v1/quality/incidents"]["get"]["responses"][200]["content"]["application/json"]["items"][number];
type IncidentDetail =
  paths["/api/v1/quality/incidents/{incidentId}"]["get"]["responses"][200]["content"]["application/json"];
type ProjectRow =
  paths["/api/v1/quality/qapi/projects"]["get"]["responses"][200]["content"]["application/json"]["items"][number];

const STATE_FILTERS: readonly ("all" | IncidentRow["state"])[] = [
  "all",
  "draft",
  "submitted",
  "triaged",
  "under_investigation",
  "resolved",
  "closed_followup_complete",
  "reopened",
];
const SETTLED_STATES: readonly IncidentRow["state"][] = ["resolved", "closed_followup_complete"];
const ESCALATED_SEVERITIES: readonly IncidentRow["severity"][] = ["severe", "critical"];
const MAX_PAGE = 100;

const INCIDENT_COLUMNS: readonly DataTableColumn<IncidentRow>[] = [
  { id: "kind", header: "Kind", cell: (x) => humanize(x.kind) },
  {
    id: "severity",
    header: "Severity",
    cell: (x) => (
      <StatusPill tone={toneOf(INCIDENT_SEVERITY_TONE, x.severity)} label={humanize(x.severity)} />
    ),
  },
  {
    id: "state",
    header: "State",
    cell: (x) => (
      <StatusPill tone={toneOf(INCIDENT_STATE_TONE, x.state)} label={humanize(x.state)} />
    ),
  },
  {
    id: "occurred",
    header: "Occurred",
    priority: "secondary",
    cell: (x) => x.occurredAt.slice(0, 10),
  },
  {
    id: "reported",
    header: "Reported",
    priority: "tertiary",
    cell: (x) => x.reportedAt.slice(0, 10),
  },
  {
    id: "patient",
    header: "Patient linked",
    priority: "tertiary",
    cell: (x) => (x.patientId ? "Yes" : "No"),
  },
  {
    id: "assigned",
    header: "Assigned",
    priority: "secondary",
    cell: (x) => (x.assignedToMembershipId ? "Assigned" : "Unassigned"),
  },
];
const PROJECT_COLUMNS: readonly DataTableColumn<ProjectRow>[] = [
  { id: "project", header: "Project", cell: (x) => x.title },
  {
    id: "phase",
    header: "Phase",
    cell: (x) => <StatusPill tone={toneOf(QAPI_PHASE_TONE, x.phase)} label={humanize(x.phase)} />,
  },
  {
    id: "chartered",
    header: "Chartered",
    priority: "secondary",
    cell: (x) => x.charteredAt.slice(0, 10),
  },
  {
    id: "completed",
    header: "Completed",
    priority: "tertiary",
    cell: (x) => x.completedAt?.slice(0, 10) ?? "—",
  },
];

export function QapiIncidents(): JSX.Element {
  const client = useApiClient();
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<"all" | IncidentRow["state"]>("all");
  const [selected, setSelected] = useState<IncidentRow | null>(null);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const result = await client.GET("/api/v1/quality/incidents", {
      params: { query: { limit: MAX_PAGE, cursor: nextCursor } },
    });
    if (result.error) setError(readErrorMessage(result.response?.status, "incident.read"));
    else {
      setIncidents((current) => [...current, ...(result.data?.items ?? [])]);
      setNextCursor(result.data?.nextCursor ?? null);
    }
    setLoadingMore(false);
  }, [client, nextCursor]);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      const [incidentResult, projectResult] = await Promise.all([
        client.GET("/api/v1/quality/incidents", { params: { query: { limit: MAX_PAGE } } }),
        client.GET("/api/v1/quality/qapi/projects", { params: { query: { limit: MAX_PAGE } } }),
      ]);
      if (!active) return;
      if (incidentResult.error)
        setError(readErrorMessage(incidentResult.response?.status, "incident.read"));
      else {
        setIncidents(incidentResult.data?.items ?? []);
        setNextCursor(incidentResult.data?.nextCursor ?? null);
      }
      if (!projectResult.error) setProjects(projectResult.data?.items ?? []);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const visible = useMemo(
    () => (stateFilter === "all" ? incidents : incidents.filter((x) => x.state === stateFilter)),
    [incidents, stateFilter],
  );
  const openCount = useMemo(
    () => incidents.filter((x) => !SETTLED_STATES.includes(x.state)).length,
    [incidents],
  );
  const severeCount = useMemo(
    () => incidents.filter((x) => ESCALATED_SEVERITIES.includes(x.severity)).length,
    [incidents],
  );
  const activeProjects = useMemo(
    () => projects.filter((x) => x.completedAt === null).length,
    [projects],
  );

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="QAPI & Incidents">
          <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
            The improvement programme and the incident register that feeds it.
          </p>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <MetricCard
            label="Open incidents"
            value={loading ? "—" : String(openCount)}
            tone="warning"
          />
          <MetricCard
            label="Severe / critical"
            value={loading ? "—" : String(severeCount)}
            tone="danger"
          />
          <MetricCard
            label="Active QAPI projects"
            value={loading ? "—" : String(activeProjects)}
            tone="info"
          />
          <MetricCard label="Total reported" value={loading ? "—" : String(incidents.length)} />
        </KpiStrip>
      }
      filters={
        <FilterBar
          activeFilterCount={stateFilter === "all" ? 0 : 1}
          onClear={() => setStateFilter("all")}
        >
          {STATE_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={stateFilter === filter}
              onClick={() => setStateFilter(filter)}
              style={{
                border: "none",
                borderRadius: "9999px",
                padding: "0.35rem 0.75rem",
                background: stateFilter === filter ? t.primaryTint : "transparent",
                color: stateFilter === filter ? t.primary : t.onSurfaceVariant,
                cursor: "pointer",
                fontSize: "0.8rem",
                fontWeight: stateFilter === filter ? 650 : 500,
              }}
            >
              {humanize(filter)}
            </button>
          ))}
        </FilterBar>
      }
      table={
        <div style={{ display: "flex", flexDirection: "column", gap: t.space4, padding: t.space5 }}>
          <Card padding="0" aria-labelledby="incident-register-heading">
            <h2
              id="incident-register-heading"
              style={{ margin: 0, padding: `${t.space4} ${t.space5}` }}
            >
              Incident register
            </h2>
            {loading ? (
              <div style={{ padding: t.space5 }}>
                <LoadingSpinner label="Loading incidents" />
              </div>
            ) : error ? (
              <EmptyState title="Unavailable" description={error} />
            ) : (
              <>
                <DataTable
                  ariaLabel="Incident register"
                  caption="Incidents visible in the current QAPI filter"
                  rows={visible}
                  columns={INCIDENT_COLUMNS}
                  getRowId={(x) => x.incidentId}
                  selectedRowId={selected?.incidentId}
                  onRowSelect={setSelected}
                  empty={
                    <EmptyState
                      title="No incidents"
                      description={
                        stateFilter === "all"
                          ? "Nothing has been reported for this agency."
                          : `No incidents in the ${humanize(stateFilter).toLowerCase()} state.`
                      }
                    />
                  }
                />
                <CursorPagination
                  loadedCount={incidents.length}
                  hasNextPage={Boolean(nextCursor)}
                  loading={loadingMore}
                  onNextPage={() => void loadMore()}
                  noun="incidents"
                />
              </>
            )}
          </Card>
          <Card padding="0" aria-labelledby="qapi-projects-heading">
            <h2
              id="qapi-projects-heading"
              style={{ margin: 0, padding: `${t.space4} ${t.space5}` }}
            >
              QAPI projects
            </h2>
            <DataTable
              ariaLabel="QAPI projects"
              caption="QAPI improvement projects"
              rows={projects}
              columns={PROJECT_COLUMNS}
              getRowId={(x) => x.projectId}
              empty={
                <EmptyState
                  title="No QAPI projects"
                  description="No improvement projects have been chartered under the current programme."
                />
              }
            />
          </Card>
        </div>
      }
      detail={
        selected ? (
          <IncidentDetailPanel incident={selected} onClose={() => setSelected(null)} />
        ) : undefined
      }
    />
  );
}

function IncidentDetailPanel({
  incident,
  onClose,
}: { incident: IncidentRow; onClose: () => void }): JSX.Element {
  const client = useApiClient();
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(null);
    void (async () => {
      const result = await client.GET("/api/v1/quality/incidents/{incidentId}", {
        params: { path: { incidentId: incident.incidentId } },
      });
      if (!active) return;
      if (result.error) setError(readErrorMessage(result.response?.status, "incident.read"));
      else setDetail(result.data ?? null);
    })();
    return () => {
      active = false;
    };
  }, [client, incident.incidentId]);
  return (
    <RightDetailPanel title={humanize(incident.kind)} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: t.space4 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: t.space2 }}>
          <StatusPill
            tone={toneOf(INCIDENT_SEVERITY_TONE, incident.severity)}
            label={humanize(incident.severity)}
          />
          <StatusPill
            tone={toneOf(INCIDENT_STATE_TONE, incident.state)}
            label={humanize(incident.state)}
          />
        </div>
        <DetailField label="Occurred" value={incident.occurredAt.slice(0, 16)} />
        <DetailField label="Reported" value={incident.reportedAt.slice(0, 16)} />
        <DetailField
          label="Assignment"
          value={incident.assignedToMembershipId ? "Assigned" : "Unassigned"}
        />
        {error ? <EmptyState title="Incident detail unavailable" description={error} /> : null}
        {!detail && !error ? <LoadingSpinner label="Loading incident detail" /> : null}
        {detail ? (
          <>
            <section>
              <h3 style={{ margin: `0 0 ${t.space2}`, fontSize: "1rem" }}>
                Investigation timeline
              </h3>
              {detail.stateHistory.length === 0 ? (
                <p style={{ margin: 0, color: t.onSurfaceVariant }}>No recorded transitions yet.</p>
              ) : (
                <ol
                  style={{
                    margin: 0,
                    paddingLeft: t.space5,
                    display: "flex",
                    flexDirection: "column",
                    gap: t.space2,
                  }}
                >
                  {detail.stateHistory.map((event, index) => (
                    <li key={`${event.occurredAt}-${index}`}>
                      <strong>{humanize(event.toState)}</strong>
                      <span style={{ color: t.onSurfaceVariant }}>
                        {" "}
                        · {event.occurredAt.slice(0, 16)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <section>
              <h3 style={{ margin: `0 0 ${t.space2}`, fontSize: "1rem" }}>Corrective action</h3>
              {detail.capPlan ? (
                <>
                  <p style={{ margin: 0, color: t.onSurfaceVariant }}>
                    {detail.capPlan.rootCauseSummary}
                  </p>
                  <p style={{ margin: `${t.space2} 0 0`, color: t.onSurfaceVariant }}>
                    {detail.capPlan.actions.length} action
                    {detail.capPlan.actions.length === 1 ? "" : "s"} planned
                  </p>
                </>
              ) : (
                <p style={{ margin: 0, color: t.onSurfaceVariant }}>
                  No corrective action plan is recorded.
                </p>
              )}
            </section>
            <DetailField
              label="Investigation notes"
              value={`${detail.investigationNotes.length} recorded`}
            />
          </>
        ) : null}
      </div>
    </RightDetailPanel>
  );
}

function DetailField({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
      <span
        style={{
          color: t.onSurfaceVariant,
          fontSize: "0.6875rem",
          fontWeight: 650,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span style={{ color: t.onSurface }}>{value}</span>
    </div>
  );
}
