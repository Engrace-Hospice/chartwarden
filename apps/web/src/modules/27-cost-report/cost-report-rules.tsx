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
// apps/web/src/modules/27-cost-report — the VALIDATION RULE LIBRARY (R2, §5 / §11.B / D21). The platform-
// default + tenant-extension rule catalog (org-NULL platform floor a tenant layers tightenings onto). A
// collection surface (`/cost-report-validation-rules`); read-only — the server is the only authz point.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { cellStyle, headStyle, rowStyle, tableStyle } from "./cost-report-shared";
import { SEVERITY_TONE, humanize, toneOf } from "./cost-report-status";

interface RuleRow {
  ruleId: string;
  organizationId: string | null;
  ruleCode: string;
  category: string;
  description: string;
  regulatoryRequired: boolean;
  severity: string;
  status: string;
  macJurisdictionScope: string;
}

export function CostReportRules(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<RuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const res = await client.GET("/api/v1/cost-report-validation-rules");
    if (res.error) {
      setError(true);
      setLoading(false);
      return;
    }
    const d = res.data as unknown as { items?: RuleRow[] };
    setRows(d.items ?? (res.data as unknown as RuleRow[]) ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const platform = rows.filter((r) => r.organizationId === null).length;
    const required = rows.filter((r) => r.regulatoryRequired).length;
    return { platform, tenant: rows.length - platform, required };
  }, [rows]);

  if (loading) return <LoadingSpinner />;
  if (error)
    return (
      <EmptyState
        title="Unavailable"
        description="The validation rule library could not be loaded."
      />
    );

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Validation Rules"
          breadcrumb="Revenue Cycle — pre-submission rule library (§11.B)"
        />
      }
      kpis={
        <KpiStrip>
          <KpiCard label="Platform defaults" value={String(stats.platform)} />
          <KpiCard label="Tenant extensions" value={String(stats.tenant)} />
          <KpiCard label="Regulatory-required" value={String(stats.required)} />
        </KpiStrip>
      }
      table={
        rows.length === 0 ? (
          <EmptyState title="No rules" description="No validation rules are registered." />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={headStyle}>Rule code</th>
                <th style={headStyle}>Category</th>
                <th style={headStyle}>Severity</th>
                <th style={headStyle}>Scope</th>
                <th style={headStyle}>Source</th>
                <th style={headStyle}>Required</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ruleId} style={rowStyle}>
                  <td style={{ ...cellStyle, fontVariantNumeric: "tabular-nums" }}>{r.ruleCode}</td>
                  <td style={cellStyle}>{humanize(r.category)}</td>
                  <td style={cellStyle}>
                    <StatusPill
                      tone={toneOf(SEVERITY_TONE, r.severity)}
                      label={humanize(r.severity)}
                    />
                  </td>
                  <td style={cellStyle}>{r.macJurisdictionScope}</td>
                  <td style={cellStyle}>{r.organizationId === null ? "Platform" : "Tenant"}</td>
                  <td style={cellStyle}>{r.regulatoryRequired ? "Yes" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}
