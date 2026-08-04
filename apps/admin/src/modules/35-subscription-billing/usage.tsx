import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Tenant usage drill-down (`/admin/usage/:organizationId`,
// usage.admin.read). The meter-by-meter current-period usage for one tenant over GET
// /api/admin/usage/:organizationId/current, with used / included / overage and the projected overage cost.
// An org-id box lets an operator retarget without leaving the screen.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { cap, formatCents, formatDate, usageThresholdTone } from "./status";
import {
  actionButtonStyle,
  bodyRow,
  cell,
  cellRight,
  inputStyle,
  tableStyle,
  theadRow,
} from "./ui";

type UsageCurrent =
  operations["getApiAdminUsageByOrganizationIdCurrent"]["responses"][200]["content"]["application/json"];

export function Usage(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { organizationId } = useParams<{ organizationId: string }>();
  const [orgInput, setOrgInput] = useState(organizationId ?? "");
  const [usage, setUsage] = useState<UsageCurrent | null>(null);
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!organizationId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/admin/usage/{organizationId}/current", {
      params: { path: { organizationId } },
    });
    if (res.error) {
      setError("Usage unavailable for this organization.");
      setLoading(false);
      return;
    }
    setUsage(res.data);
    setLoading(false);
  }, [client, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div
      style={{ padding: "1.5rem 1.75rem", display: "flex", flexDirection: "column", gap: "1rem" }}
    >
      <PageHeader
        title="Tenant usage"
        breadcrumb="Platform Ops"
        actions={
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input
              value={orgInput}
              onChange={(e) => setOrgInput(e.target.value)}
              placeholder="Organization id"
              style={{ ...inputStyle, width: "20rem" }}
              aria-label="Organization id"
            />
            <button
              type="button"
              onClick={() => orgInput.trim() && navigate(`/admin/usage/${orgInput.trim()}`)}
              disabled={!orgInput.trim()}
              style={actionButtonStyle(true, !orgInput.trim())}
            >
              View
            </button>
          </div>
        }
      />
      {!organizationId ? (
        <EmptyState
          title="Choose an organization"
          description="Enter an organization id above to see its current-period usage."
        />
      ) : loading ? (
        <LoadingSpinner />
      ) : error || !usage ? (
        <EmptyState title="Unavailable" description={error ?? "No usage."} />
      ) : (
        <>
          <p
            style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}
            className="tabular-nums"
          >
            Current period: {formatDate(usage.periodStart)} — {formatDate(usage.periodEnd)}
          </p>
          {usage.meters.length === 0 ? (
            <EmptyState
              title="No metered usage"
              description="This tenant has no metered usage this period."
            />
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr style={theadRow}>
                  <th style={cell}>Meter</th>
                  <th style={cellRight}>Used</th>
                  <th style={cellRight}>Included</th>
                  <th style={cellRight}>Overage</th>
                  <th style={cellRight}>$/unit</th>
                  <th style={cellRight}>Proj. cost</th>
                  <th style={cell}>State</th>
                </tr>
              </thead>
              <tbody>
                {usage.meters.map((m) => (
                  <tr key={m.eventType} style={bodyRow}>
                    <td style={cell}>{m.label}</td>
                    <td style={cellRight} className="tabular-nums">
                      {m.totalQuantity.toLocaleString()}
                    </td>
                    <td style={cellRight} className="tabular-nums">
                      {m.inclusiveQuantity.toLocaleString()}
                    </td>
                    <td style={cellRight} className="tabular-nums">
                      {m.overageQuantity.toLocaleString()}
                    </td>
                    <td style={cellRight} className="tabular-nums">
                      {formatCents(m.overageUnitPriceCents)}
                    </td>
                    <td style={cellRight} className="tabular-nums">
                      {formatCents(m.projectedOverageCostCents)}
                    </td>
                    <td style={cell}>
                      <StatusPill
                        label={cap(m.thresholdState)}
                        tone={usageThresholdTone(m.thresholdState)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
