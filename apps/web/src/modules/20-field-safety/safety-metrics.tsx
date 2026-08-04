// apps/web/src/modules/20-field-safety — §5.1 "SAFETY METRICS" (`/safety/metrics`, Track B / ADR-0030).
//
// ── §5.1 ASKS FOR TREND CHARTS OVER 7/30/90/365 DAYS. M20 PUBLISHES NO ROUTE THAT COULD DRAW ONE ─────
//
// The six figures §5.1 names — SOS volume, overdue rate, incident rate, response-time median and p95,
// after-hours SOS count, check-in compliance — all exist, and all of them live on `SafetyMetricsProvider`
// (§4.3), which is a boot-registered SEAM consumed by M30 and M33. It has no HTTP surface. §4.1's
// twenty-nine rows contain no aggregate route at all.
//
// That leaves exactly two honest options, and this screen takes the second:
//
//   1. Draw the charts from paged row data. Rejected. §4.1.1 publishes no `total_count` because a count is
//      an enumeration oracle, so any denominator here would be "rows I could read on the pages I
//      fetched". A rate over that denominator is not a smaller version of the real rate — it is a
//      different number wearing its clothes, and on a safety dashboard a flattering one.
//   2. Show what the two available reads actually answer, labelled as a census rather than a trend, and
//      name the seam a real trend needs. That is below.
//
// The one figure that IS trustworthy here is the current census, because `GET /safety/dashboard` returns
// the whole snapshot with the server's own counts computed over it. Everything derived from the incident
// LEDGER says "on the pages fetched" beside it, every time, without exception.
//
// ── WHY THE SEAM IS NOT SIMPLY CALLED FROM HERE ─────────────────────────────────────────────────────
//
// A seam is a server-side registry entry; a browser cannot resolve one. Surfacing these numbers to a
// human needs either an M20 aggregate route (a permission, an audit declaration and an RLS path that a
// screen task may not create) or an M33 report backed by the seam M20 already publishes. The second is
// the architecture's own answer and is where this should land.
import { EmptyState, LoadingSpinner, PageHeader, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
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
import {
  Card,
  CountGrid,
  Notice,
  columnStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
} from "./safety-ui";

export function SafetyMetricsScreen(): JSX.Element {
  const client = useApiClient();
  const [board, setBoard] = useState<SafetyDashboardView | null>(null);
  const [incidents, setIncidents] = useState<SafetyIncidentView[]>([]);
  const [incidentsComplete, setIncidentsComplete] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [b, i] = await Promise.all([
      getDashboard(client, {}),
      listIncidents(client, { limit: 100 }),
    ]);
    if (b.error && i.error) {
      setError(errorMessage(b.error, "Neither the safety board nor the incident ledger answered."));
      setLoading(false);
      return;
    }
    setBoard(b.board);
    setIncidents(i.page?.data ?? []);
    // `has_more === false` is the ONLY case in which the incident figures below cover everything the
    // caller may read. It is tracked so the copy can say "one page of" versus "every row you may read"
    // rather than saying the same thing in both cases.
    setIncidentsComplete(i.page !== null && !i.page.has_more);
    setError(
      b.error || i.error ? "One of the two reads did not answer; figures below are partial." : null,
    );
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (!board && incidents.length === 0)
    return (
      <EmptyState
        title="Safety metrics unavailable"
        description={error ?? "Neither underlying read answered."}
      />
    );

  const byCategory = INCIDENT_CATEGORIES.map((c) => ({
    key: c,
    n: incidents.filter((i) => i.category === c).length,
  })).filter((r) => r.n > 0);
  const bySeverity = INCIDENT_SEVERITIES.map((s) => ({
    key: s,
    n: incidents.filter((i) => i.severity === s).length,
  }));
  const osha = incidents.filter((i) => i.oshaReportable).length;
  const oshaUnsigned = incidents.filter(
    (i) => i.oshaReportable && i.oshaReportableSignedOffAt === null,
  ).length;
  const openIncidents = incidents.filter(
    (i) => !["closed_with_action_plan", "closed_no_action"].includes(i.lifecycleState),
  ).length;
  const sosLinked = incidents.filter((i) => i.linkedSosAlertId !== null).length;
  const wc = incidents.filter((i) => i.workersCompClaimInitiated).length;

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Safety metrics</span>}
        breadcrumb="Field safety"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/safety" style={ghostButtonStyle}>
              Safety board
            </Link>
            <button type="button" onClick={() => void load()} style={ghostButtonStyle}>
              Refresh
            </button>
          </div>
        }
      />

      <Notice tone="warning" live>
        <strong>These are counts, not trends, and there are no charts on this page.</strong> The six
        trend series §5.1 describes — SOS volume, overdue rate, incident rate, response-time median
        and p95, after-hours SOS count, check-in compliance — all exist on M20's{" "}
        <code>SafetyMetricsProvider</code> seam, which M30 and M33 consume server-side. It has no
        HTTP route, and §4.1 publishes no aggregate endpoint at all. Drawing a rate from the pages
        this browser happens to have fetched would produce a number that looks like the real one and
        is not; on a safety dashboard that number would always flatter. The trend surface belongs in
        an M33 report over the seam M20 already publishes.
      </Notice>

      {error ? (
        <Notice tone="warning" live>
          {error}
        </Notice>
      ) : null}

      <Card title="Census — right now">
        {board ? (
          <>
            <CountGrid
              entries={[
                { label: "Clinicians on the board", value: board.clinicians.length },
                {
                  label: "Active SOS",
                  value: board.activeSosCount,
                  tone: board.activeSosCount > 0 ? "critical" : undefined,
                },
                {
                  label: "Overdue check-ins",
                  value: board.overdueCount,
                  tone: board.overdueCount > 0 ? "error" : undefined,
                },
                {
                  label: "In a flagged area",
                  value: board.clinicians.filter((c) => c.inHighRiskArea !== null).length,
                },
                {
                  label: "GPS spoof suspected",
                  value: board.clinicians.filter((c) => c.gpsSpoofSuspected).length,
                },
                {
                  label: "No position on record",
                  value: board.clinicians.filter((c) => c.lastKnownLocation === null).length,
                },
              ]}
            />
            <span style={mutedStyle}>
              These six are trustworthy: the server computes the first three over the same snapshot
              it returns, taken at {dateTime(board.fetchedAt)}. They describe this MOMENT and say
              nothing about any other one.
            </span>
          </>
        ) : (
          <Notice tone="error" assertive>
            The board did not answer, so there is no census. Treat this as unknown rather than as
            zero.
          </Notice>
        )}
      </Card>

      <Card title="Incidents — on the rows fetched">
        <CountGrid
          entries={[
            { label: "Incidents fetched", value: incidents.length },
            {
              label: "Still open",
              value: openIncidents,
              tone: openIncidents > 0 ? "warning" : undefined,
            },
            { label: "OSHA-reportable", value: osha, tone: osha > 0 ? "critical" : undefined },
            {
              label: "Reportable, unsigned",
              value: oshaUnsigned,
              tone: oshaUnsigned > 0 ? "error" : undefined,
            },
            { label: "Opened from an SOS", value: sosLinked },
            { label: "Workers' comp initiated", value: wc },
          ]}
        />
        <Notice tone={incidentsComplete ? "info" : "warning"}>
          {incidentsComplete ? (
            <>
              These figures cover <strong>every incident row the server sent</strong> for this
              caller — the page was not truncated. They still cover only what you may read, which is
              not the same as every incident in the agency.
            </>
          ) : (
            <>
              <strong>This is one page.</strong> More incidents exist beyond it, so every figure
              above is a floor, not a total. Do not report these numbers.
            </>
          )}
        </Notice>
      </Card>

      <Card title="By severity (fetched rows)">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>Severity</th>
              <th style={thNum}>Incidents</th>
            </tr>
          </thead>
          <tbody>
            {bySeverity.map((r) => (
              <tr key={r.key} style={rowLine}>
                <td style={td}>{humanize(r.key)}</td>
                <td style={tdNum}>{r.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <span style={mutedStyle}>
          Severity is the clinician's own attestation, adjustable by a supervisor while the incident
          is under review — so this distribution is a record of what people said, not an assessment.
        </span>
      </Card>

      <Card title="By category (fetched rows)">
        {byCategory.length === 0 ? (
          <span style={mutedStyle}>No incidents in the rows fetched.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Category</th>
                <th style={thNum}>Incidents</th>
              </tr>
            </thead>
            <tbody>
              {byCategory
                .sort((a, b) => b.n - a.n)
                .map((r) => (
                  <tr key={r.key} style={rowLine}>
                    <td style={td}>{incidentCategoryLabel(r.key)}</td>
                    <td style={tdNum}>{r.n}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="What a real trend surface needs">
        <span style={mutedStyle}>
          M20 already publishes the numbers: <code>SafetyMetricsProvider</code> answers SOS
          frequency, overdue rate, incident rate, response-time median and p95, and check-in
          compliance — each <strong>with its denominator</strong>, which is the part that makes
          suppression below a reportable floor possible and back-computing impossible. What is
          missing is a way for a browser to reach it: a seam is a server-side registry entry, so
          this needs either an M20 aggregate route (a new permission, audit declaration and RLS path
          — not something a screen task may mint) or an M33 report over the seam that already
          exists. The second is the architecture's own answer.
        </span>
      </Card>
    </div>
  );
}
