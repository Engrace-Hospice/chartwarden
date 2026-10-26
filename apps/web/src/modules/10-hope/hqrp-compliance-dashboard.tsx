import {
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  type ReadStatus,
  StatusPill,
  WorkQueueLayout,
  settleRead,
  useApiClient,
  useReloadFocus,
} from "@chartwarden/ui";
// apps/web/src/modules/10-hope — HQRP compliance dashboard (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_HOPE_ENGINE.md — "Use Dashboard."
// "Are we losing the 4 points?" — four KPI cards: HOPE on-time rate, SFV on-time rate, submission
// acceptance rate, late-completion rate (1 − HOPE on-time). Rates are server-computed (ADR-0030 — no
// frontend authz). Reads GET /api/v1/hope/dashboard/compliance via the typed client. Leaves only (@chartwarden/ui).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { HopeListReadState } from "./hope-read-state";

interface RateCounts {
  onTime?: number;
  accepted?: number;
  total: number;
}

interface Compliance {
  providerEntityId: string | null;
  // #48 — nullable: `null` is "no data", which is NOT a perfect score. These used to be plain numbers
  // that the server defaulted to 1 on an empty denominator, so an agency with no closed timepoint
  // windows was shown 100% on-time on the screen it would use to decide it did not need to act.
  hopeOnTimeRate: number | null;
  hopeOnTimeCounts: RateCounts;
  sfvOnTimeRate: number | null;
  sfvOnTimeCounts: RateCounts;
  submissionAcceptanceRate: number | null;
  submissionAcceptanceCounts: RateCounts;
}

interface MetricRow {
  key: string;
  label: string;
  value: number | null;
  counts: RateCounts;
  target: number;
  detail: string;
}

