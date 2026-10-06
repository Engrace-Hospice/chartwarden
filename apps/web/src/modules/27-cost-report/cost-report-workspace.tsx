import {
  EmptyState,
  Glyph,
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
// realigned Form CMS-1984-14 worksheet navigation (A → B/B-1 → C per-diem; no D/E-1/G/H). Nav surface plus the
// GAP-082 write actions (cost-report-actions.tsx) — the server is the only authz point (ADR-0030). Lantern: WorkQueueLayout + worksheet grid.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { CostReportActions } from "./cost-report-actions";
import {
  ReportPicker,
  cellStyle,
  headStyle,
  numStyle,
  sectionTitle,
  tableStyle,
  useReportPicker,
} from "./cost-report-shared";
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
    validationId?: string;
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
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    setDetailError(null);
    const res = await client.GET("/api/v1/cost-reports/{id}", {
      params: { path: { id: selectedId } },
    });
    if (res.error) {
      setDetail(null);
      setDetailError("Cost report details could not be loaded.");
      setLoading(false);
      return;
    }
    setDetail(res.data as unknown as Detail);
    setLoading(false);
  }, [client, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedReport = useMemo(
    () => reports.find((report) => report.costReportId === selectedId) ?? null,
    [reports, selectedId],
  );
  const v = detail?.latestValidation;
  const deadline = detail?.complianceWindow?.currentEffectiveDeadlineDate ?? null;
  const dleft = daysUntil(deadline);

  return (
    <WorkQueueLayout
      fullPageScroll
      header={
        <PageHeader
          title="Cost Report Workspace"
          breadcrumb={
            detail ? `Revenue Cycle — FYE ${shortDate(detail.fiscalYearEndDate)}` : "Revenue Cycle"
          }
          actions={
            <span style={{ display: "inline-flex", alignItems: "center" }}>
              {detail ? (
                <StatusPill
                  tone={toneOf(STATE_TONE, detail.state)}
                  label={humanize(detail.state)}
                />
              ) : null}
            </span>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review deadline posture, latest validation results, submission state, and the
            CMS-1984-14 worksheet map for the selected report.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Filing deadline"
            value={picking || detailError ? "—" : deadline ? shortDate(deadline) : "—"}
            detail={
              selectedReport
                ? `FYE ${shortDate(selectedReport.fiscalYearEndDate)}`
                : "No report selected"
            }
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Days remaining"
            value={
              picking || detailError || dleft == null
                ? "—"
                : dleft < 0
                  ? `${-dleft} overdue`
                  : String(dleft)
            }
            detail={dleft == null || dleft >= 0 ? "Compliance clock" : "Past effective deadline"}
            tone={
              dleft != null && dleft < 0
                ? "danger"
                : dleft != null && dleft <= 30
                  ? "warning"
                  : "neutral"
            }
            accentColor={
              dleft != null && dleft < 0
                ? "var(--color-error)"
                : dleft != null && dleft <= 30
                  ? "var(--color-warning)"
                  : "var(--color-outline-variant)"
            }
          />
          <KpiCard
            label="Validation"
            value={
              picking || detailError ? "—" : v ? `${v.passedCount}✓ / ${v.failedCount}✗` : "Not run"
            }
            detail={v ? `${v.warningCount} warnings, ${v.skippedCount} skipped` : "Latest roll-up"}
            tone={v && v.failedCount > 0 ? "danger" : v ? "success" : "neutral"}
            accentColor={
              v && v.failedCount > 0
                ? "var(--color-error)"
                : v
                  ? "var(--color-success)"
                  : "var(--color-outline-variant)"
            }
          />
          <KpiCard
            label="Reopens"
            value={picking || detailError ? "—" : (detail?.reopenCount ?? "—")}
            detail="Lifecycle history"
            tone={detail && detail.reopenCount > 0 ? "warning" : "neutral"}
            accentColor={
              detail && detail.reopenCount > 0
                ? "var(--color-warning)"
                : "var(--color-outline-variant)"
            }
          />
        </KpiStrip>
      }
      filters={
        <div style={filterPanelStyle}>
          {pickErr || detailError ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{pickErr ? "Cost reports could not be loaded." : detailError}</span>
            </div>
          ) : null}
          {selectedId && detail ? (
            <CostReportActions
              report={{
                id: selectedId,
                state: detail.state,
                latestValidationId: detail.latestValidation?.validationId,
              }}
              onChanged={() => void load()}
            />
          ) : null}
          <div style={filterRowStyle}>
            <ReportPicker reports={reports} selectedId={selectedId} onChange={setSelectedId} />
            <span style={mutedStyle}>
              {picking ? "Loading reports..." : `${reports.length} reports available`}
            </span>
            {selectedReport ? (
              <span style={mutedStyle}>
                Provider {selectedReport.providerEntityId.slice(0, 8)} ·{" "}
                {humanize(selectedReport.state)}
              </span>
            ) : null}
          </div>
        </div>
      }
      table={
        picking ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : pickErr ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description="Cost reports could not be loaded." />
          </div>
        ) : !selectedId ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No cost reports"
              description="Create a cost report to open the workspace."
            />
          </div>
        ) : loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : detailError ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={detailError} />
          </div>
        ) : !detail ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No report detail"
              description="Select another cost report to continue."
            />
          </div>
        ) : (
          <section style={workspaceShellStyle}>
            <div style={sectionBlockStyle}>
              <h3 style={sectionTitle}>Filing window</h3>
              <div style={{ width: "100%", overflowX: "auto" }}>
                <table style={tableStyle}>
                  <tbody>
                    <tr>
                      <th style={headStyle}>Effective deadline</th>
                      <td style={cellStyle}>{deadline ? shortDate(deadline) : "—"}</td>
                      <th style={headStyle}>Alert tier</th>
                      <td style={cellStyle}>
                        {detail.complianceWindow ? (
                          <StatusPill
                            tone={toneOf(TIER_TONE, detail.complianceWindow.lastAlertTier)}
                            label={humanize(detail.complianceWindow.lastAlertTier)}
                          />
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                    <tr>
                      <th style={headStyle}>Closed at</th>
                      <td style={cellStyle}>
                        {detail.complianceWindow?.closedAt
                          ? shortDate(detail.complianceWindow.closedAt)
                          : "Open"}
                      </td>
                      <th style={headStyle}>Reopens</th>
                      <td style={numStyle}>{detail.reopenCount}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div style={sectionBlockStyle}>
              <h3 style={sectionTitle}>Latest validation</h3>
              <div style={{ width: "100%", overflowX: "auto" }}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={headStyle}>Status</th>
                      <th style={{ ...headStyle, textAlign: "right" }}>Passed</th>
                      <th style={{ ...headStyle, textAlign: "right" }}>Failed</th>
                      <th style={{ ...headStyle, textAlign: "right" }}>Warnings</th>
                      <th style={{ ...headStyle, textAlign: "right" }}>Skipped</th>
                      <th style={headStyle}>Submission</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={cellStyle}>
                        {v ? (
                          <StatusPill
                            tone={v.failedCount > 0 ? "critical" : "success"}
                            label={humanize(v.status)}
                          />
                        ) : (
                          "Not run"
                        )}
                      </td>
                      <td style={numStyle}>{v?.passedCount ?? "—"}</td>
                      <td style={numStyle}>{v?.failedCount ?? "—"}</td>
                      <td style={numStyle}>{v?.warningCount ?? "—"}</td>
                      <td style={numStyle}>{v?.skippedCount ?? "—"}</td>
                      <td style={cellStyle}>
                        {humanize(detail.latestSubmission?.status ?? "not_submitted")}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div style={sectionBlockStyle}>
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

const filterPanelStyle: CSSProperties = {
  padding: "0 1.5rem 0.75rem",
};

const filterRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.75rem",
};

const mutedStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8125rem",
};

const errorBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  marginBottom: "0.75rem",
  padding: "0.65rem 0.75rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-error)",
  color: "var(--color-error)",
  background: "color-mix(in srgb, var(--color-error) 8%, var(--color-surface))",
  fontSize: "0.875rem",
};

const workspaceShellStyle: CSSProperties = {
  display: "grid",
  gap: "1.25rem",
  padding: "0 1.5rem 1.5rem",
};

const sectionBlockStyle: CSSProperties = {
  display: "grid",
  gap: "0.5rem",
};
