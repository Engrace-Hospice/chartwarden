// apps/web/src/modules/16-bereavement — the SUPERVISOR CASELOAD DASHBOARD (§5.1 #2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical — "Use Dashboard."
//
// Route 31's full-tenant rollups. The server reports COUNTS, never rates, and this screen keeps them that
// way: the CoP 418.64(d) figure is rendered as the raw PAIR ("47 of 52 touchpoints completed on time")
// with the derived percentage shown ALONGSIDE it and suppressed entirely when the denominator is zero.
// A pre-divided compliance number would strand M30's CMS small-N suppression and turn an empty scope into
// a fabricated 0% that nobody downstream could suppress — the same contract the §4.6 seams publish, so a
// supervisor and an HQRP report can never be shown two different bereavement-compliance rates.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type SupervisorDashboard as SupervisorDashboardView,
  errorMessage,
  getSupervisorDashboard,
} from "./bereavement-api";
import {
  Card,
  CountGrid,
  Field,
  Notice,
  SummaryGrid,
  columnStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
} from "./bereavement-ui";
import { humanize } from "./bereavement-status";

export function BereavementSupervisorDashboard(): JSX.Element {
  const client = useApiClient();
  const [view, setView] = useState<SupervisorDashboardView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { view: v, error: err } = await getSupervisorDashboard(client);
    if (err) {
      setError(errorMessage(err, "The bereavement program rollups could not be loaded."));
      setLoading(false);
      return;
    }
    setView(v);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!view) return <EmptyState title="No data" description="No bereavement rollups were returned." />;

  const { numerator, denominator } = view.copCounts;
  const entries = (m: Record<string, number>) =>
    Object.entries(m).map(([k, v]) => ({ label: humanize(k), value: v }));

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Bereavement program</span>}
        breadcrumb="Bereavement — org-wide rollups"
        actions={
          <Link to="/bereavement/eligible" style={ghostButtonStyle}>
            Intake queue
          </Link>
        }
      />

      {view.unassignedPlanCount > 0 ? (
        <Notice tone="warning">
          {view.unassignedPlanCount === 1
            ? "One bereavement plan has no assigned counselor."
            : `${view.unassignedPlanCount} bereavement plans have no assigned counselor.`}{" "}
          <Link to="/bereavement/eligible" style={linkStyle}>
            Open the intake queue
          </Link>
        </Notice>
      ) : null}

      {view.externalSourceCosignPendingCount > 0 ? (
        <Notice tone="warning">
          {view.externalSourceCosignPendingCount === 1
            ? "One external-source plan is"
            : `${view.externalSourceCosignPendingCount} external-source plans are`}{" "}
          awaiting the platform-mandated medical-director cosign. First contact is locked on those plans.
        </Notice>
      ) : null}

      <Card title="CoP 418.64(d) — touchpoints completed on time">
        <SummaryGrid>
          <Field label="Completed on time" value={numerator} />
          <Field label="Touchpoints owed" value={denominator} />
          <Field
            label="On-time rate"
            value={
              denominator === 0 ? (
                <StatusPill label="No touchpoints owed" tone="neutral" />
              ) : (
                `${((numerator / denominator) * 100).toFixed(1)}%`
              )
            }
          />
        </SummaryGrid>
        <span style={mutedStyle}>
          Reported as a count pair. A scope with no touchpoints owed shows no rate rather than 0% — an
          undivided pair is what lets the HQRP surface apply CMS small-N suppression downstream.
        </span>
      </Card>

      <Card title="Plans by status">
        <CountGrid entries={entries(view.planCountsByStatus)} />
      </Card>

      <Card title="Touchpoints by status">
        <CountGrid entries={entries(view.outreachCountsByStatus)} />
      </Card>

      <Card title="Risk-tier distribution">
        <CountGrid entries={entries(view.tierDistribution)} />
      </Card>

      <Card title="Closures by reason">
        <CountGrid entries={entries(view.closureCountsByReason)} />
        <span style={mutedStyle}>
          Only `thirteen_month_completion` is the 13-month obligation met in full; every other reason ended
          the program early or by cascade.
        </span>
      </Card>
    </div>
  );
}
