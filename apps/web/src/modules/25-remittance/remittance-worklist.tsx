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
} from "@wardenx/ui";
// apps/web/src/modules/25-remittance — M25, the REMITTANCE WORKLIST (R2, §5). The 835 envelope surface: the
// posted/queued/failed advices and the manual-match backlog of unmatched lines. Reads are org-scoped
// server-side (RLS); the server is the only authz point (ADR-0030) — this gates nav visibility only. Lantern:
// WorkQueueLayout + KpiStrip + No-Line table + §6.6 StatusPill via remittance-status.ts; CSS-var tokens only.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { MATCH_STATE_TONE, PARSE_STATUS_TONE, humanize, money, toneOf } from "./remittance-status";

interface AdviceRow {
  id: string;
  payerKind: string;
  paymentMethod: string;
  totalPaymentAmount: string;
  parseStatus: string;
  receivedAt: string;
}
interface LineRow {
  id: string;
  claimId: string | null;
  clp03TotalChargeAmount: string;
  clp04TotalPaymentAmount: string;
  matchState: string;
  receivedAt: string;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function RemittanceWorklist(): JSX.Element {
  const client = useApiClient();
  const [advices, setAdvices] = useState<AdviceRow[]>([]);
  const [unmatched, setUnmatched] = useState<LineRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [parseFilter, setParseFilter] = useState("");
  const [advicePage, setAdvicePage] = useState(1);
  const [advicePageSize, setAdvicePageSize] = useState(10);
  const [backlogPage, setBacklogPage] = useState(1);
  const [backlogPageSize, setBacklogPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [adviceRes, unmatchedRes] = await Promise.all([
      client.GET("/api/v1/remittance/advices"),
      client.GET("/api/v1/remittance/unmatched"),
    ]);
    if (adviceRes.error) {
      setError(
        "Remittance worklist unavailable — you may lack provider scope, or the read seam is unbound.",
      );
      setLoading(false);
      return;
    }
    setAdvices(adviceRes.data?.items ?? []);
    setUnmatched(unmatchedRes.error ? [] : (unmatchedRes.data?.items ?? []));
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const parseOptions = useMemo(
    () => [
      { value: "", label: "Any parse" },
      ...Array.from(new Set(advices.map((a) => a.parseStatus)))
        .sort()
        .map((value) => ({ value, label: humanize(value) })),
    ],
    [advices],
  );
  const filteredAdvices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return advices
      .filter((a) => {
        const matchesParse = !parseFilter || a.parseStatus === parseFilter;
        const matchesSearch =
          !q ||
          [a.id, a.payerKind, a.paymentMethod, a.parseStatus, a.totalPaymentAmount].some((value) =>
            value.toLowerCase().includes(q),
          );
        return matchesParse && matchesSearch;
      })
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }, [advices, parseFilter, searchQuery]);
  const filteredBacklog = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return unmatched
      .filter(
        (l) =>
          !q ||
          [
            l.id,
            l.claimId ?? "",
            l.matchState,
            l.clp03TotalChargeAmount,
            l.clp04TotalPaymentAmount,
          ].some((value) => value.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }, [searchQuery, unmatched]);

