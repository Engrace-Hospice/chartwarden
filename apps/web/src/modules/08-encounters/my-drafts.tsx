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
} from "@chartwarden/ui";
// apps/web/src/modules/08-encounters — My notes (M8 §5.1, Track B / ADR-0030; the screen id stays `encounter.my-drafts`, route /work/drafts).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_ENCOUNTER_VISIT_DOCUMENTATION.md — "Use Work Queue."
// The author's OPEN visit notes: one row per note not yet signed (a finalized note still counts), with its type · discipline · service
// date · status · closure stage and deadline · late-entry tier. The closure stage and deadline are the SERVER's (ADR-0113: the same
// clock the request gate and the alerts use): a note with no clock is a LEGACY note, shown as "Legacy", never alerting. Nearest
// deadline first, Legacy last. Reconciled to Lantern (R1): stage and late-entry tier are §6.6 StatusPills, ids mono, table No-Line.
// A draft opens the composer, a finalized note the read screen where it is signed. Reads GET /api/v1/encounters/my-drafts via the
// typed client (use-my-notes.ts, which also re-reads it on focus and every minute so a stage that moved with the clock shows; the rows
// are the generated contract's, not a hand-written copy); the server scopes to the calling author (ADR-0030 — no authz on the frontend).
// Imports only leaves (@chartwarden/ui).
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate } from "react-router-dom";
import { NameLabel, patientNameOf } from "../../shell/name-display";
import { useNoteClosure } from "../../shell/note-closure";
import { usePatientNames } from "../../shell/patient-names";
import { lateEntryTone, stateLabel } from "./encounter-status";
import {
  type ClosureFilter,
  closureCounts,
  closureLabel,
  closureTone,
  deadlineText,
  matchesClosureFilter,
  noteHref,
  openNoteLabel,
  sortByDeadline,
} from "./my-notes-model";
import { useMyNotes } from "./use-my-notes";

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

const CLOSURE_FILTER_OPTIONS: readonly { value: ClosureFilter; label: string }[] = [
  { value: "", label: "All" },
  { value: "overdue", label: "Overdue" },
  { value: "at_risk", label: "At risk" },
  { value: "legacy", label: "Legacy" },
];

const isClosureFilter = (value: string): value is ClosureFilter =>
  CLOSURE_FILTER_OPTIONS.some((o) => o.value === value);

