// apps/web/src/modules/37-ipu — M37 IPU equipment register (§5/§2.9). Lists durable/biomed equipment with
// its status + next inspection due date (an overdue inspection blocks bed assignment). GET
// /api/v1/ipu-equipment. Lantern: UI components + CSS-var tokens only.
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
  type StatusTone,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";

interface Equipment {
  id: string;
  serialNumber: string;
  equipmentType: string;
  currentStatus: string;
  nextInspectionDueDate: string | null;
}

type InspectionFilter = "all" | "overdue" | "due_soon" | "clear" | "unscheduled";

const EQUIPMENT_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;
const DUE_SOON_DAYS = 14;

const today = (): string => new Date().toISOString().slice(0, 10);

const titleCase = (value: string): string =>
  value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();

const formatDate = (iso: string | null): string => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const addDays = (date: string, days: number): string => {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
};

const isOverdue = (due: string | null, now: string): boolean => due !== null && due < now;

const isDueSoon = (due: string | null, now: string): boolean =>
  due !== null && due >= now && due <= addDays(now, DUE_SOON_DAYS);

const inspectionMatches = (
  equipment: Equipment,
  filter: InspectionFilter,
  now: string,
): boolean => {
  if (filter === "all") return true;
  if (filter === "overdue") return isOverdue(equipment.nextInspectionDueDate, now);
  if (filter === "due_soon") return isDueSoon(equipment.nextInspectionDueDate, now);
  if (filter === "unscheduled") return equipment.nextInspectionDueDate === null;
  return (
    equipment.nextInspectionDueDate !== null &&
    !isOverdue(equipment.nextInspectionDueDate, now) &&
    !isDueSoon(equipment.nextInspectionDueDate, now)
  );
};

const statusTone = (status: string): StatusTone => {
  const normalized = status.toLowerCase();
  if (normalized.includes("available") || normalized.includes("ready")) return "success";
  if (normalized.includes("maintenance") || normalized.includes("repair")) return "warning";
  if (normalized.includes("retired") || normalized.includes("inactive")) return "neutral";
  if (normalized.includes("blocked") || normalized.includes("failed")) return "error";
  return "progress";
};

const inspectionTone = (due: string | null, now: string): StatusTone => {
  if (!due) return "neutral";
  if (isOverdue(due, now)) return "error";
  if (isDueSoon(due, now)) return "warning";
  return "success";
};

