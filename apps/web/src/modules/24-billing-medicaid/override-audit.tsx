import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the OVERRIDE AUDIT VIEW (R2, §5.1 #17). The compliance /
// surveyor read of every validation override applied in the organization: actor, claimed role, rule key,
// full rationale, and the claim it unblocked. This is the surface a surveyor asks for, so nothing is
// summarised away — the rationale renders in full, and rules can be filtered to the ones that recur.
// Backed by GET /api/v1/medicaid-validation-overrides. Read-only by construction (there is no un-override;
// the audit trail is append-only). Lantern: WorkQueueLayout + No-Line table (§6.7); CSS-var tokens only.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { humanize, shortId } from "./medicaid-status";
import {
  FilterRow,
  SelectFilter,
  linkMonoStyle,
  mutedStyle,
  rowLine,
  tableStyle,
  td,
  tdMono,
  th,
} from "./medicaid-ui";

interface Override {
  id: string;
  medicaidValidationResultId: string;
  medicaidClaimId: string;
  ruleKey: string;
  overrideRoleApplied: string;
  reason: string;
  actorMembershipId: string;
  at: string;
}

export function MedicaidOverrideAudit(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Override[]>([]);
  const [ruleKey, setRuleKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/medicaid-validation-overrides", {});
    if (res.error) {
      setError("The override history is unavailable — this surface requires compliance access.");
      setLoading(false);
      return;
    }
    setRows((res.data as unknown as Override[]) ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const ruleOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.ruleKey, (counts.get(r.ruleKey) ?? 0) + 1);
    return [
      { value: "", label: "All rules" },
      ...[...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, n]) => ({ value: key, label: `${key} (${n})` })),
    ];
  }, [rows]);

  const filtered = useMemo(
    () =>
      [...(ruleKey ? rows.filter((r) => r.ruleKey === ruleKey) : rows)].sort((a, b) =>
        b.at.localeCompare(a.at),
      ),
    [rows, ruleKey],
  );

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Override Audit" breadcrumb="Billing — Medicaid · validation overrides" />
      }
      filters={
        <FilterRow>
          <SelectFilter label="Rule" value={ruleKey} options={ruleOptions} onChange={setRuleKey} />
          <span style={mutedStyle}>
            {filtered.length} override{filtered.length === 1 ? "" : "s"} shown
          </span>
        </FilterRow>
      }
      table={
        filtered.length === 0 ? (
          <EmptyState
            title="No overrides"
            description="No validation rule has been overridden in this organization."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Applied</th>
                <th style={th}>Rule</th>
                <th style={th}>Acting role</th>
                <th style={th}>Actor</th>
                <th style={th}>Claim</th>
                <th style={th}>Rationale</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr key={o.id} style={rowLine}>
                  <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                    {o.at.slice(0, 16).replace("T", " ")}
                  </td>
                  <td style={tdMono}>{o.ruleKey}</td>
                  <td style={td}>
                    <StatusPill label={humanize(o.overrideRoleApplied)} tone="warning" />
                  </td>
                  <td style={tdMono}>{shortId(o.actorMembershipId)}</td>
                  <td style={td}>
                    <a href={`/medicaid/billing/claims/${o.medicaidClaimId}`} style={linkMonoStyle}>
                      {shortId(o.medicaidClaimId)}
                    </a>
                  </td>
                  <td style={{ ...td, maxWidth: "30rem", whiteSpace: "pre-wrap" }}>{o.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
      detail={
        <span style={mutedStyle}>
          Overrides are append-only. A rule that recurs here is a candidate for an upstream fix, not
          a standing exception.
        </span>
      }
    />
  );
}
