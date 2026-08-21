import {
  Button,
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the OVERRIDE AUDIT (R2, §5.1 #20 /
// §4.6 `billing.validation.read_override`). The compliance read-out of every validation-override applied
// across the org's claims: which rule was overridden, by whom (membership), the role applied, the recorded
// reason, and when. There is no single org-wide override route — overrides hang off a claim's validation
// runs — so this surface composes the audit CLIENT-SIDE from the existing typed reads:
//   GET /api/v1/billing/claims                              → the org's claims (the page anchor) — REQUIRED.
//   GET /api/v1/claims/{id}/validation-runs                 → each claim's runs (most recent first).
//   GET /api/v1/claims/{id}/validation-runs/{runId}         → a run's per-rule results + override status.
// Fan-out is bounded to the first claims page and to runs whose outcome is `overridden`, so only runs that
// actually carry an override are expanded. Every read is org-scoped server-side (RLS); the server is the only
// authz point (ADR-0030) — a 503 on the anchor degrades the whole surface, a per-claim error simply omits
// that claim's overrides (degraded marker). Overrides hold NO PHI (rule key / membership / reason / time),
// so a CSV export of the visible rows is offered. Lantern: WorkQueueLayout + FilterBar, No-Line table (§6.7),
// mono identifiers, tabular-nums, CSS-var tokens only; tones resolve through billing-status.ts (§6.6).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { statusLabel, validationSeverityTone } from "./billing-status";

interface ClaimSummary {
  claimId: string;
  claimControlNumber: string;
}

interface ClaimPage {
  items: ClaimSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface ValidationRunView {
  validationRunId: string;
  outcome: string;
}

interface ValidationOverrideView {
  overrideId: string;
  overrideMembershipId: string;
  overrideRoleApplied: string;
  reason: string;
  appliedAt: string;
}

interface ValidationResultView {
  resultId: string;
  ruleKey: string;
  severity: string;
  overridden: boolean;
  override: ValidationOverrideView | null;
}

interface ValidationRunDetailView extends ValidationRunView {
  results: ValidationResultView[];
}

// One flattened audit row — a single applied override, keyed back to its claim. No PHI.
interface OverrideRow {
  claimId: string;
  claimControlNumber: string;
  ruleKey: string;
  severity: string;
  overrideRoleApplied: string;
  overrideMembershipId: string;
  reason: string;
  appliedAt: string;
}

// The claims list query is marked `never` in openapi (route query schema isn't emitted); build + cast it.
function claimsInit(cursor: string | null): unknown {
  const query: Record<string, string | number> = { limit: 50 };
  if (cursor) query.cursor = cursor;
  return { params: { query } };
}

function toCsv(rows: OverrideRow[]): string {
  const head = [
    "Claim control #",
    "Rule key",
    "Severity",
    "Override role",
    "Actor membership",
    "Reason",
    "Applied at",
  ];
  const esc = (v: string): string => `"${v.replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      r.claimControlNumber,
      r.ruleKey,
      r.severity,
      r.overrideRoleApplied,
      r.overrideMembershipId,
      r.reason,
      r.appliedAt,
    ]
      .map((c) => esc(String(c)))
      .join(","),
  );
  return [head.map(esc).join(","), ...lines].join("\r\n");
}

export function OverrideAudit(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<OverrideRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [ruleFilter, setRuleFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDegraded(false);
    const claimsRes = await client.GET("/api/v1/billing/claims", claimsInit(null) as never);
    if (claimsRes.error) {
      setError(
        "Override audit unavailable — the billing read seam is not bound, or you lack scope.",
      );
      setLoading(false);
      return;
    }
    const claims = ((claimsRes.data as unknown as ClaimPage)?.items ?? []) as ClaimSummary[];
    let anyDegraded = false;
    // Per claim, list its runs; only runs whose outcome is `overridden` can carry an applied override.
    const perClaim = await Promise.all(
      claims.map(async (claim) => {
        const runRes = await client.GET("/api/v1/claims/{id}/validation-runs", {
          params: { path: { id: claim.claimId } },
        });
        if (runRes.error) {
          anyDegraded = true;
          return [] as OverrideRow[];
        }
        const runs = (
          (runRes.data as unknown as { runs?: ValidationRunView[] })?.runs ?? []
        ).filter((r) => r.outcome === "overridden");
        const perRun = await Promise.all(
          runs.map(async (run) => {
            const detailRes = await client.GET("/api/v1/claims/{id}/validation-runs/{runId}", {
              params: { path: { id: claim.claimId, runId: run.validationRunId } },
            });
            if (detailRes.error) {
              anyDegraded = true;
              return [] as OverrideRow[];
            }
            const detail = detailRes.data as unknown as ValidationRunDetailView;
            return (detail?.results ?? [])
              .filter((res): res is ValidationResultView & { override: ValidationOverrideView } =>
                Boolean(res.override),
              )
              .map<OverrideRow>((res) => ({
                claimId: claim.claimId,
                claimControlNumber: claim.claimControlNumber,
                ruleKey: res.ruleKey,
                severity: res.severity,
                overrideRoleApplied: res.override.overrideRoleApplied,
                overrideMembershipId: res.override.overrideMembershipId,
                reason: res.override.reason,
                appliedAt: res.override.appliedAt,
              }));
          }),
        );
        return perRun.flat();
      }),
    );
    const flat = perClaim.flat().sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
    setRows(flat);
    setDegraded(anyDegraded);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (ruleFilter === "" || r.ruleKey.toLowerCase().includes(ruleFilter.toLowerCase())) &&
          (severityFilter === "" || r.severity === severityFilter),
      ),
    [rows, ruleFilter, severityFilter],
  );

  const exportCsv = useCallback(() => {
    const blob = new Blob([toCsv(filtered)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `billing-override-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered]);

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Override Audit"
          breadcrumb="Billing — Medicare"
          actions={
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
                Refresh
              </Button>
              <Button
                type="button"
                tone="secondary"
                onClick={exportCsv}
                disabled={filtered.length === 0}
              >
                Export CSV
              </Button>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review validation overrides composed from claim validation runs in your current scope.
          </div>
        </PageHeader>
      }
      filters={
        <FilterBar>
          <input
            aria-label="Filter by rule key"
            placeholder="Rule key…"
            value={ruleFilter}
            onChange={(e) => setRuleFilter(e.target.value)}
            style={inputStyle}
          />
          <select
            aria-label="Filter by severity"
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            style={selectStyle}
          >
            <option value="">All severities</option>
            <option value="error">Error</option>
            <option value="warn">Warn</option>
            <option value="info">Info</option>
          </select>
          {degraded ? (
            <output
              style={{
                alignSelf: "center",
                fontSize: "0.8rem",
                color: "var(--color-on-surface-variant)",
              }}
            >
              Some claims could not be read — the audit is partial.
            </output>
          ) : null}
        </FilterBar>
      }
      table={
        loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No overrides"
              description="No validation overrides match the current filters in your scope."
            />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <OverrideTable rows={filtered} />
          </div>
        )
      }
      detail={
        <div style={detailStyle}>
          <section style={railSectionStyle}>
            <h3 style={railTitleStyle}>Audit Source</h3>
            <p style={railTextStyle}>
              There is no org-wide override endpoint yet. This page reads the first claims page,
              then expands overridden validation runs from the server.
            </p>
          </section>
          <section style={railSectionStyle}>
            <h3 style={railTitleStyle}>Export</h3>
            <p style={railTextStyle}>
              CSV export contains only the visible filtered rows: claim control number, rule, actor
              membership, reason, and timestamp.
            </p>
          </section>
        </div>
      }
      fullPageScroll
    />
  );
}

