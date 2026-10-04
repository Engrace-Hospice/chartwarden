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
// apps/web/src/modules/12-dosespot — prescriber medication sign inbox (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (sign inbox). The
// prescriber's queue of medication orders awaiting their signature (status pending_signature), KPI'd by
// controlled-vs-standard, sorted by created. A controlled order signs through the EPCS 2FA path (W-MR-02) —
// surfaced here as a badge; the actual sign step-up (and the verbal-pending section) fill in as their write
// surfaces harden. The SERVER owns the authoritative §2.2 D2 status (ADR-0030 — no frontend authz). Reads
// GET /api/v1/medication-orders?status=pending_signature via the typed client. Leaves only (@wardenx/ui).
// #91 — a row opens the ORDER, and the §2.2 sign ceremony lives there. Deliberately not an inline
// Sign button per row: signing a prescription without seeing its sig, strength and controlled posture
// is not a ceremony worth making one click cheaper. The detail carries all three.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { controlledLabel, stateLabel } from "./medication-status";

interface MedRow {
  id: string;
  patientId: string;
  medClass: string;
  status: string;
  drugName: string;
  strength: string;
  isControlledSubstance: boolean;
  deaSchedule: string | null;
  createdAt: string;
}

export function MedicationSignInbox(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<MedRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [controlledFilter, setControlledFilter] = useState<"all" | "controlled" | "standard">(
    "all",
  );
  const [medClass, setMedClass] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/medication-orders", {
      params: { query: { status: "pending_signature" } },
    });
    if (err) {
      setError("Could not load the medication sign inbox.");
      setLoading(false);
      return;
    }
    setItems((data?.orders ?? []) as MedRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const medClassOptions = useMemo(
    () => [...new Set(items.map((o) => o.medClass).filter(Boolean))].sort(),
    [items],
  );
  const counts = useMemo(
    () => ({
      awaiting: items.length,
      controlled: items.filter((o) => o.isControlledSubstance).length,
    }),
    [items],
  );

  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = items.filter((o) => {
      const matchesControlled =
        controlledFilter === "all" ||
        (controlledFilter === "controlled" && o.isControlledSubstance) ||
        (controlledFilter === "standard" && !o.isControlledSubstance);
      const matchesClass = !medClass || o.medClass === medClass;
      const matchesSearch =
        !q ||
        o.id.toLowerCase().includes(q) ||
        o.patientId.toLowerCase().includes(q) ||
        o.drugName.toLowerCase().includes(q) ||
        o.strength.toLowerCase().includes(q) ||
        o.medClass.toLowerCase().includes(q) ||
        o.status.toLowerCase().includes(q);
      return matchesControlled && matchesClass && matchesSearch;
    });
    return [...visible].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }, [items, controlledFilter, medClass, searchQuery]);

  const activeFilters = [
    searchQuery.trim() !== "",
    controlledFilter !== "all",
    medClass !== "",
  ].filter(Boolean).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setControlledFilter("all");
    setMedClass("");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Medications Awaiting Signature" breadcrumb="Clinical / Prescribing">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Sign pending medication orders, with controlled substances surfaced for EPCS review.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Awaiting signature"
            value={loading || error ? "—" : counts.awaiting}
            detail="Pending medication orders"
            tone="info"
            accentColor="var(--color-primary)"
            selected={controlledFilter === "all" && !medClass}
            onSelect={clearFilters}
          />
          <KpiCard
            label="Controlled (EPCS)"
            value={loading || error ? "—" : counts.controlled}
            detail="Requires controlled workflow"
            tone={counts.controlled > 0 ? "warning" : "neutral"}
            accentColor={
              counts.controlled > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
            selected={controlledFilter === "controlled"}
            onSelect={() => {
              setControlledFilter("controlled");
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
              <strong>{rows.length} matching medications</strong>
            </div>
            <div style={controlGroupStyle}>
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  placeholder="Search drug or patient..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search medication sign inbox"
                />
              </label>
              <label className="wx-filter-field">
                <span>Controlled</span>
                <select
                  className="wx-select"
                  aria-label="Controlled substance filter"
                  value={controlledFilter}
                  onChange={(e) => {
                    setControlledFilter(e.target.value as typeof controlledFilter);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="all">All</option>
                  <option value="controlled">Controlled only</option>
                  <option value="standard">Standard only</option>
                </select>
              </label>
              <label className="wx-filter-field">
                <span>Class</span>
                <select
                  className="wx-select"
                  aria-label="Medication class"
                  value={medClass}
                  onChange={(e) => {
                    setMedClass(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="">All</option>
                  {medClassOptions.map((option) => (
                    <option key={option} value={option}>
                      {stateLabel(option)}
                    </option>
                  ))}
                </select>
              </label>
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
              title={
                activeFilters > 0 ? "No matching medications" : "No medications awaiting signature"
              }
              description={
                activeFilters > 0 ? "Try adjusting the inbox filters." : "The sign inbox is clear."
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
                  <th style={{ ...thStyle, width: "34%" }}>Medication</th>
                  <th style={{ ...thStyle, width: "22%" }}>Patient</th>
                  <th style={{ ...thStyle, width: "14%" }}>Class</th>
                  <th style={{ ...thStyle, width: "18%" }}>Controlled</th>
                  <th style={{ ...thStyle, width: "12%", textAlign: "right" }}>Created</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((o) => (
                  <tr
                    key={o.id}
                    // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/medication-orders/${o.id}`)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        navigate(`/medication-orders/${o.id}`);
                      }
                    }}
                    style={rowStyle}
                    className="wx-data-row-interactive"
                  >
                    <td style={tdStyle}>
                      <div style={primaryCellStyle}>
                        <span style={primaryTextStyle}>
                          {o.drugName} {o.strength}
                        </span>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(o.id)}
                        </code>
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <code className="wx-data-md" style={codeStyle}>
                        {shortId(o.patientId)}
                      </code>
                    </td>
                    <td style={tdStyle}>{stateLabel(o.medClass)}</td>
                    <td style={tdStyle}>
                      {/* §10 — controlled-substance / EPCS gold `critical` tone. */}
                      {o.isControlledSubstance ? (
                        <StatusPill
                          label={`${controlledLabel(o.deaSchedule)} · EPCS`}
                          tone="critical"
                          glyph="alert"
                        />
                      ) : (
                        <StatusPill label="Standard" tone="neutral" />
                      )}
                    </td>
                    <td
                      style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                    >
                      {formatDateTime(o.createdAt)}
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
              noun="medications"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const MED_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

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
};

const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
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
