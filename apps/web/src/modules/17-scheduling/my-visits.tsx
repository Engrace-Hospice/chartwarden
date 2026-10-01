import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  interactiveRowProps,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/17-scheduling — My Visits (M17 §5.1 `/app/me/visits`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The clinician's own visits today + upcoming 7 days, mobile-
// optimized. Caseload scoping is the SERVER's job (the §4.7 `within_caseload_or_unassigned_pool` ABAC + RLS;
// ADR-0030 — no frontend authz, out-of-scope visits never appear). The "Start visit" (EVV-missing flow) action
// fills in as that write path hardens. Reads GET /api/v1/visits (date-window filtered) via the typed client.
// Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import { VISIT_TONE, stateLabel } from "./scheduling-status";
import {
  NewVisitModal,
  SchedulingNav,
  apiErrorMessage,
  findLinkedEncounter,
  hasPermission,
} from "./scheduling-workflow";
import type { VisitRow } from "./visit-table";

export function MyVisits(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [status, setStatus] = useState("");
  const [purpose, setPurpose] = useState("");
  const [dateFilter, setDateFilter] = useState<"all" | "today" | "next48">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyVisitId, setBusyVisitId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const sessionPermissions = useSession()?.permissions;

  const window = useMemo(() => {
    const from = new Date();
    const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000); // today + upcoming 7 days
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // The server resolves the caller's caseload; no clinician filter is sent (own-visits via ABAC + RLS).
    const { data, error: err } = await client.GET("/api/v1/visits", {
      params: { query: { from: window.from, to: window.to } },
    });
    if (err) {
      setError("Could not load your visits.");
      setLoading(false);
      return;
    }
    setVisits((data ?? []) as VisitRow[]);
    setLoading(false);
  }, [client, window]);

  useEffect(() => {
    void load();
  }, [load]);

  const purposeOptions = useMemo(
    () => [...new Set(visits.map((v) => v.visitPurpose).filter(Boolean))].sort(),
    [visits],
  );

  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = visits.filter((v) => {
      const matchesDate =
        dateFilter === "all" ||
        (dateFilter === "today" && isToday(v.scheduledStartedAt)) ||
        (dateFilter === "next48" && isWithinHours(v.scheduledStartedAt, 48));
      const matchesStatus = !status || v.status === status;
      const matchesPurpose = !purpose || v.visitPurpose === purpose;
      const matchesSearch =
        !q ||
        v.id.toLowerCase().includes(q) ||
        v.patientId.toLowerCase().includes(q) ||
        v.assignedMembershipId.toLowerCase().includes(q) ||
        v.visitPurpose.toLowerCase().includes(q) ||
        v.status.toLowerCase().includes(q);
      return matchesDate && matchesStatus && matchesPurpose && matchesSearch;
    });
    return [...visible].sort(
      (a, b) => Date.parse(a.scheduledStartedAt) - Date.parse(b.scheduledStartedAt),
    );
  }, [visits, dateFilter, purpose, searchQuery, status]);

  const activeFilters = [
    searchQuery.trim() !== "",
    status !== "",
    purpose !== "",
    dateFilter !== "all",
  ].filter(Boolean).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setStatus("");
    setPurpose("");
    setDateFilter("all");
    setPage(1);
  };

  async function visitAction(
    visit: VisitRow,
    action: "start" | "arrive" | "encounter",
  ): Promise<void> {
    setBusyVisitId(visit.id);
    setActionNotice(null);
    if (action === "encounter") {
      const linked = await findLinkedEncounter(client, visit);
      setBusyVisitId(null);
      if (linked) navigate(`/patients/${linked.patientId}/encounters/${linked.id}`);
      else
        setActionNotice("Encounter draft is still being created. Refresh the visit in a moment.");
      return;
    }
    const { error: err } =
      action === "start"
        ? await client.POST("/api/v1/visits/{visitId}/start", {
            params: { path: { visitId: visit.id } },
            body: {},
          })
        : await client.POST("/api/v1/visits/{visitId}/arrive", {
            params: { path: { visitId: visit.id } },
            body: {},
          });
    setBusyVisitId(null);
    if (err) {
      setError(
        apiErrorMessage(err, action === "start" ? "Could not start visit." : "Could not check in."),
      );
      return;
    }
    await load();
  }

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader title="My Visits" breadcrumb="Field / Scheduling">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Review your scheduled visits for today and the upcoming week.
            </div>
          </PageHeader>
        }
        filters={
          <div style={filterShellStyle}>
            <SchedulingNav onNewVisit={() => setCreating(true)} />
            {error ? (
              <div role="alert" style={errorBannerStyle}>
                <span>{error}</span>
                <button type="button" onClick={() => setError(null)} style={dismissButtonStyle}>
                  x
                </button>
              </div>
            ) : null}
            {actionNotice ? <output style={noticeBannerStyle}>{actionNotice}</output> : null}
            <div style={toolbarStyle}>
              <div style={toolbarTitleStyle}>
                <span style={toolbarEyebrowStyle}>Schedule</span>
                <strong>{rows.length} matching visits</strong>
              </div>
              <div style={controlGroupStyle}>
                <div style={searchWrapStyle}>
                  <input
                    type="search"
                    placeholder="Search visit, patient, clinician..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setPage(1);
                    }}
                    aria-label="Search my visits"
                    style={searchInputStyle}
                  />
                </div>
                <select
                  aria-label="Visit status"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="">Status: All</option>
                  <option value="published">Published</option>
                  <option value="en_route">En route</option>
                  <option value="in_visit">In visit</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="rescheduled">Rescheduled</option>
                </select>
                <select
                  aria-label="Visit purpose"
                  value={purpose}
                  onChange={(e) => {
                    setPurpose(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="">Purpose: All</option>
                  {purposeOptions.map((option) => (
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
          ) : loading && visits.length === 0 ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title={activeFilters > 0 ? "No matching visits" : "No upcoming visits"}
                description={
                  activeFilters > 0
                    ? "Try adjusting the schedule filters."
                    : "You have no visits scheduled in the next 7 days."
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
                    <th style={{ ...thStyle, width: "28%" }}>Visit</th>
                    <th style={{ ...thStyle, width: "18%" }}>Patient</th>
                    <th style={{ ...thStyle, width: "14%" }}>Purpose</th>
                    <th style={{ ...thStyle, width: "14%" }}>Start</th>
                    <th style={{ ...thStyle, width: "14%" }}>End</th>
                    <th style={{ ...thStyle, width: "12%", textAlign: "right" }}>Status</th>
                    <th style={{ ...thStyle, width: "18%", textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((v) => (
                    <tr
                      key={v.id}
                      {...interactiveRowProps(
                        () => navigate(`/scheduling/visits/${v.id}`),
                        false,
                        true,
                      )}
                      style={rowStyle}
                      className="wx-data-row-interactive"
                    >
                      <td style={tdStyle}>
                        <div style={primaryCellStyle}>
                          <span style={primaryTextStyle}>Scheduled visit</span>
                          <code className="wx-data-md" style={codeStyle}>
                            {shortId(v.id)}
                          </code>
                        </div>
                      </td>
                      <td style={tdStyle}>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(v.patientId)}
                        </code>
                      </td>
                      <td style={tdStyle}>{stateLabel(v.visitPurpose)}</td>
                      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                        {formatDateTime(v.scheduledStartedAt)}
                      </td>
                      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                        {formatDateTime(v.scheduledEndedAt)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <StatusPill
                          label={stateLabel(v.status)}
                          tone={VISIT_TONE[v.status] ?? "neutral"}
                        />
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <div style={rowActionsStyle}>
                          {v.status === "published" &&
                          hasPermission(sessionPermissions, "visit.start") ? (
                            <Button
                              size="sm"
                              tone="secondary"
                              aria-label={`Start visit ${shortId(v.id)}`}
                              loading={busyVisitId === v.id}
                              onClick={(event) => {
                                event.stopPropagation();
                                void visitAction(v, "start");
                              }}
                            >
                              <Glyph name="clock" size={13} /> Start
                            </Button>
                          ) : null}
                          {v.status === "en_route" &&
                          hasPermission(sessionPermissions, "visit.start") ? (
                            <Button
                              size="sm"
                              aria-label={`Check in visit ${shortId(v.id)}`}
                              loading={busyVisitId === v.id}
                              onClick={(event) => {
                                event.stopPropagation();
                                void visitAction(v, "arrive");
                              }}
                            >
                              <Glyph name="check" size={13} /> Check in
                            </Button>
                          ) : null}
                          {["published", "en_route", "in_visit", "completed"].includes(v.status) ? (
                            <Button
                              size="sm"
                              tone="tertiary"
                              aria-label={`Open encounter for visit ${shortId(v.id)}`}
                              loading={busyVisitId === v.id}
                              onClick={(event) => {
                                event.stopPropagation();
                                void visitAction(v, "encounter");
                              }}
                            >
                              <Glyph name="file-text" size={13} /> Encounter
                            </Button>
                          ) : null}
                        </div>
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
                pageSizeOptions={FIELD_PAGE_SIZES}
                noun="visits"
              />
            </div>
          )
        }
        fullPageScroll
      />
      <NewVisitModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(visit) => {
          setCreating(false);
          navigate(`/scheduling/visits/${visit.id}`);
        }}
      />
    </>
  );
}

const FIELD_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function isWithinHours(iso: string, hours: number): boolean {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) return false;
  const delta = value - Date.now();
  return delta >= 0 && delta <= hours * 3_600_000;
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

const noticeBannerStyle = {
  // Rendered on an <output> (implicit role="status"), which is inline by default.
  display: "block",
  padding: "0.65rem 0.85rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-primary-tint)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};

const rowActionsStyle = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.35rem",
  flexWrap: "wrap" as const,
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
