import {
  Button,
  CountdownChip,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/12-dosespot — refill inbox (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (refill inbox). The
// prescriber / clinical-supervisor queue of pending refill requests (§2.7 D9), sorted by request age (a proxy
// for SLA priority — the SERVER owns the authoritative 48h-warn / 72h-critical SLA, §2.7). The refill_inbox_scope
// ABAC predicate narrows the list server-side to the caller's caseload OR the orders they prescribe (ADR-0030 —
// no frontend authz; the patient name is SUD-consent-gated server-side). The approve/deny actions live on the
// detail screen as their write surface hardens. Reads GET /api/v1/refills via the typed client.
// Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { REFILL_TONE, stateLabel } from "./medication-status";

interface RefillRow {
  id: string;
  patientId: string;
  sourceMedicationOrderId: string;
  status: string;
  requestedAt: string;
}

// §2.7 D9 refill SLA (the SERVER owns the authoritative SLA; this is a UX hint): warn at 48h-age,
// critical at 72h-age. Modeled as a CountdownChip counting down to the 72h critical deadline.
const WARN_HOURS = 48;
const CRITICAL_HOURS = 72;

export function RefillInbox(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<RefillRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [slaFilter, setSlaFilter] = useState<"all" | "warning" | "critical">("all");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/refills", {});
    if (err) {
      setError("Could not load the refill inbox.");
      setLoading(false);
      return;
    }
    setItems((data?.refills ?? []) as RefillRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const now = Date.now();
  const counts = useMemo(
    () => ({
      pending: items.filter((r) => r.status === "pending").length,
      critical: items.filter((r) => ageHours(r.requestedAt, now) >= CRITICAL_HOURS).length,
    }),
    [items, now],
  );
  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = items.filter((r) => {
      const age = ageHours(r.requestedAt, now);
      const matchesSla =
        slaFilter === "all" ||
        (slaFilter === "warning" && age >= WARN_HOURS && age < CRITICAL_HOURS) ||
        (slaFilter === "critical" && age >= CRITICAL_HOURS);
      const matchesStatus = !status || r.status === status;
      const matchesSearch =
        !q ||
        r.id.toLowerCase().includes(q) ||
        r.patientId.toLowerCase().includes(q) ||
        r.sourceMedicationOrderId.toLowerCase().includes(q) ||
        r.status.toLowerCase().includes(q);
      return matchesSla && matchesStatus && matchesSearch;
    });
    return [...visible].sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
  }, [items, now, searchQuery, slaFilter, status]);

  const activeFilters = [searchQuery.trim() !== "", slaFilter !== "all", status !== ""].filter(
    Boolean,
  ).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setSlaFilter("all");
    setStatus("");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Refill Inbox" breadcrumb="Clinical / Prescribing">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Triage refill requests by SLA age, source medication order, and request status.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Pending refills"
            value={loading || error ? "—" : counts.pending}
            detail="Awaiting action"
            tone={counts.pending > 0 ? "info" : "neutral"}
            accentColor={
              counts.pending > 0 ? "var(--color-primary)" : "var(--color-outline-variant)"
            }
            selected={status === "pending"}
            onSelect={() => {
              setStatus("pending");
              setSlaFilter("all");
              setPage(1);
            }}
          />
          <KpiCard
            label="SLA critical (72h+)"
            value={loading || error ? "—" : counts.critical}
            detail="Past critical threshold"
            tone={counts.critical > 0 ? "danger" : "neutral"}
            accentColor={
              counts.critical > 0 ? "var(--color-error)" : "var(--color-outline-variant)"
            }
            selected={slaFilter === "critical"}
            onSelect={() => {
              setSlaFilter("critical");
              setPage(1);
            }}
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
              <span style={toolbarEyebrowStyle}>Inbox</span>
              <strong>{rows.length} matching refills</strong>
            </div>
            <div style={controlGroupStyle}>
              <div style={searchWrapStyle}>
                <input
                  type="search"
                  placeholder="Search refill, patient, source order..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search refill inbox"
                  style={searchInputStyle}
                />
              </div>
              <select
                aria-label="SLA state"
                value={slaFilter}
                onChange={(e) => {
                  setSlaFilter(e.target.value as typeof slaFilter);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="all">SLA: All</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
              <select
                aria-label="Refill status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Status: All</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="denied">Denied</option>
                <option value="expired">Expired</option>
              </select>
              {activeFilters > 0 ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      }
      table={
        error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading && items.length === 0 ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={activeFilters > 0 ? "No matching refills" : "No pending refills"}
              description={
                activeFilters > 0
                  ? "Try adjusting the inbox filters."
                  : "The refill inbox is clear."
              }
              action={
                activeFilters > 0 ? (
                  <Button size="sm" tone="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={{ ...thStyle, width: "28%" }}>Refill</th>
                  <th style={{ ...thStyle, width: "22%" }}>Patient</th>
                  <th style={{ ...thStyle, width: "20%" }}>Source order</th>
                  <th style={{ ...thStyle, width: "12%" }}>Status</th>
                  <th style={{ ...thStyle, width: "10%" }}>Requested</th>
                  <th style={{ ...thStyle, width: "8%", textAlign: "right" }}>SLA</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((r) => (
                  <tr
                    key={r.id}
                    // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/refills/${r.id}`)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        navigate(`/refills/${r.id}`);
                      }
                    }}
                    style={rowStyle}
                    className="wx-data-row-interactive"
                  >
                    <td style={tdStyle}>
                      <div style={primaryCellStyle}>
                        <span style={primaryTextStyle}>Refill request</span>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(r.id)}
                        </code>
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <code className="wx-data-md" style={codeStyle}>
                        {shortId(r.patientId)}
                      </code>
                    </td>
                    <td style={tdStyle}>
                      <code className="wx-data-md" style={codeStyle}>
                        {shortId(r.sourceMedicationOrderId)}
                      </code>
                    </td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={stateLabel(r.status)}
                        tone={REFILL_TONE[r.status] ?? "neutral"}
                      />
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {formatDateTime(r.requestedAt)}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      {/* warning when <=24h to the 72h critical deadline (about >=48h old); overdue past 72h. */}
                      <CountdownChip
                        dueAt={criticalDeadline(r.requestedAt)}
                        warnWithinHours={CRITICAL_HOURS - WARN_HOURS}
                        alertWithinHours={0}
                        label="SLA"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={rows.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={MED_PAGE_SIZES}
              noun="refills"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const MED_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

function criticalDeadline(requestedAt: string): Date {
  return new Date(Date.parse(requestedAt) + CRITICAL_HOURS * 3_600_000);
}

function ageHours(iso: string, now: number): number {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) return 0;
  return (now - value) / 3_600_000;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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

const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};

const searchWrapStyle = {
  minWidth: "15rem",
};

const searchInputStyle = {
  width: "100%",
  height: "2.25rem",
  fontSize: "0.85rem",
};

const selectStyle = {
  height: "2.25rem",
  fontSize: "0.85rem",
  cursor: "pointer",
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
  cursor: "pointer",
  transition: "background 0.15s ease",
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

const primaryCellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.25rem",
  minWidth: 0,
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
