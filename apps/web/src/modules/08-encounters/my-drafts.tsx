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
  interactiveRowProps,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/08-encounters — My Drafts (M8 §5.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_ENCOUNTER_VISIT_DOCUMENTATION.md — "Use Work Queue."
// The author's open encounter drafts: one row per in-flight draft with its type · discipline · service
// date · late-entry tier. Reconciled to Lantern (R1): the §2.5 late-entry tier is a §6.6 StatusPill
// (normal calm, escalating tiers warn/alert), ids mono, table No-Line. A row opens the Encounter Read
// view. Reads GET /api/v1/encounters/my-drafts via the typed client; the server scopes to the calling
// author (ADR-0030 — no authz on the frontend). Imports only leaves (@chartwarden/ui).
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate } from "react-router-dom";
import { lateEntryTone, stateLabel } from "./encounter-status";

interface EncounterRow {
  id: string;
  patientId: string;
  visitId?: string | null;
  encounterType: string;
  discipline: string;
  serviceDate: string;
  status: string;
  lateEntryTier: string;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

/** A draft's home is the composer (#91): this queue lists notes that still need writing. */
const draftHref = (patientId: string, encounterId: string): string =>
  `/patients/${patientId}/encounters/${encounterId}/compose`;

export function MyDrafts(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<EncounterRow[]>([]);
  const [disciplineFilter, setDisciplineFilter] = useState("");
  const [lateFilter, setLateFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/encounters/my-drafts");
      if (!active) return;
      if (err) {
        setError("Could not load your drafts.");
        setLoading(false);
        return;
      }
      setItems((data?.encounters ?? []) as EncounterRow[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  // §2.5 D4 tiers are normal | late_entry | significant_late_entry | administrative_override —
  // anything but `normal` is a late entry. (Was compared to a non-existent "on_time" tier.)
  const lateCount = items.filter((e) => e.lateEntryTier !== "normal").length;
  const adminOverrideCount = items.filter(
    (e) => e.lateEntryTier === "administrative_override",
  ).length;
  const disciplineOptions = useMemo(
    () => [
      { value: "", label: "Any discipline" },
      ...Array.from(new Set(items.map((e) => e.discipline)))
        .sort()
        .map((value) => ({ value, label: stateLabel(value) })),
    ],
    [items],
  );
  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return items
      .filter((e) => {
        const matchesDiscipline = !disciplineFilter || e.discipline === disciplineFilter;
        const matchesLate =
          !lateFilter ||
          (lateFilter === "normal" ? e.lateEntryTier === "normal" : e.lateEntryTier !== "normal");
        const matchesSearch =
          !q ||
          [
            e.id,
            e.patientId,
            e.encounterType,
            e.discipline,
            e.serviceDate,
            e.status,
            e.lateEntryTier,
          ].some((value) => value.toLowerCase().includes(q));
        return matchesDiscipline && matchesLate && matchesSearch;
      })
      .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate));
  }, [disciplineFilter, items, lateFilter, searchQuery]);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedItems = filteredItems.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters = searchQuery !== "" || disciplineFilter !== "" || lateFilter !== "";
  const clearFilters = (): void => {
    setSearchQuery("");
    setDisciplineFilter("");
    setLateFilter("");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      fullPageScroll
      header={
        <PageHeader title="My drafts">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Resume open encounter documentation, with late-entry risk and administrative override
            cues surfaced before signing.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Open Drafts"
            value={loading || error ? "—" : items.length}
            detail="In-flight encounters"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Late Entry"
            value={loading || error ? "—" : lateCount}
            detail="Needs careful review"
            tone={lateCount > 0 ? "warning" : "neutral"}
            accentColor={lateCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
            selected={lateFilter === "late"}
            onSelect={() => {
              setLateFilter("late");
              setPage(1);
            }}
          />
          <KpiCard
            label="Admin Override"
            value={loading || error ? "—" : adminOverrideCount}
            detail="Highest scrutiny"
            tone={adminOverrideCount > 0 ? "danger" : "neutral"}
            accentColor={
              adminOverrideCount > 0 ? "var(--color-error)" : "var(--color-outline-variant)"
            }
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
            <label className="wx-search-field">
              <Glyph name="search" size={16} />
              <input
                type="search"
                placeholder="Search encounter, patient, discipline..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search drafts"
              />
            </label>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Discipline</span>
              <select
                aria-label="Filter by discipline"
                value={disciplineFilter}
                onChange={(e) => {
                  setDisciplineFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                {disciplineOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Late-entry</span>
              <select
                aria-label="Filter by late-entry tier"
                value={lateFilter}
                onChange={(e) => {
                  setLateFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">All</option>
                <option value="normal">Normal</option>
                <option value="late">Late-entry</option>
              </select>
            </label>
            {hasActiveFilters ? (
              <Button size="sm" tone="tertiary" onClick={clearFilters}>
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {filteredItems.length} of {items.length} drafts
            </span>
          </div>
        </div>
      }
      table={
        error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : filteredItems.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No drafts"
              description={
                hasActiveFilters
                  ? "No draft matches these filters."
                  : "You have no open encounter drafts."
              }
              action={
                hasActiveFilters ? (
                  <Button tone="secondary" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <>
            <section
              aria-label="Draft notes"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable region must be keyboard-focusable (axe scrollable-region-focusable).
              tabIndex={0}
              style={tableViewportStyle}
            >
              <table style={tableStyle}>
                <colgroup>
                  <col style={{ width: "34%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "14%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Encounter</th>
                    <th>Discipline</th>
                    <th>Service date</th>
                    <th>Late-entry</th>
                    <th>Patient</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedItems.map((e) => (
                    <tr
                      key={e.id}
                      // #91 — a DRAFT opens in the composer, not the read screen. This queue's whole
                      // reason to exist is the note that is not finished yet; until the composer existed
                      // every row led to a read-only view of the thing the author came here to write.
                      {...interactiveRowProps(
                        () => navigate(draftHref(e.patientId, e.id)),
                        false,
                        true,
                      )}
                      style={{ cursor: "pointer" }}
                    >
                      <td>
                        <div style={primaryCellStyle}>
                          <span style={{ color: "var(--color-on-surface)", fontWeight: 600 }}>
                            {stateLabel(e.encounterType)}
                          </span>
                          <span style={monoMutedStyle}>{e.id.slice(0, 8)}</span>
                          <span style={metaInlineStyle}>
                            {e.visitId ? `Visit ${e.visitId.slice(0, 8)}` : "PRN / unscheduled"}
                          </span>
                        </div>
                      </td>
                      <td>{stateLabel(e.discipline)}</td>
                      <td className="tabular-nums">{e.serviceDate}</td>
                      <td>
                        <StatusPill
                          label={stateLabel(e.lateEntryTier)}
                          tone={lateEntryTone(e.lateEntryTier)}
                        />
                      </td>
                      <td style={monoMutedStyle}>{e.patientId.slice(0, 8)}</td>
                      <td>
                        <Button
                          size="sm"
                          tone="secondary"
                          onClick={(event) => {
                            event.stopPropagation();
                            navigate(`/patients/${e.patientId}/encounters/${e.id}`);
                          }}
                        >
                          Continue Documentation
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredItems.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="drafts"
            />
          </>
        )
      }
    />
  );
}

const filterPanelStyle: CSSProperties = {
  padding: "0 1.5rem 0.75rem",
};

const filterRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "end",
  gap: "0.75rem",
};

const filterLabelStyle: CSSProperties = {
  display: "grid",
  gap: "0.25rem",
};

const mutedStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8125rem",
};

const selectStyle: CSSProperties = {
  minHeight: "2.35rem",
  padding: "0.45rem 0.65rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-surface-container)",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};

const errorBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  marginBottom: "0.75rem",
  padding: "0.65rem 0.75rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-error)",
  color: "var(--color-error)",
  background: "color-mix(in srgb, var(--color-error) 8%, var(--color-surface))",
  fontSize: "0.875rem",
};

const tableViewportStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const tableStyle: CSSProperties = {
  width: "100%",
  minWidth: "58rem",
  borderCollapse: "collapse",
  tableLayout: "fixed",
  fontSize: "0.875rem",
};

const primaryCellStyle: CSSProperties = {
  display: "grid",
  gap: "0.2rem",
};

const monoMutedStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.8125rem",
  fontVariantNumeric: "tabular-nums",
};

const metaInlineStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
