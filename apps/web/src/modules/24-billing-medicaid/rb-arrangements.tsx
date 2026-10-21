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
// apps/web/src/modules/24-billing-medicaid — M24, the R&B ARRANGEMENTS LIST (R2, §5.1 #11). Per-patient NF
// Room & Board pass-through contracts: facility, effective window, the three per-diems, the pass-through /
// retention split, and the arrangement state. Backed by GET /api/v1/rb-arrangements (+ GET /api/v1/rb-days
// for the day counts, read once for the whole page and bucketed client-side so the list stays one round
// trip per resource). Lantern: WorkQueueLayout + No-Line table (§6.7) + §6.6 StatusPill; CSS-var tokens only.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  RB_ARRANGEMENT_STATE_TONE,
  humanize,
  money,
  pct,
  shortDate,
  shortId,
  toneOf,
} from "./medicaid-status";
import {
  FilterRow,
  SelectFilter,
  linkMonoStyle,
  mutedStyle,
  rowLine,
  tableStyle,
  td,
  tdMono,
  tdNum,
  th,
  thNum,
} from "./medicaid-ui";

interface Arrangement {
  id: string;
  patientId: string;
  nfFacilityMdmId: string;
  nfFacilityNameSnapshot: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  nfPerDiemRoutineCents: number;
  nfPerDiemRespCents: number;
  nfPerDiemGipCents: number;
  passThroughPct: number;
  retentionPct: number;
  state: string;
}

interface RbDay {
  id: string;
  rbArrangementId: string;
  status: string;
}

