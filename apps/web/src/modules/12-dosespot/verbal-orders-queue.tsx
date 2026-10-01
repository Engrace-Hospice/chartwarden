import {
  Button,
  EmptyState,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/12-dosespot — verbal medication-orders queue (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (verbal-orders). The named
// prescriber's queue of verbal_pending medication orders awaiting their signature within the 48h window
// (42 CFR 418.104(b); the M11 OrderSignatureProvider verbal primitive). Sorted by created (the per-order
// deadline lives on the M11 verbal record). Controlled substances may NOT be ordered verbally in Phase 1
// (D18, `dosespot.epcs` OFF) — they never appear here. The sign step-up fills in as its write surface
// hardens; the SERVER owns the §2.2 D2 status (ADR-0030 — no frontend authz). Reads
// GET /api/v1/medication-orders?status=verbal_pending via the typed client. Leaves only (@wardenx/ui).
// #91 — a row opens the ORDER, where the §2.3 verbal ceremonies (sign, cosign) live. See the note in
// `sign-inbox.tsx` on why the ceremony is not inlined into the row.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { MED_ORDER_TONE, stateLabel } from "./medication-status";

interface MedRow {
  id: string;
  patientId: string;
  medClass: string;
  status: string;
  drugName: string;
  strength: string;
  prescribingPhysicianMdmId: string;
  createdAt: string;
}

export function VerbalMedicationOrdersQueue(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<MedRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [medClass, setMedClass] = useState("");
  const [prescriber, setPrescriber] = useState("");
  const [ageFilter, setAgeFilter] = useState<"all" | "older24" | "older36">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/medication-orders", {
      params: { query: { status: "verbal_pending" } },
    });
    if (err) {
      setError("Could not load the verbal medication-orders queue.");
      setLoading(false);
      return;
    }
    setItems((data?.orders ?? []) as MedRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const now = Date.now();
  const medClassOptions = useMemo(
    () => [...new Set(items.map((o) => o.medClass).filter(Boolean))].sort(),
    [items],
  );
  const prescriberOptions = useMemo(
    () => [...new Set(items.map((o) => o.prescribingPhysicianMdmId).filter(Boolean))].sort(),
    [items],
  );

  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = items.filter((o) => {
      const age = ageHours(o.createdAt, now);
      const matchesAge =
        ageFilter === "all" ||
        (ageFilter === "older24" && age >= 24) ||
        (ageFilter === "older36" && age >= 36);
      const matchesClass = !medClass || o.medClass === medClass;
      const matchesPrescriber = !prescriber || o.prescribingPhysicianMdmId === prescriber;
      const matchesSearch =
        !q ||
        o.id.toLowerCase().includes(q) ||
        o.patientId.toLowerCase().includes(q) ||
        o.drugName.toLowerCase().includes(q) ||
        o.strength.toLowerCase().includes(q) ||
        o.medClass.toLowerCase().includes(q) ||
        o.prescribingPhysicianMdmId.toLowerCase().includes(q);
      return matchesAge && matchesClass && matchesPrescriber && matchesSearch;
    });
    return [...visible].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }, [items, ageFilter, medClass, now, prescriber, searchQuery]);

  const activeFilters = [
    searchQuery.trim() !== "",
    medClass !== "",
    prescriber !== "",
    ageFilter !== "all",
  ].filter(Boolean).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setMedClass("");
    setPrescriber("");
    setAgeFilter("all");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Verbal Medication Orders" breadcrumb="Clinical / Prescribing">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Track non-controlled verbal medication orders awaiting prescriber signature.
          </div>
        </PageHeader>
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
              <span style={toolbarEyebrowStyle}>Queue</span>
              <strong>{rows.length} matching verbal medications</strong>
            </div>
            <div style={controlGroupStyle}>
              <div style={searchWrapStyle}>
                <input
                  type="search"
                  placeholder="Search drug, patient, prescriber..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search verbal medication orders"
                  style={searchInputStyle}
                />
              </div>
              <select
                aria-label="Medication class"
                value={medClass}
                onChange={(e) => {
                  setMedClass(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Class: All</option>
                {medClassOptions.map((option) => (
                  <option key={option} value={option}>
                    {stateLabel(option)}
                  </option>
                ))}
              </select>
              <select
                aria-label="Named prescriber"
                value={prescriber}
                onChange={(e) => {
                  setPrescriber(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Prescriber: All</option>
                {prescriberOptions.map((option) => (
                  <option key={option} value={option}>
                    {shortId(option)}
                  </option>
                ))}
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
              title={
                activeFilters > 0
                  ? "No matching verbal medications"
                  : "No verbal medication orders pending"
              }
              description={
                activeFilters > 0
                  ? "Try adjusting the queue filters."
                  : "No verbal medication orders are awaiting signature."
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
                  <th style={{ ...thStyle, width: "32%" }}>Medication</th>
                  <th style={{ ...thStyle, width: "20%" }}>Patient</th>
                  <th style={{ ...thStyle, width: "14%" }}>Class</th>
                  <th style={{ ...thStyle, width: "16%" }}>Status</th>
                  <th style={{ ...thStyle, width: "10%" }}>Prescriber</th>
                  <th style={{ ...thStyle, width: "8%", textAlign: "right" }}>Recorded</th>
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
                      <StatusPill
                        label={stateLabel(o.status)}
                        tone={MED_ORDER_TONE[o.status] ?? "neutral"}
                      />
                    </td>
                    <td style={tdStyle}>
                      <code className="wx-data-md" style={codeStyle}>
                        {shortId(o.prescribingPhysicianMdmId)}
                      </code>
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
  color: "var(--color-error-pill-fg)",
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
