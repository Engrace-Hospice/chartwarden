import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import type { paths } from "@wardenx/ui";
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

const SETTLED_STATES: readonly IncidentRow["state"][] = ["resolved", "closed_followup_complete"];
const ESCALATED_SEVERITIES: readonly IncidentRow["severity"][] = ["severe", "critical"];
const MAX_PAGE = 100;

export function QapiIncidents(): JSX.Element {
  const client = useApiClient();
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | IncidentRow["state"]>("all");
  const [severityFilter, setSeverityFilter] = useState<"all" | IncidentRow["severity"]>("all");
  const [incidentPage, setIncidentPage] = useState(1);
  const [incidentPageSize, setIncidentPageSize] = useState(10);
  const [projectPage, setProjectPage] = useState(1);
  const [projectPageSize, setProjectPageSize] = useState(5);
  const [selected, setSelected] = useState<IncidentRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        setError(null);
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

  const counts = useMemo(
    () => ({
      open: incidents.filter((x) => !SETTLED_STATES.includes(x.state)).length,
      severe: incidents.filter((x) => ESCALATED_SEVERITIES.includes(x.severity)).length,
      activeProjects: projects.filter((x) => x.completedAt === null).length,
      total: incidents.length,
    }),
    [incidents, projects],
  );

  const visibleIncidents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return incidents.filter((x) => {
      const matchesState = stateFilter === "all" || x.state === stateFilter;
      const matchesSeverity = severityFilter === "all" || x.severity === severityFilter;
      const matchesSearch =
        !q ||
        x.incidentId.toLowerCase().includes(q) ||
        x.kind.toLowerCase().includes(q) ||
        x.state.toLowerCase().includes(q) ||
        x.severity.toLowerCase().includes(q) ||
        (x.assignedToMembershipId?.toLowerCase().includes(q) ?? false);
      return matchesState && matchesSeverity && matchesSearch;
    });
  }, [incidents, searchQuery, severityFilter, stateFilter]);

  const sortedIncidents = useMemo(
    () =>
      [...visibleIncidents].sort(
        (a, b) =>
          incidentRank(a) - incidentRank(b) || Date.parse(b.reportedAt) - Date.parse(a.reportedAt),
      ),
    [visibleIncidents],
  );

  const activeIncidentPage = Math.min(
    incidentPage,
    Math.max(1, Math.ceil(sortedIncidents.length / incidentPageSize)),
  );
  const pagedIncidents = sortedIncidents.slice(
    (activeIncidentPage - 1) * incidentPageSize,
    activeIncidentPage * incidentPageSize,
  );
  const activeProjectPage = Math.min(
    projectPage,
    Math.max(1, Math.ceil(projects.length / projectPageSize)),
  );
  const pagedProjects = projects.slice(
    (activeProjectPage - 1) * projectPageSize,
    activeProjectPage * projectPageSize,
  );
  const activeFilters = [
    searchQuery.trim() !== "",
    stateFilter !== "all",
    severityFilter !== "all",
  ].filter(Boolean).length;

  const clearFilters = (): void => {
    setSearchQuery("");
    setStateFilter("all");
    setSeverityFilter("all");
    setIncidentPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="QAPI & Incidents" breadcrumb="Compliance / Quality">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            The improvement programme and the incident register that feeds it.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Open incidents"
            value={loading ? "—" : String(counts.open)}
            detail="Not settled"
            tone={counts.open > 0 ? "warning" : "neutral"}
            accentColor={counts.open > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Severe / critical"
            value={loading ? "—" : String(counts.severe)}
            detail="Escalated severity"
            tone={counts.severe > 0 ? "danger" : "neutral"}
            accentColor={counts.severe > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
            selected={severityFilter === "severe"}
            onSelect={() => {
              setSeverityFilter("severe");
              setIncidentPage(1);
            }}
          />
          <KpiCard
            label="Active QAPI projects"
            value={loading ? "—" : String(counts.activeProjects)}
            detail="Improvement work"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Total reported"
            value={loading ? "—" : String(counts.total)}
            detail="Loaded incidents"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
            selected={activeFilters === 0}
            onSelect={clearFilters}
          />
        </KpiStrip>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} style={dismissButtonStyle}>
                x
              </button>
            </div>
          ) : null}
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Incident register</span>
              <strong>{sortedIncidents.length} matching incidents</strong>
            </div>
            <div style={controlGroupStyle}>
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  placeholder="Search incident, kind, assignment..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setIncidentPage(1);
                  }}
                  aria-label="Search QAPI incidents"
                />
              </label>
              <label className="wx-filter-field">
                <span>State</span>
                <select
                  className="wx-select"
                  aria-label="Incident state"
                  value={stateFilter}
                  onChange={(e) => {
                    setStateFilter(e.target.value as typeof stateFilter);
                    setIncidentPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="all">All</option>
                  <option value="draft">Draft</option>
                  <option value="submitted">Submitted</option>
                  <option value="triaged">Triaged</option>
                  <option value="under_investigation">Under investigation</option>
                  <option value="resolved">Resolved</option>
                  <option value="closed_followup_complete">Closed follow-up complete</option>
                  <option value="reopened">Reopened</option>
                </select>
              </label>
              <label className="wx-filter-field">
                <span>Severity</span>
                <select
                  className="wx-select"
                  aria-label="Incident severity"
                  value={severityFilter}
                  onChange={(e) => {
                    setSeverityFilter(e.target.value as typeof severityFilter);
                    setIncidentPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="all">All</option>
                  <option value="minor">Minor</option>
                  <option value="moderate">Moderate</option>
                  <option value="severe">Severe</option>
                  <option value="critical">Critical</option>
                </select>
              </label>
              {activeFilters > 0 ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      }
      table={
        loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : error && incidents.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            {sortedIncidents.length === 0 ? (
              <div style={{ padding: "2rem 0" }}>
                <EmptyState
                  title={activeFilters > 0 ? "No matching incidents" : "No incidents"}
                  description={
                    activeFilters > 0
                      ? "Try adjusting the incident filters."
                      : "Nothing has been reported for this agency."
                  }
                  action={
                    activeFilters > 0 ? (
                      <Button size="sm" tone="secondary" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <>
                <table style={tableStyle}>
                  <thead>
                    <tr style={headerRowStyle}>
                      <th style={{ ...thStyle, width: "26%" }}>Incident</th>
                      <th style={{ ...thStyle, width: "14%" }}>Severity</th>
                      <th style={{ ...thStyle, width: "16%" }}>State</th>
                      <th style={{ ...thStyle, width: "14%" }}>Occurred</th>
                      <th style={{ ...thStyle, width: "14%" }}>Reported</th>
                      <th style={{ ...thStyle, width: "16%", textAlign: "right" }}>Assignment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedIncidents.map((x) => (
                      <tr
                        key={x.incidentId}
                        // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelected(x)}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter" || ev.key === " ") {
                            ev.preventDefault();
                            setSelected(x);
                          }
                        }}
                        style={{
                          ...rowStyle,
                          background:
                            selected?.incidentId === x.incidentId
                              ? "var(--color-primary-tint)"
                              : "transparent",
                        }}
                        className="wx-data-row-interactive"
                      >
                        <td style={tdStyle}>
                          <div style={primaryCellStyle}>
                            <span style={primaryTextStyle}>{humanize(x.kind)}</span>
                            <code className="wx-data-md" style={codeStyle}>
                              {shortId(x.incidentId)}
                            </code>
                          </div>
                        </td>
                        <td style={tdStyle}>
                          <StatusPill
                            tone={toneOf(INCIDENT_SEVERITY_TONE, x.severity)}
                            label={humanize(x.severity)}
                          />
                        </td>
                        <td style={tdStyle}>
                          <StatusPill
                            tone={toneOf(INCIDENT_STATE_TONE, x.state)}
                            label={humanize(x.state)}
                          />
                        </td>
                        <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                          {formatDate(x.occurredAt)}
                        </td>
                        <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                          {formatDate(x.reportedAt)}
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right" }}>
                          {x.assignedToMembershipId ? "Assigned" : "Unassigned"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <OffsetPagination
                  page={activeIncidentPage}
                  pageSize={incidentPageSize}
                  totalItems={sortedIncidents.length}
                  onPageChange={setIncidentPage}
                  onPageSizeChange={(nextPageSize) => {
                    setIncidentPageSize(nextPageSize);
                    setIncidentPage(1);
                  }}
                  pageSizeOptions={QUALITY_PAGE_SIZES}
                  noun="incidents"
                />
                {nextCursor ? (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      padding: "0 1.5rem 1rem",
                    }}
                  >
                    <Button
                      size="sm"
                      tone="secondary"
                      disabled={loadingMore}
                      onClick={() => void loadMore()}
                    >
                      {loadingMore ? "Loading..." : "Load more"}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
            <section style={{ paddingTop: "1rem" }}>
              <h2 style={sectionTitleStyle}>QAPI projects</h2>
              {projects.length === 0 ? (
                <div style={{ padding: "1rem 0" }}>
                  <EmptyState
                    title="No QAPI projects"
                    description="No improvement projects have been chartered under the current programme."
                  />
                </div>
              ) : (
                <>
                  <table style={tableStyle}>
                    <thead>
                      <tr style={headerRowStyle}>
                        <th style={{ ...thStyle, width: "46%" }}>Project</th>
                        <th style={{ ...thStyle, width: "18%" }}>Phase</th>
                        <th style={{ ...thStyle, width: "18%" }}>Chartered</th>
                        <th style={{ ...thStyle, width: "18%", textAlign: "right" }}>Completed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedProjects.map((x) => (
                        <tr key={x.projectId} style={rowStyle}>
                          <td style={tdStyle}>
                            <div style={primaryCellStyle}>
                              <span style={primaryTextStyle}>{x.title}</span>
                              <code className="wx-data-md" style={codeStyle}>
                                {shortId(x.projectId)}
                              </code>
                            </div>
                          </td>
                          <td style={tdStyle}>
                            <StatusPill
                              tone={toneOf(QAPI_PHASE_TONE, x.phase)}
                              label={humanize(x.phase)}
                            />
                          </td>
                          <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                            {formatDate(x.charteredAt)}
                          </td>
                          <td
                            style={{
                              ...tdStyle,
                              textAlign: "right",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {formatDate(x.completedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <OffsetPagination
                    page={activeProjectPage}
                    pageSize={projectPageSize}
                    totalItems={projects.length}
                    onPageChange={setProjectPage}
                    onPageSizeChange={(nextPageSize) => {
                      setProjectPageSize(nextPageSize);
                      setProjectPage(1);
                    }}
                    pageSizeOptions={QUALITY_PAGE_SIZES}
                    noun="projects"
                  />
                </>
              )}
            </section>
          </div>
        )
      }
      detail={
        selected ? (
          <IncidentDetailPanel incident={selected} onClose={() => setSelected(null)} />
        ) : undefined
      }
      fullPageScroll
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
    <RightDetailPanel title={humanize(incident.kind)} onClose={onClose} hideScrollbar>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          <StatusPill
            tone={toneOf(INCIDENT_SEVERITY_TONE, incident.severity)}
            label={humanize(incident.severity)}
          />
          <StatusPill
            tone={toneOf(INCIDENT_STATE_TONE, incident.state)}
            label={humanize(incident.state)}
          />
        </div>
        <DetailField label="Occurred" value={formatDateTime(incident.occurredAt)} />
        <DetailField label="Reported" value={formatDateTime(incident.reportedAt)} />
        <DetailField
          label="Assignment"
          value={incident.assignedToMembershipId ? "Assigned" : "Unassigned"}
        />
        {error ? <EmptyState title="Incident detail unavailable" description={error} /> : null}
        {!detail && !error ? <LoadingSpinner label="Loading incident detail" /> : null}
        {detail ? (
          <>
            <section>
              <h3 style={detailSectionTitleStyle}>Investigation timeline</h3>
              {detail.stateHistory.length === 0 ? (
                <p style={mutedTextStyle}>No recorded transitions yet.</p>
              ) : (
                <ol style={timelineStyle}>
                  {detail.stateHistory.map((event, index) => (
                    <li key={`${event.occurredAt}-${index}`}>
                      <strong>{humanize(event.toState)}</strong>
                      <span style={{ color: "var(--color-on-surface-variant)" }}>
                        {" "}
                        - {formatDateTime(event.occurredAt)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <section>
              <h3 style={detailSectionTitleStyle}>Corrective action</h3>
              {detail.capPlan ? (
                <>
                  <p style={mutedTextStyle}>{detail.capPlan.rootCauseSummary}</p>
                  <p style={mutedTextStyle}>
                    {detail.capPlan.actions.length} action
                    {detail.capPlan.actions.length === 1 ? "" : "s"} planned
                  </p>
                </>
              ) : (
                <p style={mutedTextStyle}>No corrective action plan is recorded.</p>
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
      <span style={detailLabelStyle}>{label}</span>
      <span style={{ color: "var(--color-on-surface)" }}>{value}</span>
    </div>
  );
}

const QUALITY_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

function incidentRank(row: IncidentRow): number {
  if (ESCALATED_SEVERITIES.includes(row.severity) && !SETTLED_STATES.includes(row.state)) return 0;
  if (!SETTLED_STATES.includes(row.state)) return 1;
  return 2;
}

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id;
}

const filterShellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const toolbarStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};
const toolbarTitleStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.125rem",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};
const toolbarEyebrowStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};
const searchWrapStyle = { minWidth: "15rem" };
const searchInputStyle = { width: "100%", height: "2.25rem", fontSize: "0.85rem" };
const selectStyle = { height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" };
const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};
const dismissButtonStyle = {
  border: "none",
  background: "none",
  color: "inherit",
  cursor: "pointer",
  fontWeight: 600,
};
const tableWrapStyle = {
  width: "100%",
  overflowX: "auto" as const,
  padding: "0 1.5rem 1.5rem 1.5rem",
};
const tableStyle = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "0.875rem",
};
const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const rowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
  cursor: "pointer",
  transition: "background 0.15s ease",
};
const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
};
const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};
const primaryCellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.25rem",
  minWidth: 0,
};
const primaryTextStyle = { fontWeight: 600, color: "var(--color-on-surface)" };
const codeStyle = {
  display: "inline-block",
  maxWidth: "13rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container)",
  borderRadius: "var(--radius-sm)",
  padding: "0.1rem 0.3rem",
  fontSize: "0.75rem",
};
const sectionTitleStyle = {
  margin: "0 0 0.75rem",
  fontSize: "1.05rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};
const detailSectionTitleStyle = { margin: "0 0 0.5rem", fontSize: "1rem" };
const mutedTextStyle = { margin: 0, color: "var(--color-on-surface-variant)" };
const detailLabelStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.6875rem",
  fontWeight: 650,
};
const timelineStyle = {
  margin: 0,
  paddingLeft: "1.25rem",
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.5rem",
};
