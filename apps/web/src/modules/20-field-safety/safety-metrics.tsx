// apps/web/src/modules/20-field-safety - §5.1 "SAFETY METRICS" (`/safety/metrics`, Track B / ADR-0030).
//
// M20 exposes the real trend metrics as a server-side seam, not as an HTTP route. This screen therefore
// shows only the reads the browser can honestly perform: the current dashboard snapshot and one incident
// ledger page.
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  type SafetyDashboardView,
  type SafetyIncidentView,
  errorMessage,
  getDashboard,
  listIncidents,
} from "./safety-api";
import {
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  dateTime,
  humanize,
  incidentCategoryLabel,
} from "./safety-status";
import { Notice } from "./safety-ui";

export function SafetyMetricsScreen(): JSX.Element {
  const client = useApiClient();
  const [board, setBoard] = useState<SafetyDashboardView | null>(null);
  const [incidents, setIncidents] = useState<SafetyIncidentView[]>([]);
  const [incidentsComplete, setIncidentsComplete] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [boardResult, incidentResult] = await Promise.all([
      getDashboard(client, {}),
      listIncidents(client, { limit: 100 }),
    ]);
    if (boardResult.error && incidentResult.error) {
      setError(
        errorMessage(
          boardResult.error,
          "Neither the safety board nor the incident ledger answered.",
        ),
      );
      setBoard(null);
      setIncidents([]);
      setLoading(false);
      return;
    }
    setBoard(boardResult.board);
    setIncidents(incidentResult.page?.data ?? []);
    setIncidentsComplete(incidentResult.page !== null && !incidentResult.page.has_more);
    setError(
      boardResult.error || incidentResult.error
        ? "One of the two reads did not answer; figures below are partial."
        : null,
    );
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const bySeverity = useMemo(
    () =>
      INCIDENT_SEVERITIES.map((severity) => ({
        key: severity,
        label: humanize(severity),
        value: incidents.filter((incident) => incident.severity === severity).length,
      })),
    [incidents],
  );
  const byCategory = useMemo(
    () =>
      INCIDENT_CATEGORIES.map((category) => ({
        key: category,
        label: incidentCategoryLabel(category),
        value: incidents.filter((incident) => incident.category === category).length,
      }))
        .filter((row) => row.value > 0)
        .sort((a, b) => b.value - a.value),
    [incidents],
  );

  if (loading && !board && incidents.length === 0) {
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  }

  if (!board && incidents.length === 0) {
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState
          title="Safety metrics unavailable"
          description={error ?? "Neither underlying read answered."}
        />
      </div>
    );
  }

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Safety Metrics"
          actions={
            <div style={actionGroupStyle}>
              <Link to="/safety" style={linkButtonStyle}>
                Safety board
              </Link>
              <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
                Refresh
              </Button>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Current census and one readable incident page. Trend metrics require the server-side
            `SafetyMetricsProvider` seam.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          <Notice tone="warning" live>
            These are not trend charts. M20 publishes no aggregate HTTP route, so this page avoids
            frontend-derived KPI cards and labels every fetched-row count as partial.
          </Notice>
          {error ? (
            <Notice tone="warning" live>
              {error}
            </Notice>
          ) : null}
        </div>
      }
      table={
        <div style={contentStyle}>
          <section style={sectionStyle}>
            <div style={sectionHeaderStyle}>
              <div style={toolbarTitleStyle}>
                <span style={toolbarEyebrowStyle}>Snapshot</span>
                <strong>Census right now</strong>
              </div>
              {board ? <StatusPill label={dateTime(board.fetchedAt)} tone="neutral" /> : null}
            </div>
            {board ? (
              <table style={tableStyle}>
                <thead>
                  <tr style={headerRowStyle}>
                    <th style={thStyle}>Signal</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Value</th>
                    <th style={thStyle}>Source</th>
                  </tr>
                </thead>
                <tbody>
                  <MetricRow
                    label="Clinicians on board"
                    value={board.clinicians.length}
                    source="Dashboard snapshot"
                  />
                  <MetricRow
                    label="Active SOS"
                    value={board.activeSosCount}
                    source="Server count"
                  />
                  <MetricRow
                    label="Overdue check-ins"
                    value={board.overdueCount}
                    source="Server count"
                  />
                  <MetricRow
                    label="In flagged area"
                    value={board.clinicians.filter((row) => row.inHighRiskArea !== null).length}
                    source="Snapshot rows"
                  />
                  <MetricRow
                    label="GPS spoof suspected"
                    value={board.clinicians.filter((row) => row.gpsSpoofSuspected).length}
                    source="Snapshot rows"
                  />
                  <MetricRow
                    label="No position on record"
                    value={board.clinicians.filter((row) => row.lastKnownLocation === null).length}
                    source="Snapshot rows"
                  />
                </tbody>
              </table>
            ) : (
              <Notice tone="error" assertive>
                The board did not answer, so there is no current census.
              </Notice>
            )}
          </section>

          <section style={sectionStyle}>
            <div style={sectionHeaderStyle}>
              <div style={toolbarTitleStyle}>
                <span style={toolbarEyebrowStyle}>Incident ledger</span>
                <strong>Fetched rows only</strong>
              </div>
              <StatusPill
                label={incidentsComplete ? "Page complete" : "Truncated page"}
                tone={incidentsComplete ? "success" : "warning"}
              />
            </div>
            <Notice tone={incidentsComplete ? "info" : "warning"}>
              {incidentsComplete
                ? "These incident figures cover every row returned to this caller for this read, not every agency incident."
                : "More incidents exist beyond this page. Treat every incident figure below as a floor, not a total."}
            </Notice>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={thStyle}>Signal</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Rows</th>
                  <th style={thStyle}>Source</th>
                </tr>
              </thead>
              <tbody>
                <MetricRow
                  label="Incidents fetched"
                  value={incidents.length}
                  source="Incident list read"
                />
                <MetricRow
                  label="Still open"
                  value={
                    incidents.filter(
                      (incident) =>
                        !["closed_with_action_plan", "closed_no_action"].includes(
                          incident.lifecycleState,
                        ),
                    ).length
                  }
                  source="Fetched rows"
                />
                <MetricRow
                  label="OSHA-reportable"
                  value={incidents.filter((incident) => incident.oshaReportable).length}
                  source="Fetched rows"
                />
                <MetricRow
                  label="Reportable, unsigned"
                  value={
                    incidents.filter(
                      (incident) =>
                        incident.oshaReportable && incident.oshaReportableSignedOffAt === null,
                    ).length
                  }
                  source="Fetched rows"
                />
                <MetricRow
                  label="Opened from SOS"
                  value={incidents.filter((incident) => incident.linkedSosAlertId !== null).length}
                  source="Fetched rows"
                />
                <MetricRow
                  label="Workers' comp initiated"
                  value={incidents.filter((incident) => incident.workersCompClaimInitiated).length}
                  source="Fetched rows"
                />
              </tbody>
            </table>
          </section>

          <DistributionTable
            title="By Severity"
            rows={bySeverity}
            empty="No severity rows returned."
          />
          <DistributionTable
            title="By Category"
            rows={byCategory}
            empty="No incidents in the rows fetched."
          />

          <div role="note" style={noteStyle}>
            <StatusPill label="Route gap" tone="neutral" />
            <span>
              Real 7/30/90/365-day metrics belong in an M33 report over `SafetyMetricsProvider`,
              where denominators and suppression can come from the backend.
            </span>
          </div>
        </div>
      }
      fullPageScroll
    />
  );
}