export function IpuEquipment(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Equipment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [inspectionFilter, setInspectionFilter] = useState<InspectionFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const now = today();

  const load = useCallback(async () => {
    const res = await client.GET("/api/v1/ipu-equipment");
    if (res.error) {
      setError("Equipment unavailable.");
      setRows([]);
      return;
    }
    setError(null);
    setRows((res.data as unknown as { items: Equipment[] }).items ?? []);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const typeOptions = useMemo(
    () => Array.from(new Set((rows ?? []).map((equipment) => equipment.equipmentType))).sort(),
    [rows],
  );
  const statusOptions = useMemo(
    () => Array.from(new Set((rows ?? []).map((equipment) => equipment.currentStatus))).sort(),
    [rows],
  );

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return (rows ?? []).filter((equipment) => {
      const matchesSearch =
        q.length === 0 ||
        equipment.serialNumber.toLowerCase().includes(q) ||
        equipment.equipmentType.toLowerCase().includes(q) ||
        equipment.currentStatus.toLowerCase().includes(q) ||
        equipment.id.toLowerCase().includes(q);
      const matchesType = typeFilter === "all" || equipment.equipmentType === typeFilter;
      const matchesStatus = statusFilter === "all" || equipment.currentStatus === statusFilter;
      return (
        matchesSearch &&
        matchesType &&
        matchesStatus &&
        inspectionMatches(equipment, inspectionFilter, now)
      );
    });
  }, [inspectionFilter, now, rows, searchQuery, statusFilter, typeFilter]);

  const total = rows?.length ?? 0;
  const overdue = (rows ?? []).filter((equipment) =>
    isOverdue(equipment.nextInspectionDueDate, now),
  ).length;
  const dueSoon = (rows ?? []).filter((equipment) =>
    isDueSoon(equipment.nextInspectionDueDate, now),
  ).length;
  const unscheduled = (rows ?? []).filter(
    (equipment) => equipment.nextInspectionDueDate === null,
  ).length;
  const available = (rows ?? []).filter(
    (equipment) => statusTone(equipment.currentStatus) === "success",
  ).length;

  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    typeFilter !== "all" ||
    statusFilter !== "all" ||
    inspectionFilter !== "all";
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filteredRows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setTypeFilter("all");
    setStatusFilter("all");
    setInspectionFilter("all");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="IPU equipment" breadcrumb="IPU / Equipment register">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review durable and biomed equipment readiness before bedside assignment.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Equipment"
            value={rows === null ? "—" : total}
            detail="Registered assets"
            tone={total > 0 ? "info" : "neutral"}
            accentColor={total > 0 ? "var(--color-primary)" : "var(--color-outline-variant)"}
            selected={!hasActiveFilters}
            onSelect={clearFilters}
          />
          <KpiCard
            label="Available"
            value={rows === null ? "—" : available}
            detail="Ready status"
            tone={available > 0 ? "success" : "neutral"}
            accentColor={available > 0 ? "var(--color-success)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Overdue"
            value={rows === null ? "—" : overdue}
            detail="Inspection past due"
            tone={overdue > 0 ? "danger" : "neutral"}
            accentColor={overdue > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
            selected={inspectionFilter === "overdue"}
            onSelect={() => {
              setInspectionFilter("overdue");
              setPage(1);
            }}
          />
          <KpiCard
            label="Due soon"
            value={rows === null ? "—" : dueSoon}
            detail={`${DUE_SOON_DAYS} day window`}
            tone={dueSoon > 0 ? "warning" : "neutral"}
            accentColor={dueSoon > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
            selected={inspectionFilter === "due_soon"}
            onSelect={() => {
              setInspectionFilter("due_soon");
              setPage(1);
            }}
          />
          <KpiCard
            label="Unscheduled"
            value={rows === null ? "—" : unscheduled}
            detail="No due date"
            tone={unscheduled > 0 ? "warning" : "neutral"}
            accentColor={unscheduled > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
            selected={inspectionFilter === "unscheduled"}
            onSelect={() => {
              setInspectionFilter("unscheduled");
              setPage(1);
            }}
          />
        </KpiStrip>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Glyph name="alert" size={16} />
                <span>{error}</span>
              </div>
              <button
                type="button"
                onClick={() => setError(null)}
                style={dismissButtonStyle}
                aria-label="Dismiss error"
              >
                x
              </button>
            </div>
          ) : null}
          <div style={toolbarStyle}>
            <div style={searchBoxStyle}>
              <Glyph name="eye" size={14} />
              <input
                type="search"
                placeholder="Search serial, type, status, ID..."
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setPage(1);
                }}
                aria-label="Search IPU equipment"
                style={searchInputStyle}
              />
            </div>
            <select
              value={typeFilter}
              onChange={(event) => {
                setTypeFilter(event.target.value);
                setPage(1);
              }}
              aria-label="Filter equipment by type"
              style={selectStyle}
            >
              <option value="all">Type: All</option>
              {typeOptions.map((type) => (
                <option key={type} value={type}>
                  {titleCase(type)}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(1);
              }}
              aria-label="Filter equipment by status"
              style={selectStyle}
            >
              <option value="all">Status: All</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {titleCase(status)}
                </option>
              ))}
            </select>
            <select
              value={inspectionFilter}
              onChange={(event) => {
                setInspectionFilter(event.target.value as InspectionFilter);
                setPage(1);
              }}
              aria-label="Filter equipment by inspection status"
              style={selectStyle}
            >
              <option value="all">Inspection: All</option>
              <option value="overdue">Overdue</option>
              <option value="due_soon">Due soon</option>
              <option value="clear">Clear</option>
              <option value="unscheduled">Unscheduled</option>
            </select>
            {hasActiveFilters ? (
              <Button size="sm" tone="tertiary" onClick={clearFilters}>
                Clear
              </Button>
            ) : null}
          </div>
        </div>
      }
      table={
        rows === null ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={hasActiveFilters ? "No matching equipment" : "No equipment"}
              description={
                hasActiveFilters
                  ? "Adjust the search or clear filters to return to the full equipment register."
                  : "No IPU equipment is registered yet."
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
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={{ ...thStyle, width: "26%" }}>Equipment</th>
                  <th style={{ ...thStyle, width: "22%" }}>Type</th>
                  <th style={{ ...thStyle, width: "18%" }}>Status</th>
                  <th style={{ ...thStyle, width: "20%" }}>Inspection due</th>
                  <th style={{ ...thStyle, width: "14%" }}>Readiness</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((equipment) => {
                  const overdueInspection = isOverdue(equipment.nextInspectionDueDate, now);
                  const dueSoonInspection = isDueSoon(equipment.nextInspectionDueDate, now);
                  return (
                    <tr key={equipment.id} style={rowStyle}>
                      <td style={tdStyle}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                          <span style={{ color: "var(--color-on-surface)", fontWeight: 650 }}>
                            {equipment.serialNumber}
                          </span>
                          <code className="wx-data-md" style={codeStyle}>
                            {equipment.id}
                          </code>
                        </div>
                      </td>
                      <td style={tdStyle}>{titleCase(equipment.equipmentType)}</td>
                      <td style={tdStyle}>
                        <StatusPill
                          tone={statusTone(equipment.currentStatus)}
                          label={titleCase(equipment.currentStatus)}
                        />
                      </td>
                      <td style={tdStyle}>
                        <StatusPill
                          tone={inspectionTone(equipment.nextInspectionDueDate, now)}
                          label={formatDate(equipment.nextInspectionDueDate)}
                        />
                      </td>
                      <td style={tdStyle}>
                        {overdueInspection ? (
                          <span style={readinessStyle("error")}>Blocked</span>
                        ) : dueSoonInspection ? (
                          <span style={readinessStyle("warning")}>Review</span>
                        ) : equipment.nextInspectionDueDate === null ? (
                          <span style={readinessStyle("neutral")}>Unscheduled</span>
                        ) : (
                          <span style={readinessStyle("success")}>Clear</span>
                        )}
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
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={EQUIPMENT_PAGE_SIZES}
              noun="equipment"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.5rem",
};

const searchBoxStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  minWidth: "min(100%, 18rem)",
  color: "var(--color-on-surface-variant)",
};

const searchInputStyle: CSSProperties = {
  width: "100%",
  height: "2.25rem",
  paddingLeft: "2rem",
  fontSize: "0.85rem",
};

const selectStyle: CSSProperties = {
  height: "2.25rem",
  fontSize: "0.85rem",
  cursor: "pointer",
};

const tableWrapStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const tableStyle: CSSProperties = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.875rem",
  fontVariantNumeric: "tabular-nums",
};

const headerRowStyle: CSSProperties = {
  textAlign: "left",
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};

const thStyle: CSSProperties = {
  padding: "0.75rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
  textTransform: "uppercase",
};

const tdStyle: CSSProperties = {
  padding: "0.875rem 1rem",
  verticalAlign: "middle",
  color: "var(--color-on-surface-variant)",
};

const rowStyle: CSSProperties = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};

const codeStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};

const readinessStyle = (tone: "success" | "warning" | "error" | "neutral"): CSSProperties => {
  const color =
    tone === "success"
      ? "var(--color-success)"
      : tone === "warning"
        ? "var(--color-warning)"
        : tone === "error"
          ? "var(--color-error)"
          : "var(--color-on-surface-variant)";
  return {
    display: "inline-block",
    padding: "0.2rem 0.5rem",
    borderRadius: "var(--radius-sm)",
    background: `color-mix(in srgb, ${color} 12%, transparent)`,
    color,
    fontSize: "0.75rem",
    fontWeight: 650,
  };
};

const errorBannerStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
};

const dismissButtonStyle: CSSProperties = {
  border: "none",
  background: "none",
  color: "inherit",
  cursor: "pointer",
  fontWeight: 600,
};
