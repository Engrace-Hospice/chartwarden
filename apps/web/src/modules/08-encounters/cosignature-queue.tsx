import {
  Button,
  CountdownChip,
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
// apps/web/src/modules/08-encounters — Cosignature Queue (M8 §5.5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_ENCOUNTER_VISIT_DOCUMENTATION.md — "Use Work Queue."
// The RN / Clinical Supervisor cosignature work queue: one row per encounter awaiting cosignature.
// Reconciled to Lantern (R1): the §5.5 SLA is a §7.5 CountdownChip counting down to the 48h hard cap
// (warning → alert → overdue), status is a §6.6 StatusPill, ids are mono, the table is No-Line. Reads
// GET /api/v1/encounters/cosignature-queue via the typed client; the server enforces every scope
// (ADR-0030 — no authz on the frontend). Imports only leaves (@chartwarden/ui).
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate } from "react-router-dom";
import { ENCOUNTER_TONE, cosignDueAt, cosignOverdue, stateLabel } from "./encounter-status";

interface EncounterRow {
  id: string;
  patientId: string;
  encounterType: string;
  discipline: string;
  serviceDate: string;
  status: string;
  signedAt: string | null;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function CosignatureQueue(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<EncounterRow[]>([]);
  const [disciplineFilter, setDisciplineFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [slaFilter, setSlaFilter] = useState("");
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
      const { data, error: err } = await client.GET("/api/v1/encounters/cosignature-queue");
      if (!active) return;
      if (err) {
        setError("Could not load the cosignature queue.");
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

  const overdue = items.filter((e) => cosignOverdue(e.signedAt)).length;
  const dueSoon = items.filter((e) => {
    const hours = hoursUntilCosignDue(e);
    return hours != null && hours >= 0 && hours <= 24;
  }).length;
  const unsigned = items.filter((e) => !e.signedAt).length;
  const disciplineOptions = useMemo(
    () => [
      { value: "", label: "Any discipline" },
      ...Array.from(new Set(items.map((e) => e.discipline)))
        .sort()
        .map((value) => ({ value, label: stateLabel(value) })),
    ],
    [items],
  );
  const statusOptions = useMemo(
    () => [
      { value: "", label: "Any status" },
      ...Array.from(new Set(items.map((e) => e.status)))
        .sort()
        .map((value) => ({ value, label: stateLabel(value) })),
    ],
    [items],
  );
  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return items
      .filter((e) => {
        const hours = hoursUntilCosignDue(e);
        const matchesDiscipline = !disciplineFilter || e.discipline === disciplineFilter;
        const matchesStatus = !statusFilter || e.status === statusFilter;
        const matchesSla =
          !slaFilter ||
          (slaFilter === "overdue"
            ? cosignOverdue(e.signedAt)
            : slaFilter === "due_soon"
              ? hours != null && hours >= 0 && hours <= 24
              : !e.signedAt);
        const matchesSearch =
          !q ||
          [
            e.id,
            e.patientId,
            e.encounterType,
            e.discipline,
            e.serviceDate,
            e.status,
            e.signedAt ?? "",
          ].some((value) => value.toLowerCase().includes(q));
        return matchesDiscipline && matchesStatus && matchesSla && matchesSearch;
      })
      .sort((a, b) => {
        const aHours = hoursUntilCosignDue(a);
        const bHours = hoursUntilCosignDue(b);
        if (aHours == null && bHours == null) return b.serviceDate.localeCompare(a.serviceDate);
        if (aHours == null) return 1;
        if (bHours == null) return -1;
        return aHours - bHours;
      });
  }, [disciplineFilter, items, searchQuery, slaFilter, statusFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedItems = filteredItems.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters =
    searchQuery !== "" || disciplineFilter !== "" || statusFilter !== "" || slaFilter !== "";
  const clearFilters = (): void => {
    setSearchQuery("");
    setDisciplineFilter("");
    setStatusFilter("");
    setSlaFilter("");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      fullPageScroll
      header={
        <PageHeader title="Cosignatures" breadcrumb="Clinical Work — encounter cosignatures">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Prioritize encounters awaiting cosignature by discipline, status, and the 48-hour hard
            cap.
          </div>
        </PageHeader>
      }
      kpis={
        // UI-003 containment: during load/outage these used to read "Pending 0" — a false all-clear
        // on a clinical queue. "—" until the load actually answered.
        <KpiStrip>
          <KpiCard
            label="Pending"
            value={loading || error ? "—" : items.length}
            detail="Awaiting cosignature"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Past Hard Cap"
            value={loading || error ? "—" : overdue}
            detail="48h exceeded"
            tone={overdue > 0 ? "danger" : "neutral"}
            accentColor={overdue > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
            selected={slaFilter === "overdue"}
            onSelect={() => {
              setSlaFilter("overdue");
              setPage(1);
            }}
          />
          <KpiCard
            label="Due < 24h"
            value={loading || error ? "—" : dueSoon}
            detail="Approaching cap"
            tone={dueSoon > 0 ? "warning" : "neutral"}
            accentColor={dueSoon > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
            selected={slaFilter === "due_soon"}
            onSelect={() => {
              setSlaFilter("due_soon");
              setPage(1);
            }}
          />
          <KpiCard
            label="Unsigned"
            value={loading || error ? "—" : unsigned}
            detail="Missing primary signature"
            tone={unsigned > 0 ? "warning" : "neutral"}
            accentColor={unsigned > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
            selected={slaFilter === "unsigned"}
            onSelect={() => {
              setSlaFilter("unsigned");
              setPage(1);
            }}
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
                placeholder="Search patient, encounter, discipline..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search cosignatures"
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
              <span style={mutedStyle}>Status</span>
              <select
                aria-label="Filter by status"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                {statusOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>SLA</span>
              <select
                aria-label="Filter by SLA"
                value={slaFilter}
                onChange={(e) => {
                  setSlaFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Any SLA</option>
                <option value="overdue">Past hard cap</option>
                <option value="due_soon">Due under 24h</option>
                <option value="unsigned">Unsigned</option>
              </select>
            </label>
            {hasActiveFilters ? (
              <Button size="sm" tone="tertiary" onClick={clearFilters}>
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {filteredItems.length} of {items.length} cosignatures
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
              title="No cosignatures"
              description={
                hasActiveFilters
                  ? "No cosignature matches these filters."
                  : "No encounters are awaiting your cosignature."
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
              aria-label="Cosignature queue"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable region must be keyboard-focusable (axe scrollable-region-focusable).
              tabIndex={0}
              style={tableViewportStyle}
            >
              <table style={tableStyle}>
                <colgroup>
                  <col style={{ width: "27%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "10%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Encounter</th>
                    <th>Discipline</th>
                    <th>Service date</th>
                    <th>Cosign SLA</th>
                    <th>Status</th>
                    <th>Patient</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedItems.map((e) => (
                    <tr
                      key={e.id}
                      // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(`/patients/${e.patientId}/encounters/${e.id}`)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          navigate(`/patients/${e.patientId}/encounters/${e.id}`);
                        }
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <td>
                        <div style={primaryCellStyle}>
                          <span style={{ color: "var(--color-on-surface)", fontWeight: 600 }}>
                            {stateLabel(e.encounterType)}
                          </span>
                          <span style={monoMutedStyle}>{e.id.slice(0, 8)}</span>
                        </div>
                      </td>
                      <td>{stateLabel(e.discipline)}</td>
                      <td className="tabular-nums">{e.serviceDate}</td>
                      <td>
                        {e.signedAt ? (
                          <CountdownChip
                            dueAt={cosignDueAt(e.signedAt)}
                            warnWithinHours={36}
                            alertWithinHours={24}
                            label="Cosign"
                          />
                        ) : (
                          <span style={{ color: "var(--color-muted)" }}>—</span>
                        )}
                      </td>
                      <td>
                        <StatusPill
                          label={stateLabel(e.status)}
                          tone={ENCOUNTER_TONE[e.status] ?? "neutral"}
                        />
                      </td>
                      <td style={monoMutedStyle}>{e.patientId.slice(0, 8)}</td>
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
              noun="cosignatures"
            />
          </>
        )
      }
    />
  );
}

function hoursUntilCosignDue(encounter: EncounterRow): number | null {
  if (!encounter.signedAt) return null;
  return (cosignDueAt(encounter.signedAt).getTime() - Date.now()) / 3_600_000;
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
  minWidth: "66rem",
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
