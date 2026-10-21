import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
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

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function MedicaidOverrideAudit(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Override[]>([]);
  const [ruleKey, setRuleKey] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
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

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return [...rows]
      .filter((r) => {
        const matchesRule = !ruleKey || r.ruleKey === ruleKey;
        const matchesSearch =
          !q ||
          [
            r.id,
            r.medicaidValidationResultId,
            r.medicaidClaimId,
            r.ruleKey,
            r.overrideRoleApplied,
            r.reason,
            r.actorMembershipId,
          ].some((value) => value.toLowerCase().includes(q));
        return matchesRule && matchesSearch;
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  }, [rows, ruleKey, searchQuery]);

  const uniqueRuleCount = new Set(rows.map((r) => r.ruleKey)).size;
  const uniqueActorCount = new Set(rows.map((r) => r.actorMembershipId)).size;
  const uniqueClaimCount = new Set(rows.map((r) => r.medicaidClaimId)).size;
  const latestOverride = rows.reduce<string | null>(
    (latest, r) => (latest === null || r.at > latest ? r.at : latest),
    null,
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filtered.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters = searchQuery !== "" || ruleKey !== "";

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Override Audit" breadcrumb="Billing — Medicaid · validation overrides">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review append-only validation overrides by rule, actor, claim, and full rationale.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Overrides"
            value={loading || error ? "—" : rows.length}
            detail="Append-only records"
            tone="warning"
            accentColor="var(--color-warning)"
          />
          <KpiCard
            label="Rules"
            value={loading || error ? "—" : uniqueRuleCount}
            detail="Distinct overridden"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Claims"
            value={loading || error ? "—" : uniqueClaimCount}
            detail="Touched by overrides"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
          <KpiCard
            label="Actors"
            value={loading || error ? "—" : uniqueActorCount}
            detail="Memberships involved"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
          <KpiCard
            label="Latest"
            value={loading || error || !latestOverride ? "—" : latestOverride.slice(0, 10)}
            detail="Most recent override"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
        </KpiStrip>
      }
      filters={
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            padding: "0 1.5rem 0.75rem",
          }}
        >
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{error}</span>
            </div>
          ) : null}
          <FilterRow>
            <label className="wx-search-field">
              <Glyph name="search" size={16} />
              <input
                type="search"
                placeholder="Search rule, claim, actor, rationale..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search override audit"
              />
            </label>
            <SelectFilter
              label="Rule"
              value={ruleKey}
              options={ruleOptions}
              onChange={(next) => {
                setRuleKey(next);
                setPage(1);
              }}
            />
            {hasActiveFilters ? (
              <Button
                size="sm"
                tone="tertiary"
                onClick={() => {
                  setSearchQuery("");
                  setRuleKey("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {filtered.length} of {rows.length} overrides
            </span>
          </FilterRow>
        </div>
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
              description={
                hasActiveFilters
                  ? "No validation override matches these filters."
                  : "No validation rule has been overridden in this organization."
              }
              action={
                hasActiveFilters ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => {
                      setSearchQuery("");
                      setRuleKey("");
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={th}>Applied</th>
                  <th style={th}>Rule</th>
                  <th style={th}>Acting role</th>
                  <th style={th}>Actor</th>
                  <th style={th}>Claim</th>
                  <th style={{ ...th, width: "34%" }}>Rationale</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((o) => (
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
                      <a
                        href={`/medicaid/billing/claims/${o.medicaidClaimId}`}
                        style={linkMonoStyle}
                      >
                        {shortId(o.medicaidClaimId)}
                      </a>
                    </td>
                    <td style={{ ...td, maxWidth: "30rem", whiteSpace: "pre-wrap" }}>{o.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(next) => {
                setPageSize(next);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="overrides"
            />
          </div>
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

const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
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
  gap: "0.5rem",
};
