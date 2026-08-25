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
// apps/web/src/modules/10-hope — HQRP compliance dashboard (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_HOPE_ENGINE.md — "Use Dashboard."
// "Are we losing the 4 points?" — four KPI cards: HOPE on-time rate, SFV on-time rate, submission
// acceptance rate, late-completion rate (1 − HOPE on-time). Rates are server-computed (ADR-0030 — no
// frontend authz). Reads GET /api/v1/hope/dashboard/compliance via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

interface Compliance {
  providerEntityId: string | null;
  hopeOnTimeRate: number;
  sfvOnTimeRate: number;
  submissionAcceptanceRate: number;
}

interface MetricRow {
  key: string;
  label: string;
  value: number;
  target: number;
  detail: string;
}

export function HqrpComplianceDashboard(): JSX.Element {
  const client = useApiClient();
  const [row, setRow] = useState<Compliance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/hope/dashboard/compliance", {
      params: { query: {} },
    });
    if (err) {
      setError("Could not load the HQRP compliance dashboard.");
      setLoading(false);
      return;
    }
    setRow(data as Compliance);
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
              target: 0.9,
              detail: "Assessments completed inside the compliance window",
            },
            {
              key: "sfv_on_time",
              label: "SFV on-time",
              value: row.sfvOnTimeRate,
              target: 0.9,
              detail: "Symptom follow-up visits completed on time",
            },
            {
              key: "submission_acceptance",
              label: "Submission acceptance",
              value: row.submissionAcceptanceRate,
              target: 0.95,
              detail: "Submitted batches accepted without rejection",
            },
            {
              key: "late_completion",
              label: "Late completion",
              value: 1 - row.hopeOnTimeRate,
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
            value={loading || error || !row ? "—" : pct(row.hopeOnTimeRate)}
            detail="Assessment timing"
            tone={toneForRate(row?.hopeOnTimeRate)}
            accentColor={accentForRate(row?.hopeOnTimeRate)}
          />
          <KpiCard
            label="SFV on-time"
            value={loading || error || !row ? "—" : pct(row.sfvOnTimeRate)}
            detail="Follow-up timing"
            tone={toneForRate(row?.sfvOnTimeRate)}
            accentColor={accentForRate(row?.sfvOnTimeRate)}
          />
          <KpiCard
            label="Submission acceptance"
            value={loading || error || !row ? "—" : pct(row.submissionAcceptanceRate)}
            detail="Accepted batches"
            tone={toneForRate(row?.submissionAcceptanceRate)}
            accentColor={accentForRate(row?.submissionAcceptanceRate)}
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
        error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
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
                  const passing = lateMetric ? m.value <= m.target : m.value >= m.target;
                  return (
                    <tr key={m.key} style={rowStyle}>
                      <td style={tdStyle}>
                        <span style={primaryTextStyle}>{m.label}</span>
                      </td>
                      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                        {pct(m.value)}
                      </td>
                      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                        {lateMetric ? `<= ${pct(m.target)}` : `>= ${pct(m.target)}`}
                      </td>
                      <td style={tdStyle}>
                        <StatusPill
                          label={passing ? "On Track" : "At Risk"}
                          tone={passing ? "success" : "warning"}
                        />
                      </td>
                      <td style={tdStyle}>{m.detail}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      }
      fullPageScroll
    />
  );
}

function pct(rate: number | null | undefined): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
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
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};

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
};

const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};

const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};

const primaryTextStyle = {
  fontWeight: 600,
  color: "var(--color-on-surface)",
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