const STATE_OPTIONS = [
  { value: "", label: "Any state" },
  { value: "DRAFT", label: "Draft" },
  { value: "ACTIVE", label: "Active" },
  { value: "EXPIRED", label: "Expired" },
  { value: "TERMINATED", label: "Terminated" },
  { value: "SUPERSEDED", label: "Superseded" },
];

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function MedicaidRbArrangements(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Arrangement[]>([]);
  const [dayCounts, setDayCounts] = useState<Map<string, { total: number; pending: number }>>(
    new Map(),
  );
  const [state, setState] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [daysDegraded, setDaysDegraded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDaysDegraded(false);
    const query: Record<string, string> = {};
    if (state) query.state = state;
    const [listRes, dayRes] = await Promise.all([
      client.GET("/api/v1/rb-arrangements", { params: { query } } as never),
      client.GET("/api/v1/rb-days", {} as never),
    ]);
    if (listRes.error) {
      setError("R&B arrangements are unavailable — you may lack billing visibility.");
      setLoading(false);
      return;
    }
    setRows((listRes.data as unknown as Arrangement[]) ?? []);
    // Day counts are a nicety, not the anchor read — degrade the column rather than the page.
    if (dayRes.error) {
      setDaysDegraded(true);
    } else {
      const counts = new Map<string, { total: number; pending: number }>();
      for (const d of (dayRes.data as unknown as RbDay[]) ?? []) {
        const c = counts.get(d.rbArrangementId) ?? { total: 0, pending: 0 };
        c.total += 1;
        if (d.status === "pending") c.pending += 1;
        counts.set(d.rbArrangementId, c);
      }
      setDayCounts(counts);
    }
    setLoading(false);
  }, [client, state]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.id, r.patientId, r.nfFacilityMdmId, r.nfFacilityNameSnapshot, r.state].some((value) =>
        value.toLowerCase().includes(q),
      ),
    );
  }, [rows, searchQuery]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filteredRows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters = searchQuery !== "" || state !== "";
  const activeCount = rows.filter((r) => r.state === "ACTIVE").length;
  const draftCount = rows.filter((r) => r.state === "DRAFT").length;
  const pendingDayCount = Array.from(dayCounts.values()).reduce((sum, c) => sum + c.pending, 0);

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="R&B Arrangements"
          breadcrumb="Billing — Medicaid · nursing-facility pass-through"
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Track facility agreements, effective windows, per-diem rates, and day-level readiness.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Arrangements"
            value={loading || error ? "—" : rows.length}
            detail="Total loaded"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Active"
            value={loading || error ? "—" : activeCount}
            detail="Currently billable"
            tone="success"
            accentColor="var(--color-success)"
            selected={state === "ACTIVE"}
            onSelect={() => {
              setState("ACTIVE");
              setPage(1);
            }}
          />
          <KpiCard
            label="Draft"
            value={loading || error ? "—" : draftCount}
            detail="Awaiting activation"
            tone={draftCount > 0 ? "warning" : "neutral"}
            accentColor={draftCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
            selected={state === "DRAFT"}
            onSelect={() => {
              setState("DRAFT");
              setPage(1);
            }}
          />
          <KpiCard
            label="Pending Days"
            value={loading || error || daysDegraded ? "—" : pendingDayCount}
            detail={daysDegraded ? "Unavailable" : "Need review"}
            tone={pendingDayCount > 0 ? "warning" : "neutral"}
            accentColor={
              pendingDayCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
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
            <div role="alert" style={bannerStyle("error")}>
              <Glyph name="alert" size={16} />
              <span>{error}</span>
            </div>
          ) : daysDegraded ? (
            <output style={bannerStyle("warning")}>
              <Glyph name="alert" size={16} />
              <span>Day counts are unavailable in this session.</span>
            </output>
          ) : null}
          <FilterRow>
            <label className="wx-search-field">
              <Glyph name="search" size={16} />
              <input
                type="search"
                placeholder="Search facility, patient, or arrangement..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search arrangements"
              />
            </label>
            <SelectFilter
              label="Arrangement state"
              value={state}
              options={STATE_OPTIONS}
              onChange={(next) => {
                setState(next);
                setPage(1);
              }}
            />
            {hasActiveFilters ? (
              <Button
                size="sm"
                tone="tertiary"
                onClick={() => {
                  setSearchQuery("");
                  setState("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {filteredRows.length} of {rows.length} arrangements
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
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No arrangements"
              description={
                hasActiveFilters
                  ? "No NF Room & Board arrangement matches these filters."
                  : "No NF Room & Board arrangements have been created."
              }
              action={
                hasActiveFilters ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => {
                      setSearchQuery("");
                      setState("");
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
                  <th style={{ ...th, width: "24%" }}>Facility</th>
                  <th style={th}>Patient</th>
                  <th style={th}>Effective</th>
                  <th style={thNum}>Routine</th>
                  <th style={thNum}>Respite</th>
                  <th style={thNum}>GIP</th>
                  <th style={thNum}>Pass-through</th>
                  <th style={thNum}>Days</th>
                  <th style={th}>State</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((r) => {
                  const counts = dayCounts.get(r.id);
                  return (
                    <tr key={r.id} style={rowLine}>
                      <td style={td}>
                        <a href={`/medicaid/billing/rb-arrangements/${r.id}`} style={linkMonoStyle}>
                          {r.nfFacilityNameSnapshot || shortId(r.nfFacilityMdmId)}
                        </a>
                      </td>
                      <td style={tdMono}>{shortId(r.patientId)}</td>
                      <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                        {shortDate(r.effectiveFrom)} →{" "}
                        {r.effectiveTo ? shortDate(r.effectiveTo) : "open"}
                      </td>
                      <td style={tdNum}>{money(r.nfPerDiemRoutineCents)}</td>
                      <td style={tdNum}>{money(r.nfPerDiemRespCents)}</td>
                      <td style={tdNum}>{money(r.nfPerDiemGipCents)}</td>
                      <td style={tdNum}>{pct(r.passThroughPct, false)}</td>
                      <td style={tdNum}>
                        {daysDegraded ? (
                          "—"
                        ) : counts ? (
                          <>
                            {counts.total}
                            {counts.pending > 0 ? (
                              <span style={{ ...mutedStyle, marginLeft: "0.3rem" }}>
                                ({counts.pending} pending)
                              </span>
                            ) : null}
                          </>
                        ) : (
                          0
                        )}
                      </td>
                      <td style={td}>
                        <StatusPill
                          label={humanize(r.state)}
                          tone={toneOf(RB_ARRANGEMENT_STATE_TONE, r.state)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredRows.length}
              onPageChange={setPage}
              onPageSizeChange={(next) => {
                setPageSize(next);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="arrangements"
            />
          </div>
        )
      }
      detail={
        <span style={mutedStyle}>
          The pass-through percentage is the share of the facility per-diem the hospice remits; the
          balance is the agency's retention.
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

function bannerStyle(tone: "error" | "warning") {
  const color = tone === "error" ? "var(--color-error)" : "var(--color-warning)";
  return {
    padding: "0.625rem 1rem",
    borderRadius: "var(--radius-md)",
    background: `color-mix(in srgb, ${color} 12%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
    color,
    fontSize: "0.85rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  };
}
