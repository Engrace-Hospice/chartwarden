import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  interactiveRowProps,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the AR DASHBOARD (R2, §5.1 #1).
// The landing surface: AR aging buckets (0-30 / 31-60 / 61-90 / 90+), denial rate, NOE/NOTR filing-window
// posture, and the claim-state mix. The spec names no single aggregate route, so the dashboard is composed
// CLIENT-SIDE from the org-scoped rollup reads:
//   GET /api/v1/billing/ar-dashboard  → ArAgingDto (the four aging buckets) — REQUIRED.
//   GET /api/v1/billing/metrics       → { buckets: { key=claimState, count, amountCents }[] } — best-effort.
//   GET /api/v1/noe-records / notr-records → filing-window posture (at-risk / breached) — best-effort.
// All reads are org-scoped server-side (RLS); these are aggregate-only (no row-level PHI). The server is the
// only authz point (ADR-0030) — a 403/503 on a best-effort read simply leaves that tile absent (degraded),
// never a hard failure. Lantern: DashboardLayout + KpiStrip (Fraunces eyebrow / Inter tabular figure),
// No-Line cards, CSS-var tokens only; every status pill resolves through billing-status.ts (§6.6).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import {
  claimStateTone,
  dollars,
  statusLabel,
  windowTierLabel,
  windowTierTone,
} from "./billing-status";

interface ArAging {
  bucket0to30Cents: number;
  bucket31to60Cents: number;
  bucket61to90Cents: number;
  bucket90PlusCents: number;
}

interface MetricsBucket {
  key: string;
  count: number;
  amountCents: number;
}

interface NoticeWindowRecord {
  state: string;
  windowTargetAt: string | null;
  windowBreachedAt: string | null;
}

interface ListPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// Days remaining until a filing window closes (negative = breached). A row already flagged
// `windowBreachedAt` is breached regardless of the wall clock.
function daysRemaining(rec: NoticeWindowRecord): number {
  if (rec.windowBreachedAt) return -1;
  if (!rec.windowTargetAt) return Number.POSITIVE_INFINITY;
  return Math.floor((new Date(rec.windowTargetAt).getTime() - Date.now()) / 86_400_000);
}

type WindowPosture = { atRisk: number; breached: number; total: number };
type RowKind = "ar" | "claim" | "notice";
type RowFilter = "all" | RowKind;

interface DashboardRow {
  id: string;
  kind: RowKind;
  category: string;
  label: string;
  count: number | null;
  amountCents: number | null;
  tone: "success" | "progress" | "warning" | "error" | "critical" | "neutral";
  detail: string;
  href?: string;
}

const BILLING_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

