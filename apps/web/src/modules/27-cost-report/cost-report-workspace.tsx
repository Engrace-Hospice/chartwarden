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
// apps/web/src/modules/27-cost-report — the COST REPORT WORKSPACE (R2, §5.1 cost-report workbench). Pick a
// report → its lifecycle state, the filing-deadline countdown, the latest validation roll-up, and the
// realigned Form CMS-1984-14 worksheet navigation (A → B/B-1 → C per-diem; no D/E-1/G/H). Read-only nav
// surface — the server is the only authz point (ADR-0030). Lantern: WorkQueueLayout + worksheet grid.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { ReportPicker, sectionTitle, useReportPicker } from "./cost-report-shared";
import {
  STATE_TONE,
  TIER_TONE,
  WORKSHEET_NAV,
  daysUntil,
  humanize,
  shortDate,
  toneOf,
} from "./cost-report-status";

interface Detail {
  state: string;
  fiscalYearEndDate: string;
  reopenCount: number;
  complianceWindow: {
    currentEffectiveDeadlineDate: string;
    lastAlertTier: string;
    closedAt: string | null;
  } | null;
  latestValidation: {
    status: string;
    passedCount: number;
    failedCount: number;
    warningCount: number;
    skippedCount: number;
  } | null;
  latestSubmission: { status: string } | null;
}

const chip = (active: boolean) => ({
  display: "flex" as const,
  flexDirection: "column" as const,
  gap: "0.15rem",
  padding: "0.55rem 0.7rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-surface-container)",
  background: active ? "var(--color-surface-container)" : "var(--color-surface)",
});

export function CostReportWorkspace(): JSX.Element {
  const client = useApiClient();
  const {
    reports,
    selectedId,
    setSelectedId,
    loading: picking,
    error: pickErr,
  } = useReportPicker();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    const res = await client.GET("/api/v1/cost-reports/{id}", {
      params: { path: { id: selectedId } },
    });
    setDetail(res.error ? null : (res.data as unknown as Detail));
    setLoading(false);
  }, [client, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (picking) return <LoadingSpinner />;
  if (pickErr)
    return <EmptyState title="Unavailable" description="Cost reports could not be loaded." />;
  if (!selectedId)
    return (
      <EmptyState
        title="No cost reports"
        description="Create a cost report to open the workspace."
      />
    );

  const v = detail?.latestValidation;
  const deadline = detail?.complianceWindow?.currentEffectiveDeadlineDate ?? null;
  const dleft = daysUntil(deadline);

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Cost Report Workspace"
          breadcrumb={
            detail ? `Revenue Cycle — FYE ${shortDate(detail.fiscalYearEndDate)}` : "Revenue Cycle"
          }
          actions={
            <span style={{ display: "inline-flex", gap: "0.75rem", alignItems: "center" }}>
              <ReportPicker reports={reports} selectedId={selectedId} onChange={setSelectedId} />
              {detail ? (
                <StatusPill
                  tone={toneOf(STATE_TONE, detail.state)}
                  label={humanize(detail.state)}
                />
              ) : null}
            </span>
          }
        />
      }
      kpis={
        <KpiStrip>
          <KpiCard label="Filing deadline" value={deadline ? shortDate(deadline) : "—"} />
          <KpiCard
            label="Days remaining"
            value={dleft == null ? "—" : dleft < 0 ? `${-dleft} overdue` : String(dleft)}
          />
          <KpiCard
            label="Validation"
            value={v ? `${v.passedCount}✓ / ${v.failedCount}✗` : "Not run"}
          />
        </KpiStrip>
      }
      table={
        loading ? (
          <LoadingSpinner />
        ) : (
          <section style={{ display: "grid", gap: "1.5rem" }}>
            <div>
              <h3 style={sectionTitle}>Filing window</h3>
              {detail?.complianceWindow ? (
                <p
                  style={{
                    fontSize: "0.85rem",
                    color: "var(--color-on-surface-variant)",
                    margin: 0,
                  }}
                >
                  Effective deadline {shortDate(deadline)} ·{" "}
                  <StatusPill
                    tone={toneOf(TIER_TONE, detail.complianceWindow.lastAlertTier)}
                    label={humanize(detail.complianceWindow.lastAlertTier)}
                  />
                  {detail.reopenCount > 0 ? ` · reopened ×${detail.reopenCount}` : ""}
                </p>
              ) : (
                <p
                  style={{
                    fontSize: "0.85rem",
                    color: "var(--color-on-surface-variant)",
                    margin: 0,
                  }}
                >
                  No compliance window yet.
                </p>
              )}
            </div>
            <div>
              <h3 style={sectionTitle}>Worksheets (Form CMS-1984-14)</h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                  gap: "0.5rem",
                }}
              >
                {WORKSHEET_NAV.map((w) => (
                  <div key={w.code} style={chip(false)}>
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: "0.85rem",
                        color: "var(--color-on-surface)",
                      }}
                    >
                      {w.code}
                    </span>
                    <span style={{ fontSize: "0.72rem", color: "var(--color-on-surface-variant)" }}>
                      {w.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )
      }
    />
  );
}