export function HqrpComplianceDashboard(): JSX.Element {
  const client = useApiClient();
  const [row, setRow] = useState<Compliance | null>(null);
  const [loading, setLoading] = useState(true);
  const focusRef = useReloadFocus<HTMLDivElement>(loading);
  const [readStatus, setReadStatus] = useState<ReadStatus>("ok");

  const latestLoad = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latestLoad.current;
    setLoading(true);
    setReadStatus("ok");
    const { status, res } = await settleRead(
      client.GET("/api/v1/hope/dashboard/compliance", { params: { query: {} } }),
      "denied",
    );
    if (mine !== latestLoad.current) return;
    // An ok read with no body is a failed read, not an endless spinner.
    const data = status === "ok" ? ((res?.data as Compliance | undefined) ?? null) : null;
    setReadStatus(status === "ok" && !data ? "failed" : status);
    setRow(data);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const metrics = useMemo<MetricRow[]>(
    () =>
      row
        ? [
            {
              key: "hope_on_time",
              label: "HOPE on-time",
              value: row.hopeOnTimeRate,
              counts: row.hopeOnTimeCounts,
              target: 0.9,
              detail: "Assessments completed inside the compliance window",
            },
            {
              key: "sfv_on_time",
              label: "SFV on-time",
              value: row.sfvOnTimeRate,
              counts: row.sfvOnTimeCounts,
              target: 0.9,
              detail: "Symptom follow-up visits completed on time",
            },
            {
              key: "submission_acceptance",
              label: "Submission acceptance",
              value: row.submissionAcceptanceRate,
              counts: row.submissionAcceptanceCounts,
              target: 0.95,
              detail: "Submitted batches accepted without rejection",
            },
            {
              key: "late_completion",
              label: "Late completion",
              // Derived, so it inherits "no data" rather than reading 0% off an absent on-time rate.
              value: row.hopeOnTimeRate === null ? null : 1 - row.hopeOnTimeRate,
              counts: row.hopeOnTimeCounts,
              target: 0.1,
              detail: "Inverse of the HOPE on-time rate",
            },
          ]
        : [],
    [row],
  );

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="HQRP Compliance" breadcrumb="Clinical Quality / HOPE">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Monitor the HOPE and SFV compliance rates that feed HQRP reporting posture.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="HOPE on-time"
            value={loading || readStatus !== "ok" || !row ? "—" : pct(row.hopeOnTimeRate)}
            detail="Assessment timing"
            tone={toneForRate(row?.hopeOnTimeRate)}
            accentColor={accentForRate(row?.hopeOnTimeRate)}
          />
          <KpiCard
            label="SFV on-time"
            value={loading || readStatus !== "ok" || !row ? "—" : pct(row.sfvOnTimeRate)}
            detail="Follow-up timing"
            tone={toneForRate(row?.sfvOnTimeRate)}
            accentColor={accentForRate(row?.sfvOnTimeRate)}
          />
          <KpiCard
            label="Submission acceptance"
            value={loading || readStatus !== "ok" || !row ? "—" : pct(row.submissionAcceptanceRate)}
            detail={<Link to="/hope/submissions">View submissions</Link>}
            tone={toneForRate(row?.submissionAcceptanceRate)}
            accentColor={accentForRate(row?.submissionAcceptanceRate)}
          />
        </KpiStrip>
      }
      filters={
        <div style={filterShellStyle}>
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Scope</span>
              <strong>
                {row?.providerEntityId ? "Selected ProviderEntity" : "Whole organization"}
              </strong>
            </div>
            {row?.providerEntityId ? (
              <code className="wx-data-md" style={codeStyle}>
                {shortId(row.providerEntityId)}
              </code>
            ) : null}
          </div>
        </div>
      }
      table={
        <div
          ref={focusRef}
          tabIndex={-1}
          // biome-ignore lint/a11y/useSemanticElements: a <fieldset> is for form controls; this names a results region.
          role="group"
          aria-label="HQRP compliance"
          aria-busy={loading}
          style={{ outline: "none" }}
        >
          {readStatus !== "ok" ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <HopeListReadState
                status={readStatus}
                subject="the agency-wide HQRP compliance dashboard"
                failedTitle="The HQRP compliance dashboard could not be loaded"
                onRetry={() => void load()}
              />
            </div>
          ) : loading || !row ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : (
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead>
                  <tr style={headerRowStyle}>
                    <th style={{ ...thStyle, width: "32%" }}>Metric</th>
                    <th style={{ ...thStyle, width: "16%" }}>Rate</th>
                    <th style={{ ...thStyle, width: "16%" }}>Target</th>
                    <th style={{ ...thStyle, width: "16%" }}>Posture</th>
                    <th style={{ ...thStyle, width: "20%" }}>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m) => {
                    const lateMetric = m.key === "late_completion";
                    // #48 — no denominator means there is nothing to be on track OR at risk about. Saying
                    // "On Track" over zero observations is the failure this screen was built to prevent.
                    const passing =
                      m.value === null
                        ? null
                        : lateMetric
                          ? m.value <= m.target
                          : m.value >= m.target;
                    return (
                      <tr key={m.key} style={rowStyle}>
                        <td style={tdStyle}>
                          <span style={primaryTextStyle}>{m.label}</span>
                        </td>
                        <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                          {pct(m.value)}
                          <span style={countsStyle}>{countsLabel(m.counts)}</span>
                        </td>
                        <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                          {lateMetric ? `<= ${pct(m.target)}` : `>= ${pct(m.target)}`}
                        </td>
                        <td style={tdStyle}>
                          <StatusPill
                            label={passing === null ? "No Data" : passing ? "On Track" : "At Risk"}
                            tone={passing === null ? "neutral" : passing ? "success" : "warning"}
                          />
                        </td>
                        <td style={tdStyle}>{m.detail}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      }
      fullPageScroll
    />
  );
}

function pct(rate: number | null | undefined): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

/** The count pair behind a rate, so a reader can see a 100% built on two observations for what it is. */
function countsLabel(counts: RateCounts | undefined): string {
  if (!counts) return "";
  const numerator = counts.onTime ?? counts.accepted ?? 0;
  return counts.total === 0 ? " no observations" : ` ${numerator} of ${counts.total}`;
}

function toneForRate(
  rate: number | null | undefined,
): "neutral" | "success" | "warning" | "danger" {
  if (rate == null) return "neutral";
  if (rate >= 0.9) return "success";
  if (rate >= 0.8) return "warning";
  return "danger";
}

function accentForRate(rate: number | null | undefined): string {
  const tone = toneForRate(rate);
  if (tone === "success") return "var(--color-success)";
  if (tone === "warning") return "var(--color-warning)";
  if (tone === "danger") return "var(--color-error)";
  return "var(--color-outline-variant)";
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

const primaryTextStyle = {
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const countsStyle = {
  marginLeft: "0.4rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};

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