// ── No-Line override table (§6.7) — tonal zebra, mono identifiers, tabular timestamps ─────────────────
function OverrideTable({ rows }: { rows: OverrideRow[] }): JSX.Element {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
      <caption
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
        }}
      >
        Org-wide validation overrides
      </caption>
      <thead>
        <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
          <th style={thStyle} scope="col">
            Claim control #
          </th>
          <th style={thStyle} scope="col">
            Rule key
          </th>
          <th style={thStyle} scope="col">
            Severity
          </th>
          <th style={thStyle} scope="col">
            Override role
          </th>
          <th style={thStyle} scope="col">
            Actor
          </th>
          <th style={thStyle} scope="col">
            Reason
          </th>
          <th style={{ ...thStyle, textAlign: "right" }} scope="col">
            Applied
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr
            key={`${r.claimId}-${r.ruleKey}-${r.appliedAt}`}
            style={{ background: i % 2 === 1 ? "var(--color-surface-low)" : "transparent" }}
          >
            <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>{r.claimControlNumber}</td>
            <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>{r.ruleKey}</td>
            <td style={tdStyle}>
              <StatusPill
                label={statusLabel(r.severity)}
                tone={validationSeverityTone(r.severity)}
              />
            </td>
            <td style={tdStyle}>{statusLabel(r.overrideRoleApplied)}</td>
            <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>{r.overrideMembershipId}</td>
            <td style={{ ...tdStyle, maxWidth: "22rem" }}>{r.reason}</td>
            <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {new Date(r.appliedAt).toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const tableWrapStyle = {
  minWidth: 0,
};

const detailStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
} as const;

const railSectionStyle = {
  padding: "1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
} as const;

const railTitleStyle = {
  margin: "0 0 0.5rem",
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
} as const;

const railTextStyle = {
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
} as const;

const thStyle = {
  padding: "0.5rem 0.75rem",
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
const tdStyle = { padding: "0.5rem 0.75rem", color: "var(--color-on-surface)" };
const selectStyle = {
  padding: "0.35rem 0.5rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};
const inputStyle = { ...selectStyle, minWidth: "12rem" };
