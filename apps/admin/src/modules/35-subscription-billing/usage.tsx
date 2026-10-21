import { Button, StatusPill, TextField, useApiClient, useRequestGuard } from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Tenant usage drill-down (`/admin/usage/:organizationId`,
// usage.admin.read). The meter-by-meter current-period usage for one tenant over GET
// /api/admin/usage/:organizationId/current, with used / included / overage and the projected overage cost.
// An org-id box lets an operator retarget without leaving the screen.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { cap, formatCents, formatDate, usageThresholdTone } from "./status";
import { StateEmpty, StateError, StateLoading } from "./ui";

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

  const guard = useRequestGuard();
  const load = useCallback(async () => {
    const isCurrent = guard();
    if (!organizationId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/admin/usage/{organizationId}/current", {
      params: { path: { organizationId } },
    });
    if (!isCurrent()) return;
    if (res.error) {
      setError("Usage unavailable for this organization.");
      setLoading(false);
      return;
    }
    setUsage(res.data);
    setLoading(false);
  }, [client, organizationId, guard]);

  useEffect(() => {
    void load();
  }, [load]);

  const view = (e: FormEvent): void => {
    e.preventDefault();
    if (orgInput.trim()) navigate(`/admin/usage/${orgInput.trim()}`);
  };

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Tenant usage</h1>
            <p>One tenant's metered usage for the current billing period.</p>
          </div>
        </header>
        <form className="flex max-w-xl items-end gap-2" onSubmit={view}>
          <div className="min-w-0 flex-1">
            <TextField
              label="Organization id"
              value={orgInput}
              onChange={(e) => setOrgInput(e.target.value)}
              placeholder="Organization id"
            />
          </div>
          <Button type="submit" disabled={!orgInput.trim()}>
            View
          </Button>
        </form>
        {!organizationId ? (
          <StateEmpty icon="search">
            Enter an organization id above to see its current-period usage.
          </StateEmpty>
        ) : loading ? (
          <StateLoading label="Loading usage…" />
        ) : error || !usage ? (
          <StateError message={error ?? "No usage."} onRetry={() => void load()} />
        ) : (
          <>
            <p className="wx-source-line wx-nums">
              Current period: {formatDate(usage.periodStart)} — {formatDate(usage.periodEnd)}
            </p>
            {usage.meters.length === 0 ? (
              <StateEmpty icon="bar-chart">
                This tenant has no metered usage this period.
              </StateEmpty>
            ) : (
              <UsageTable meters={usage.meters} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function UsageTable({ meters }: { meters: UsageCurrent["meters"] }): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table wx-list-table-static">
        <caption className="wx-sr-only">Usage this period</caption>
        <thead>
          <tr>
            <th scope="col">Meter</th>
            <th scope="col" className="wx-num-col">
              Used
            </th>
            <th scope="col" className="wx-num-col">
              Included
            </th>
            <th scope="col" className="wx-num-col">
              Overage
            </th>
            <th scope="col" className="wx-num-col">
              $/unit
            </th>
            <th scope="col" className="wx-num-col">
              Proj. cost
            </th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {meters.map((m) => (
            <tr key={m.eventType}>
              <td>
                <span className="wx-row-title">{m.label}</span>
              </td>
              <td className="wx-num-col wx-nums">{m.totalQuantity.toLocaleString()}</td>
              <td className="wx-num-col wx-nums">{m.inclusiveQuantity.toLocaleString()}</td>
              <td className="wx-num-col wx-nums">{m.overageQuantity.toLocaleString()}</td>
              <td className="wx-num-col wx-nums">{formatCents(m.overageUnitPriceCents)}</td>
              <td className="wx-num-col wx-nums">{formatCents(m.projectedOverageCostCents)}</td>
              <td>
                <StatusPill
                  label={cap(m.thresholdState)}
                  tone={usageThresholdTone(m.thresholdState)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