const thStyle: CSSProperties = {
  padding: "0.625rem 0.75rem",
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const tdStyle: CSSProperties = {
  padding: "0.65rem 0.75rem",
  color: "var(--color-on-surface)",
  verticalAlign: "middle",
};

const drawerActionStyle: CSSProperties = {
  display: "flex",
  justifyContent: "center",
  padding: "0.45rem 0.95rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.82rem",
  fontWeight: 600,
  textDecoration: "none",
};

function summarizeWindows(records: NoticeWindowRecord[]): WindowPosture {
  let atRisk = 0;
  let breached = 0;
  for (const r of records) {
    // Terminal notices (accepted / cancelled) have left the window — they don't count against posture.
    if (r.state === "ack_accepted" || r.state === "cancelled" || r.state === "ack_rejected")
      continue;
    const d = daysRemaining(r);
    if (d < 0) breached += 1;
    else if (d <= 2) atRisk += 1;
  }
  return { atRisk, breached, total: records.length };
}

export function ArDashboard(): JSX.Element {
  const client = useApiClient();
  const [aging, setAging] = useState<ArAging | null>(null);
  const [buckets, setBuckets] = useState<MetricsBucket[] | null>(null);
  const [noe, setNoe] = useState<WindowPosture | null>(null);
  const [notr, setNotr] = useState<WindowPosture | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [rowFilter, setRowFilter] = useState<RowFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDegraded(false);
    const [agingRes, metricsRes, noeRes, notrRes] = await Promise.all([
      client.GET("/api/v1/billing/ar-dashboard"),
      client.GET("/api/v1/billing/metrics"),
      client.GET("/api/v1/noe-records"),
      client.GET("/api/v1/notr-records"),
    ]);
    // The AR aging rollup is the page anchor; a 503 (seams unbound) / 403 here degrades the whole surface.
    if (agingRes.error) {
      setError("AR dashboard unavailable — the billing read seam is not bound, or you lack scope.");
      setLoading(false);
      return;
    }
    setAging(agingRes.data as unknown as ArAging);
    // Best-effort tiles: each absent read leaves its tile out and raises the degraded marker (never throws).
    if (metricsRes.error) setDegraded(true);
    else setBuckets((metricsRes.data as unknown as { buckets?: MetricsBucket[] })?.buckets ?? []);
    if (noeRes.error) setDegraded(true);
    else
      setNoe(
        summarizeWindows(
          ((noeRes.data as unknown as ListPage<NoticeWindowRecord>)?.items ??
            []) as NoticeWindowRecord[],
        ),
      );
    if (notrRes.error) setDegraded(true);
    else
      setNotr(
        summarizeWindows(
          ((notrRes.data as unknown as ListPage<NoticeWindowRecord>)?.items ??
            []) as NoticeWindowRecord[],
        ),
      );
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !aging) return <EmptyState title="Unavailable" description={error ?? "No data."} />;

  const totalArCents =
    aging.bucket0to30Cents +
    aging.bucket31to60Cents +
    aging.bucket61to90Cents +
    aging.bucket90PlusCents;

  // Claim-state mix → denial rate + open-claim count (best-effort; absent when metrics degraded).
  const byState = new Map((buckets ?? []).map((b) => [b.key, b]));
  const totalClaims = (buckets ?? []).reduce((n, b) => n + b.count, 0);
  const deniedCount = byState.get("denied")?.count ?? 0;
  const denialRate = totalClaims > 0 ? Math.round((deniedCount / totalClaims) * 100) : null;
  const validatingCount = byState.get("validating")?.count ?? 0;
  const rows = dashboardRowsFor({ aging, buckets: buckets ?? [], noe, notr });
  const hasActiveFilters = searchQuery !== "" || rowFilter !== "all";
  const filteredRows = rows.filter((row) => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch =
      !q ||
      row.category.toLowerCase().includes(q) ||
      row.label.toLowerCase().includes(q) ||
      row.detail.toLowerCase().includes(q);
    const matchesKind = rowFilter === "all" || row.kind === rowFilter;
    return matchesSearch && matchesKind;
  });
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filteredRows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const selectedRow = rows.find((row) => row.id === selectedRowId) ?? null;

  const clearFilters = (): void => {
    setSearchQuery("");
    setRowFilter("all");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Accounts Receivable"
          breadcrumb="Billing / Medicare"
          actions={
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <Link to="/billing/claims" style={drawerActionStyle}>
                Claims
              </Link>
              <Link to="/billing/noe" style={drawerActionStyle}>
                NOE queue
              </Link>
              <Link to="/billing/notr" style={drawerActionStyle}>
                NOTR queue
              </Link>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review Medicare AR aging, claim-state aggregates, and notice filing-window posture.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="AR · 0-30 days"
            value={dollars(aging.bucket0to30Cents)}
            detail="Backend AR bucket"
            tone="success"
            accentColor="var(--color-success)"
          />
          <KpiCard
            label="AR · 31-60 days"
            value={dollars(aging.bucket31to60Cents)}
            detail="Backend AR bucket"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="AR · 61-90 days"
            value={dollars(aging.bucket61to90Cents)}
            detail="Backend AR bucket"
            tone="warning"
            accentColor="var(--color-warning)"
          />
          <KpiCard
            label="AR · 90+ days"
            value={dollars(aging.bucket90PlusCents)}
            detail="Backend AR bucket"
            tone={aging.bucket90PlusCents > 0 ? "danger" : "neutral"}
            accentColor={
              aging.bucket90PlusCents > 0 ? "var(--color-error)" : "var(--color-outline-variant)"
            }
          />
          <KpiCard
            label="Total Open AR"
            value={dollars(totalArCents)}
            detail="Sum of backend buckets"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
          {buckets ? (
            <>
              <KpiCard
                label="Denial Rate"
                value={denialRate === null ? "—" : `${denialRate}%`}
                detail="Backend metrics buckets"
                tone={(denialRate ?? 0) > 0 ? "warning" : "neutral"}
                accentColor={
                  (denialRate ?? 0) > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
                }
              />
              <KpiCard
                label="Open Claims"
                value={totalClaims}
                detail="Backend metrics buckets"
                tone="info"
                accentColor="var(--color-primary)"
              />
              <KpiCard
                label="Pending Validation"
                value={validatingCount}
                detail="Backend metrics buckets"
                tone={validatingCount > 0 ? "warning" : "neutral"}
                accentColor={
                  validatingCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
                }
              />
            </>
          ) : null}
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
          {degraded ? (
            <p
              // biome-ignore lint/a11y/useSemanticElements: the rule suggests `<output>`, which is
              // the result of a CALCULATION inside a form (and is form-associated). This is a
              // degraded-state announcement, and `role="status"` on ordinary flow content is the
              // idiomatic polite live region.
              role="status"
              style={{
                margin: 0,
                padding: "0.625rem 1rem",
                borderRadius: "var(--radius-md)",
                background: "var(--color-surface-low)",
                color: "var(--color-on-surface-variant)",
                fontSize: "0.85rem",
              }}
            >
              Some panels are running in a degraded mode — a supporting read is unavailable.
            </p>
          ) : null}

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <div style={{ position: "relative", minWidth: "15rem" }}>
                <input
                  type="search"
                  placeholder="Search billing metrics..."
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setPage(1);
                  }}
                  aria-label="Search billing metrics"
                  style={{
                    width: "100%",
                    paddingLeft: "2rem",
                    height: "2.25rem",
                    fontSize: "0.85rem",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: "0.625rem",
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: "var(--color-on-surface-variant)",
                    pointerEvents: "none",
                  }}
                >
                  <Glyph name="search" size={14} />
                </div>
              </div>

              <select
                value={rowFilter}
                onChange={(event) => {
                  setRowFilter(event.target.value as RowFilter);
                  setPage(1);
                }}
                aria-label="Filter by billing metric type"
                style={{ height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" }}
              >
                <option value="all">Type: All</option>
                <option value="ar">AR aging</option>
                <option value="claim">Claims</option>
                <option value="notice">NOE / NOTR</option>
              </select>

              {hasActiveFilters ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>

            <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.8125rem" }}>
              {filteredRows.length} of {rows.length} metrics
            </span>
          </div>
        </div>
      }
      table={
        filteredRows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No matching billing metrics"
              description="Try adjusting your search criteria or clearing active filters."
              action={
                <Button tone="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          </div>
        ) : (
          <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
            <BillingMetricTable
              rows={pagedRows}
              selectedRowId={selectedRowId}
              onSelectRow={setSelectedRowId}
            />
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredRows.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={BILLING_PAGE_SIZES}
              noun="metrics"
            />
          </div>
        )
      }
      detail={
        selectedRow ? (
          <RightDetailPanel
            open={selectedRow !== null}
            title="Billing Metric"
            onClose={() => setSelectedRowId(null)}
            hideScrollbar
          >
            <BillingMetricDrawer row={selectedRow} />
          </RightDetailPanel>
        ) : null
      }
      fullPageScroll
    />
  );
}