export function MyDrafts(): JSX.Element {
  const navigate = useNavigate();
  const [disciplineFilter, setDisciplineFilter] = useState("");
  const [lateFilter, setLateFilter] = useState("");
  const [closureFilter, setClosureFilter] = useState<ClosureFilter>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  // Read at mount, then again on focus and on a slow interval so a stage that moved with the clock shows (see use-my-notes.ts).
  const { items, loading, error } = useMyNotes();

  // The banner's own poll can lag a signature by up to a minute: re-read it once this list is fresh so the two agree.
  const { refresh: refreshClosureStatus } = useNoteClosure();
  useEffect(() => {
    if (!loading && !error) refreshClosureStatus();
  }, [loading, error, refreshClosureStatus]);

  // §2.5 D4 tiers are normal | late_entry | significant_late_entry | administrative_override —
  // anything but `normal` is a late entry. (Was compared to a non-existent "on_time" tier.)
  const lateCount = items.filter((e) => e.lateEntryTier !== "normal").length;
  const adminOverrideCount = items.filter(
    (e) => e.lateEntryTier === "administrative_override",
  ).length;
  const { overdue: overdueCount, atRisk: atRiskCount } = closureCounts(items);
  const disciplineOptions = useMemo(
    () => [
      { value: "", label: "Any discipline" },
      ...Array.from(new Set(items.map((e) => e.discipline)))
        .sort()
        .map((value) => ({ value, label: stateLabel(value) })),
    ],
    [items],
  );
  const patientNames = usePatientNames(items.map((e) => e.patientId));
  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = items.filter((e) => {
      const matchesDiscipline = !disciplineFilter || e.discipline === disciplineFilter;
      const matchesLate =
        !lateFilter ||
        (lateFilter === "normal" ? e.lateEntryTier === "normal" : e.lateEntryTier !== "normal");
      const matchesSearch =
        !q ||
        [
          e.id,
          e.patientId,
          patientNames[e.patientId]?.name ?? "",
          e.encounterType,
          e.discipline,
          e.serviceDate,
          e.status,
          e.lateEntryTier,
          closureLabel(e.closure),
        ].some((value) => value.toLowerCase().includes(q));
      return (
        matchesDiscipline &&
        matchesLate &&
        matchesSearch &&
        matchesClosureFilter(e.closure, closureFilter)
      );
    });
    // Nearest deadline first, Legacy last; the server's order (service date, newest) breaks ties.
    return sortByDeadline(filtered);
  }, [closureFilter, disciplineFilter, items, lateFilter, patientNames, searchQuery]);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedItems = filteredItems.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters =
    searchQuery !== "" || disciplineFilter !== "" || lateFilter !== "" || closureFilter !== "";
  const clearFilters = (): void => {
    setSearchQuery("");
    setDisciplineFilter("");
    setLateFilter("");
    setClosureFilter("");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      fullPageScroll
      header={
        <PageHeader title="My notes">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Your visit notes that are not signed yet, nearest deadline first. A finalized note stays
            open until you sign it. Legacy notes began before closure deadlines and have none.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Open Notes"
            value={loading || error ? "—" : items.length}
            detail="Not signed yet"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Overdue"
            value={loading || error ? "—" : overdueCount}
            detail="Past the closing deadline"
            tone={overdueCount > 0 ? "danger" : "neutral"}
            accentColor={overdueCount > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
            selected={closureFilter === "overdue"}
            onSelect={() => {
              setClosureFilter("overdue");
              setPage(1);
            }}
          />
          <KpiCard
            label="At Risk"
            value={loading || error ? "—" : atRiskCount}
            detail="Deadline is close"
            tone={atRiskCount > 0 ? "warning" : "neutral"}
            accentColor={atRiskCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
            selected={closureFilter === "at_risk"}
            onSelect={() => {
              setClosureFilter("at_risk");
              setPage(1);
            }}
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
                placeholder="Search note, patient, discipline, stage..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search notes"
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
              <span style={mutedStyle}>Closure</span>
              <select
                aria-label="Filter by closure stage"
                value={closureFilter}
                onChange={(e) => {
                  if (isClosureFilter(e.target.value)) setClosureFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                {CLOSURE_FILTER_OPTIONS.map((o) => (
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
              {filteredItems.length} of {items.length} notes
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
              title="No open notes"
              description={
                hasActiveFilters
                  ? "No note matches these filters."
                  : "You have no unsigned visit notes. Nothing is waiting on you."
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
              aria-label="Open notes"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable region must be keyboard-focusable (axe scrollable-region-focusable).
              tabIndex={0}
              style={tableViewportStyle}
            >
              <table style={tableStyle}>
                <colgroup>
                  <col style={{ width: "20%" }} />
                  <col style={{ width: "11%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "9%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "13%" }} />
                  <col style={{ width: "12%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Note</th>
                    <th>Discipline</th>
                    <th>Service date</th>
                    <th>Status</th>
                    <th>Closure</th>
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
                      // A FINALIZED note is finished writing: it opens the read screen, where it is signed.
                      {...interactiveRowProps(() => navigate(noteHref(e)), false, true)}
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
                      <td>{stateLabel(e.status)}</td>
                      <td>
                        <div style={primaryCellStyle}>
                          <StatusPill
                            label={closureLabel(e.closure)}
                            tone={closureTone(e.closure)}
                          />
                          <span style={metaInlineStyle}>{deadlineText(e.closure)}</span>
                        </div>
                      </td>
                      <td>
                        <StatusPill
                          label={stateLabel(e.lateEntryTier)}
                          tone={lateEntryTone(e.lateEntryTier)}
                        />
                      </td>
                      <td>
                        <NameLabel value={patientNameOf(patientNames, e.patientId)} />
                      </td>
                      <td>
                        <Button
                          size="sm"
                          tone="secondary"
                          onClick={(event) => {
                            event.stopPropagation();
                            navigate(noteHref(e));
                          }}
                        >
                          {openNoteLabel(e.status)}
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
              noun="notes"
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
  minWidth: "72rem",
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