  const failed = advices.filter((a) => a.parseStatus === "failed").length;
  const posted = advices.filter((a) => a.parseStatus === "posted").length;
  const totalPaid = advices.reduce((sum, a) => sum + Number(a.totalPaymentAmount), 0);
  const advicePageCount = Math.max(1, Math.ceil(filteredAdvices.length / advicePageSize));
  const activeAdvicePage = Math.min(advicePage, advicePageCount);
  const pagedAdvices = filteredAdvices.slice(
    (activeAdvicePage - 1) * advicePageSize,
    activeAdvicePage * advicePageSize,
  );
  const backlogPageCount = Math.max(1, Math.ceil(filteredBacklog.length / backlogPageSize));
  const activeBacklogPage = Math.min(backlogPage, backlogPageCount);
  const pagedBacklog = filteredBacklog.slice(
    (activeBacklogPage - 1) * backlogPageSize,
    activeBacklogPage * backlogPageSize,
  );
  const hasActiveFilters = searchQuery !== "" || parseFilter !== "";

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Remittance" breadcrumb="Revenue Cycle — 835 / ERA">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Monitor received ERA envelopes, parse health, posted dollars, and manual-match backlog.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="835 Advices"
            value={loading || error ? "—" : advices.length}
            detail="Received envelopes"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Posted"
            value={loading || error ? "—" : posted}
            detail="Parsed and posted"
            tone="success"
            accentColor="var(--color-success)"
          />
          <KpiCard
            label="Unmatched Lines"
            value={loading || error ? "—" : unmatched.length}
            detail="Manual-match backlog"
            tone={unmatched.length > 0 ? "warning" : "neutral"}
            accentColor={
              unmatched.length > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
          />
          <KpiCard
            label="Failed Parses"
            value={loading || error ? "—" : failed}
            detail="Need file review"
            tone={failed > 0 ? "danger" : "neutral"}
            accentColor={failed > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
            selected={parseFilter === "failed"}
            onSelect={() => {
              setParseFilter("failed");
              setAdvicePage(1);
            }}
          />
          <KpiCard
            label="Paid"
            value={loading || error ? "—" : money(totalPaid)}
            detail="Advice total"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
        </KpiStrip>
      }
      filters={
        <div style={filterPanelStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{error}</span>
            </div>
          ) : null}
          <div style={filterRowStyle}>
            <div style={{ position: "relative", minWidth: "16rem" }}>
              <input
                type="search"
                placeholder="Search payer, method, claim, amount..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setAdvicePage(1);
                  setBacklogPage(1);
                }}
                aria-label="Search remittance"
                style={searchInputStyle}
              />
              <div style={searchIconStyle}>
                <Glyph name="eye" size={14} />
              </div>
            </div>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Parse</span>
              <select
                aria-label="Filter by parse status"
                value={parseFilter}
                onChange={(e) => {
                  setParseFilter(e.target.value);
                  setAdvicePage(1);
                }}
                style={selectStyle}
              >
                {parseOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {hasActiveFilters ? (
              <Button
                size="sm"
                tone="tertiary"
                onClick={() => {
                  setSearchQuery("");
                  setParseFilter("");
                  setAdvicePage(1);
                  setBacklogPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {filteredAdvices.length} of {advices.length} advices · {filteredBacklog.length} of{" "}
              {unmatched.length} unmatched
            </span>
          </div>
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
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "1.75rem",
              padding: "0 1.5rem 1.5rem",
            }}
          >
            <section>
              <h2 style={sectionTitle}>835 envelopes</h2>
              {filteredAdvices.length === 0 ? (
                <EmptyState
                  title="No remittances"
                  description={
                    hasActiveFilters
                      ? "No 835 advice matches these filters."
                      : "No 835 advices have been received yet."
                  }
                  action={
                    hasActiveFilters ? (
                      <Button
                        tone="secondary"
                        size="sm"
                        onClick={() => {
                          setSearchQuery("");
                          setParseFilter("");
                          setAdvicePage(1);
                        }}
                      >
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div style={{ width: "100%", overflowX: "auto" }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr style={headerRowStyle}>
                        <th style={headStyle}>Received</th>
                        <th style={headStyle}>Payer</th>
                        <th style={headStyle}>Method</th>
                        <th style={headNumStyle}>Paid</th>
                        <th style={headStyle}>Parse</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedAdvices.map((a) => (
                        <tr key={a.id} style={rowStyle} className="wx-data-row-interactive">
                          <td style={tdDateStyle}>{new Date(a.receivedAt).toLocaleDateString()}</td>
                          <td style={cellStyle}>{humanize(a.payerKind)}</td>
                          <td style={cellStyle}>{humanize(a.paymentMethod)}</td>
                          <td style={tdNumStyle}>{money(a.totalPaymentAmount)}</td>
                          <td style={cellStyle}>
                            <StatusPill
                              label={humanize(a.parseStatus)}
                              tone={toneOf(PARSE_STATUS_TONE, a.parseStatus)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <OffsetPagination
                    page={activeAdvicePage}
                    pageSize={advicePageSize}
                    totalItems={filteredAdvices.length}
                    onPageChange={setAdvicePage}
                    onPageSizeChange={(next) => {
                      setAdvicePageSize(next);
                      setAdvicePage(1);
                    }}
                    pageSizeOptions={PAGE_SIZES}
                    noun="advices"
                  />
                </div>
              )}
            </section>

            <section>
              <h2 style={sectionTitle}>Manual-match backlog</h2>
              {filteredBacklog.length === 0 ? (
                <EmptyState
                  title="Nothing to match"
                  description={
                    searchQuery
                      ? "No unmatched line matches this search."
                      : "Every posted line is matched to a claim."
                  }
                  action={
                    searchQuery ? (
                      <Button
                        tone="secondary"
                        size="sm"
                        onClick={() => {
                          setSearchQuery("");
                          setBacklogPage(1);
                        }}
                      >
                        Clear search
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div style={{ width: "100%", overflowX: "auto" }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr style={headerRowStyle}>
                        <th style={headStyle}>Received</th>
                        <th style={headNumStyle}>Charge</th>
                        <th style={headNumStyle}>Paid</th>
                        <th style={headStyle}>State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedBacklog.map((l) => (
                        <tr key={l.id} style={rowStyle} className="wx-data-row-interactive">
                          <td style={tdDateStyle}>{new Date(l.receivedAt).toLocaleDateString()}</td>
                          <td style={tdNumStyle}>{money(l.clp03TotalChargeAmount)}</td>
                          <td style={tdNumStyle}>{money(l.clp04TotalPaymentAmount)}</td>
                          <td style={cellStyle}>
                            <StatusPill
                              label={humanize(l.matchState)}
                              tone={toneOf(MATCH_STATE_TONE, l.matchState)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <OffsetPagination
                    page={activeBacklogPage}
                    pageSize={backlogPageSize}
                    totalItems={filteredBacklog.length}
                    onPageChange={setBacklogPage}
                    onPageSizeChange={(next) => {
                      setBacklogPageSize(next);
                      setBacklogPage(1);
                    }}
                    pageSizeOptions={PAGE_SIZES}
                    noun="lines"
                  />
                </div>
              )}
            </section>
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const tableStyle = { width: "100%", borderCollapse: "collapse" as const, fontSize: "0.875rem" };
const cellStyle = {
  padding: "0.55rem 0.75rem",
  textAlign: "left" as const,
  verticalAlign: "middle" as const,
  color: "var(--color-on-surface)",
};
const tdDateStyle = { ...cellStyle, fontVariantNumeric: "tabular-nums" as const };
const tdNumStyle = {
  ...cellStyle,
  textAlign: "right" as const,
  fontVariantNumeric: "tabular-nums" as const,
};
const headStyle = {
  ...cellStyle,
  fontSize: "0.72rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--color-on-surface-variant)",
  fontWeight: 600,
};
const headNumStyle = { ...headStyle, textAlign: "right" as const };
const rowStyle = { borderTop: "1px solid var(--color-surface-container)" };
const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const sectionTitle = {
  margin: "0 0 0.5rem",
  fontFamily: "var(--font-display)",
  fontSize: "1rem",
  fontWeight: 500,
  color: "var(--color-on-surface)",
};
const filterPanelStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const filterRowStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "0.75rem",
  alignItems: "flex-end",
};
const filterLabelStyle = { display: "flex", flexDirection: "column" as const, gap: "0.25rem" };
const searchInputStyle = {
  width: "100%",
  paddingLeft: "2rem",
  height: "2.25rem",
  fontSize: "0.85rem",
};
const searchIconStyle = {
  position: "absolute" as const,
  left: "0.625rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: "var(--color-on-surface-variant)",
  pointerEvents: "none" as const,
};
const selectStyle = {
  height: "2.25rem",
  fontSize: "0.85rem",
  cursor: "pointer",
};
const mutedStyle = { fontSize: "0.8rem", color: "var(--color-on-surface-variant)" };
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