function dashboardRowsFor({
  aging,
  buckets,
  noe,
  notr,
}: {
  aging: ArAging;
  buckets: MetricsBucket[];
  noe: WindowPosture | null;
  notr: WindowPosture | null;
}): DashboardRow[] {
  const arRows: DashboardRow[] = [
    ["0-30 days", aging.bucket0to30Cents, "success"],
    ["31-60 days", aging.bucket31to60Cents, "progress"],
    ["61-90 days", aging.bucket61to90Cents, "warning"],
    ["90+ days", aging.bucket90PlusCents, aging.bucket90PlusCents > 0 ? "error" : "neutral"],
  ].map(([label, amountCents, tone]) => ({
    id: `ar:${label}`,
    kind: "ar",
    category: "AR aging",
    label: String(label),
    count: null,
    amountCents: Number(amountCents),
    tone: tone as DashboardRow["tone"],
    detail: "Backend AR aging bucket from /api/v1/billing/ar-dashboard.",
  }));

  const claimRows = buckets.map((bucket) => ({
    id: `claim:${bucket.key}`,
    kind: "claim" as const,
    category: "Claims",
    label: statusLabel(bucket.key),
    count: bucket.count,
    amountCents: bucket.amountCents,
    tone: claimStateTone(bucket.key),
    detail: "Backend claim-state aggregate from /api/v1/billing/metrics.",
    href: "/billing/claims",
  }));

  const noticeRows = [
    noticeRow("NOE filing windows", noe, "/billing/noe"),
    noticeRow("NOTR filing windows", notr, "/billing/notr"),
  ].filter((row): row is DashboardRow => row !== null);

  return [...arRows, ...claimRows, ...noticeRows];
}

