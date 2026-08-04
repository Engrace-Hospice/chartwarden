import {
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/26-cap — M26, the CAP WATCH DASHBOARD (R2, §5.1.1). The primary surface for billing
// managers + compliance officers: the current cap period, the agency-aggregate + inpatient utilization bands,
// the top patients by utilization, and the recent threshold-event feed. Reads are org-scoped server-side
// (RLS); the server is the only authz point (ADR-0030) — this gates nav visibility only. Lantern:
// WorkQueueLayout + KpiStrip + No-Line tables + §6.6 StatusPill via cap-status.ts; CSS-var tokens only. The
// "what-if" projection is advisory (D14: cap projection NEVER blocks clinical service).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { BAND_TONE, humanize, money, pct, shortDate, toneOf } from "./cap-status";

interface Projection {
  alertBand: string;
  paidYtdCents: number;
  projectedYearEndCents: number;
  capAmountCents: number | null;
  pctOfCap: number;
  inpatientDaysYtd: number | null;
  patientId: string | null;
}
interface EventRow {
  id: string;
  scope: string;
  priorBand: string;
  currentBand: string;
  raisedAt: string;
  acknowledgedAt: string | null;
}
interface Dashboard {
  period: { capYear: string; status: string; methodology: string | null; endDate: string } | null;
  agency: Projection | null;
  inpatient: Projection | null;
  topPatients: Projection[];
  recentEvents: EventRow[];
  openVarianceCount: number;
}

const cellStyle = {
  padding: "0.55rem 0.75rem",
  textAlign: "left" as const,
  verticalAlign: "middle" as const,
};
const headStyle = {
  ...cellStyle,
  fontSize: "0.72rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--color-on-surface-variant)",
  fontWeight: 600,
};
const rowStyle = { borderTop: "1px solid var(--color-surface-container)" };
const numStyle = {
  ...cellStyle,
  textAlign: "right" as const,
  fontVariantNumeric: "tabular-nums" as const,
};

export function CapDashboard(): JSX.Element {
  const client = useApiClient();
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/cap/dashboard");
    if (res.error) {
      setError(
        "Cap watch is unavailable — you may lack cap visibility, or no cap period is open yet.",
      );
      setLoading(false);
      return;
    }
    setData(res.data as unknown as Dashboard);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!data?.period)
    return (
      <EmptyState
        title="No open cap period"
        description="Open a cap period to begin tracking the aggregate and inpatient caps."
      />
    );

  const { period, agency, inpatient } = data;

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Cap Watch"
          breadcrumb={`Revenue Cycle — ${period.capYear} · ${humanize(period.methodology) ?? "methodology unset"}`}
          actions={
            <StatusPill
              tone={toneOf(
                {
                  open: "progress",
                  active: "progress",
                  in_settlement: "warning",
                  settled: "neutral",
                  reopened: "warning",
                },
                period.status,
              )}
              label={humanize(period.status)}
            />
          }
        />
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label={`Agency utilization (${agency ? humanize(agency.alertBand) : "—"})`}
            value={agency ? pct(agency.pctOfCap) : "—"}
          />
          <KpiCard
            label={`Inpatient cap (${inpatient ? humanize(inpatient.alertBand) : "—"})`}
            value={inpatient ? pct(inpatient.pctOfCap) : "—"}
          />
          <KpiCard label="Open PS&R variances" value={String(data.openVarianceCount)} />
        </KpiStrip>
      }
      table={
        <section style={{ display: "grid", gap: "1.5rem" }}>
          <div>
            <h3
              style={{
                fontSize: "0.85rem",
                margin: "0 0 0.5rem",
                color: "var(--color-on-surface)",
              }}
            >
              Patients on the watch
            </h3>
            {data.topPatients.length === 0 ? (
              <EmptyState
                title="No patients near cap"
                description="No patient is projected near the per-beneficiary cap."
              />
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                <thead>
                  <tr>
                    <th style={headStyle}>Patient</th>
                    <th style={headStyle}>Band</th>
                    <th style={{ ...headStyle, textAlign: "right" }}>Paid YTD</th>
                    <th style={{ ...headStyle, textAlign: "right" }}>Allocated cap</th>
                    <th style={{ ...headStyle, textAlign: "right" }}>Utilization</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topPatients.map((p) => (
                    <tr key={p.patientId ?? Math.random()} style={rowStyle}>
                      <td style={{ ...cellStyle, fontVariantNumeric: "tabular-nums" }}>
                        {p.patientId?.slice(0, 8) ?? "—"}
                      </td>
                      <td style={cellStyle}>
                        <StatusPill
                          tone={toneOf(BAND_TONE, p.alertBand)}
                          label={humanize(p.alertBand)}
                        />
                      </td>
                      <td style={numStyle}>{money(p.paidYtdCents)}</td>
                      <td style={numStyle}>{money(p.capAmountCents)}</td>
                      <td style={numStyle}>{pct(p.pctOfCap)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div>
            <h3
              style={{
                fontSize: "0.85rem",
                margin: "0 0 0.5rem",
                color: "var(--color-on-surface)",
              }}
            >
              Recent threshold events
            </h3>
            {data.recentEvents.length === 0 ? (
              <EmptyState
                title="No recent events"
                description="No band transitions in the last 14 days."
              />
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                <thead>
                  <tr>
                    <th style={headStyle}>Scope</th>
                    <th style={headStyle}>Transition</th>
                    <th style={headStyle}>Raised</th>
                    <th style={headStyle}>State</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentEvents.map((e) => (
                    <tr key={e.id} style={rowStyle}>
                      <td style={cellStyle}>{humanize(e.scope)}</td>
                      <td style={cellStyle}>
                        <StatusPill
                          tone={toneOf(BAND_TONE, e.currentBand)}
                          label={`${humanize(e.priorBand)} → ${humanize(e.currentBand)}`}
                        />
                      </td>
                      <td style={cellStyle}>{shortDate(e.raisedAt)}</td>
                      <td style={cellStyle}>
                        {e.acknowledgedAt ? "Acknowledged" : "Unacknowledged"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      }
    />
  );
}
