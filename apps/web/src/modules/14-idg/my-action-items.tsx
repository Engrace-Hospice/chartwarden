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
// apps/web/src/modules/14-idg — My Action Items (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace". The
// caller's queue of IDG action items assigned to them (`assignee=me` resolves to the caller's membership
// server-side), one row per item with its status + due date + linked-artifact kind. The update-status /
// link-artifact / add-note write surfaces fill in as their write paths harden; the SERVER owns the §2.7
// auto-close (an item linked to a downstream artifact closes when that artifact reaches an absorbing state) and
// the §4.7 is_assignee ABAC (ADR-0030 — no frontend authz). Reads GET /api/v1/idg/action-items via the typed
// client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { ACTION_TONE, stateLabel } from "./idg-status";

interface ActionItemRow {
  id: string;
  meetingId: string;
  patientId: string | null;
  status: string;
  dueDate: string;
  linkedArtifactKind: string | null;
}

export function MyActionItems(): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<ActionItemRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [status, setStatus] = useState("");
  const [artifact, setArtifact] = useState("");
  const [dueFilter, setDueFilter] = useState<"all" | "overdue" | "next7">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/idg/action-items", {
      params: { query: { assignee: "me" } },
    });
    if (err) {
      setError("Could not load your action items.");
      setLoading(false);
      return;
    }
    setItems((data ?? []) as ActionItemRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const now = Date.now();
  const artifactOptions = useMemo(
    () => [...new Set(items.map((a) => a.linkedArtifactKind).filter(isPresent))].sort(),
    [items],
  );

  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = items.filter((a) => {
      const due = Date.parse(a.dueDate);
      const matchesDue =
        dueFilter === "all" ||
        (dueFilter === "overdue" && isActionable(a.status) && due < now) ||
        (dueFilter === "next7" && due >= now && due <= now + 7 * 86_400_000);
      const matchesStatus = !status || a.status === status;
      const matchesArtifact = !artifact || a.linkedArtifactKind === artifact;
      const matchesSearch =
        !q ||
        a.id.toLowerCase().includes(q) ||
        a.meetingId.toLowerCase().includes(q) ||
        (a.patientId?.toLowerCase().includes(q) ?? false) ||
        a.status.toLowerCase().includes(q) ||
        (a.linkedArtifactKind?.toLowerCase().includes(q) ?? false);
      return matchesDue && matchesStatus && matchesArtifact && matchesSearch;
    });

    return [...visible].sort(
      (a, b) =>
        actionRank(a.status) - actionRank(b.status) ||
        Date.parse(a.dueDate) - Date.parse(b.dueDate),
    );
  }, [items, artifact, dueFilter, now, searchQuery, status]);

  const activeFilters = [
    searchQuery.trim() !== "",
    status !== "",
    artifact !== "",
    dueFilter !== "all",
  ].filter(Boolean).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setStatus("");
    setArtifact("");
    setDueFilter("all");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="My Action Items" breadcrumb="Clinical / IDG">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Track IDG follow-ups assigned to you by due date, status, and linked artifact.
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
              <strong>{rows.length} matching action items</strong>
            </div>
            <div style={controlGroupStyle}>
              <div style={searchWrapStyle}>
                <input
                  type="search"
                  placeholder="Search item, meeting, patient..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search IDG action items"
                  style={searchInputStyle}
                />
              </div>
              <select
                aria-label="Action item due filter"
                value={dueFilter}
                onChange={(e) => {
                  setDueFilter(e.target.value as typeof dueFilter);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="all">Due: All</option>
                <option value="overdue">Overdue</option>
                <option value="next7">Next 7 days</option>
              </select>
              <select
                aria-label="Action item status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Status: All</option>
                <option value="open">Open</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
                <option value="auto_closed">Auto closed</option>
              </select>
              <select
                aria-label="Linked artifact"
                value={artifact}
                onChange={(e) => {
                  setArtifact(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Linked: All</option>
                {artifactOptions.map((option) => (
                  <option key={option} value={option}>
                    {stateLabel(option)}
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
              title={activeFilters > 0 ? "No matching action items" : "No action items"}
              description={
                activeFilters > 0
                  ? "Try adjusting the action item filters."
                  : "You have no IDG action items assigned."
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
                  <th style={{ ...thStyle, width: "28%" }}>Action item</th>
                  <th style={{ ...thStyle, width: "18%" }}>Meeting</th>
                  <th style={{ ...thStyle, width: "18%" }}>Patient</th>
                  <th style={{ ...thStyle, width: "14%" }}>Linked</th>
                  <th style={{ ...thStyle, width: "12%" }}>Status</th>
                  <th style={{ ...thStyle, width: "10%", textAlign: "right" }}>Due</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((a) => {
                  const overdue = isActionable(a.status) && Date.parse(a.dueDate) < now;
                  return (
                    <tr key={a.id} style={rowStyle}>
                      <td style={tdStyle}>
                        <div style={primaryCellStyle}>
                          <span style={primaryTextStyle}>IDG follow-up</span>
                          <code className="wx-data-md" style={codeStyle}>
                            {shortId(a.id)}
                          </code>
                        </div>
                      </td>
                      <td style={tdStyle}>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(a.meetingId)}
                        </code>
                      </td>
                      <td style={tdStyle}>
                        {a.patientId ? (
                          <code className="wx-data-md" style={codeStyle}>
                            {shortId(a.patientId)}
                          </code>
                        ) : (
                          <span style={{ color: "var(--color-muted)" }}>—</span>
                        )}
                      </td>
                      <td style={tdStyle}>
                        {a.linkedArtifactKind ? stateLabel(a.linkedArtifactKind) : "—"}
                      </td>
                      <td style={tdStyle}>
                        <StatusPill
                          label={stateLabel(a.status)}
                          tone={ACTION_TONE[a.status] ?? "neutral"}
                        />
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "flex-end",
                            gap: "0.35rem",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {formatDate(a.dueDate)}
                          {overdue ? <StatusPill label="Overdue" tone="error" /> : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
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
              pageSizeOptions={IDG_PAGE_SIZES}
              noun="action items"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const IDG_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

function isPresent(value: string | null): value is string {
  return Boolean(value);
}

function isActionable(status: string): boolean {
  return status === "open" || status === "in_progress";
}

function actionRank(status: string): number {
  if (status === "open") return 0;
  if (status === "in_progress") return 1;
  return 2;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