function MetricRow({
  label,
  value,
  source,
}: {
  label: string;
  value: number;
  source: string;
}): JSX.Element {
  return (
    <tr style={rowStyle}>
      <td style={tdStyle}>{label}</td>
      <td style={tdNumStyle}>{value}</td>
      <td style={tdStyle}>{source}</td>
    </tr>
  );
}

function DistributionTable({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: { key: string; label: string; value: number }[];
  empty: string;
}): JSX.Element {
  return (
    <section style={sectionStyle}>
      <div style={toolbarTitleStyle}>
        <span style={toolbarEyebrowStyle}>Fetched rows</span>
        <strong>{title}</strong>
      </div>
      {rows.length === 0 ? (
        <span style={secondaryTextStyle}>{empty}</span>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={headerRowStyle}>
              <th style={thStyle}>Name</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Rows</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} style={rowStyle}>
                <td style={tdStyle}>{row.label}</td>
                <td style={tdNumStyle}>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const actionGroupStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "0.5rem",
};
const linkButtonStyle = {
  minHeight: "2.25rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  fontWeight: 600,
  textDecoration: "none",
};
const filterShellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const contentStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "1rem",
  padding: "0 1.5rem 1.5rem",
};
const sectionStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
};
const sectionHeaderStyle = {
  display: "flex",
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
const tdNumStyle = {
  ...tdStyle,
  textAlign: "right" as const,
  fontVariantNumeric: "tabular-nums",
};
const secondaryTextStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const noteStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
};