function noticeRow(
  label: string,
  posture: WindowPosture | null,
  href: string,
): DashboardRow | null {
  if (!posture) return null;
  const worstDays = posture.breached > 0 ? -1 : posture.atRisk > 0 ? 1 : 5;
  return {
    id: `notice:${label}`,
    kind: "notice",
    category: "NOE / NOTR",
    label,
    count: posture.total,
    amountCents: null,
    tone: windowTierTone(worstDays),
    detail: `${posture.atRisk} at risk · ${posture.breached} breached · summarized from notice records.`,
    href,
  };
}

function BillingMetricTable({
  rows,
  selectedRowId,
  onSelectRow,
}: {
  rows: DashboardRow[];
  selectedRowId: string | null;
  onSelectRow: (id: string) => void;
}): JSX.Element {
  return (
    <table
      style={{ display: "table", width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}
    >
      <thead>
        <tr
          style={{
            textAlign: "left",
            color: "var(--color-on-surface-variant)",
            borderBottom:
              "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
            background: "var(--color-surface-low)",
          }}
        >
          <th style={{ ...thStyle, width: "18%" }}>Type</th>
          <th style={{ ...thStyle, width: "24%" }}>Metric</th>
          <th style={{ ...thStyle, width: "16%", textAlign: "right" }}>Count</th>
          <th style={{ ...thStyle, width: "18%", textAlign: "right" }}>Amount</th>
          <th style={{ ...thStyle, width: "24%" }}>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const isSelected = selectedRowId === row.id;
          return (
            <tr
              key={row.id}
              {...interactiveRowProps(() => onSelectRow(row.id), isSelected)}
              className="wx-data-row-interactive"
              style={{
                borderBottom:
                  "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
                background: isSelected ? "var(--color-primary-tint)" : "transparent",
                cursor: "pointer",
                transition: "background 0.15s ease",
              }}
            >
              <td style={tdStyle}>{row.category}</td>
              <td style={tdStyle}>{row.label}</td>
              <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {row.count ?? "—"}
              </td>
              <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {row.amountCents === null ? "—" : dollars(row.amountCents)}
              </td>
              <td style={tdStyle}>
                <StatusPill label={statusForRow(row)} tone={row.tone} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function BillingMetricDrawer({ row }: { row: DashboardRow }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <StatusPill label={row.category} tone={row.tone} />
        <StatusPill label={statusForRow(row)} tone={row.tone} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ fontWeight: 600, color: "var(--color-on-surface)" }}>{row.label}</span>
        <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.8125rem" }}>
          {row.detail}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: "0.75rem",
          padding: "0.75rem",
          borderRadius: "var(--radius-md)",
          background: "var(--color-surface-low)",
        }}
      >
        <MetricField label="Count" value={row.count ?? "—"} />
        <MetricField
          label="Amount"
          value={row.amountCents === null ? "—" : dollars(row.amountCents)}
        />
      </div>

      {row.href ? (
        <Link to={row.href} style={drawerActionStyle}>
          Open related queue
        </Link>
      ) : null}
    </div>
  );
}

function MetricField({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
      <span style={{ color: t.onSurfaceVariant, fontSize: "0.7rem" }}>{label}</span>
      <span
        style={{ color: t.onSurface, fontSize: "0.875rem", fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </span>
    </div>
  );
}

function statusForRow(row: DashboardRow): string {
  if (row.kind === "notice") {
    if (row.detail.includes("breached") && !row.detail.startsWith("0 at risk · 0 breached"))
      return row.detail.includes("· 0 breached") ? "At risk" : "Breached";
    return "In window";
  }
  return row.kind === "claim" ? row.label : row.label;
}
