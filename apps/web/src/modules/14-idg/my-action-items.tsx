import {
  EmptyState,
  ErrorState,
  Glyph,
  LoadingSpinner,
  Panel,
  StatusPill,
  t,
  tint,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/14-idg — My Action Items (M14 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md — "Use Work Queue + Documentation Workspace". The
// caller's queue of IDG action items assigned to them (`assignee=me` resolves to the caller's membership
// server-side), one row per item with its status + due date + linked-artifact kind.
//
// #91 — the STATUS TRANSITIONS are here now. A queue of follow-ups the assignee could read and never
// advance is the shape this issue is about; `PATCH /api/v1/idg/action-items/:id` was mounted, guarded by
// `idg.act` and contract-enriched the whole time. An item is never RE-OPENED — `open` is genesis-only in
// the §1.1/D8 machine — so the three offered transitions are the three the route accepts.
//
// 2026-09 redesign: the org-level page anatomy shared with Billing / Admissions (idg-page-kit.tsx: page
// head, sub-page tabs, label-first KPI strip, boxed filter panel, table + footer, right rail), meeting / patient
// deep links, an assignee column and a carry-forward flag. CARRY-FORWARD IS DERIVED, not returned: the
// route has no carry-forward field, so an open / in-progress item past its due date is flagged (the spec's
// "overdue action items from prior meetings"); the 3+ compliance alert is a client-side advisory of the
// same count, not the server's alert. OMITTED because no route returns them: assignee display name and
// discipline (only `assignedToMembershipId`; the queue is `assignee=me`, so it is the caller), action-item
// title/description, and the linked artifact's id-resolved name. `linkedArtifactId` / `decisionId` are
// returned but not drawn (no reader screen to link to).
//
// The link-artifact and add-note surfaces stay deferred: no route mints either. The SERVER owns the §2.7
// auto-close (an item linked to a downstream artifact closes when that artifact reaches an absorbing state)
// and the §4.7 is_assignee ABAC (ADR-0030 — no frontend authz). Reads GET /api/v1/idg/action-items via the
// typed client.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../../shell/session";
import { type ActionItemPatchStatus, updateActionItem } from "./idg-api";
import {
  IdgFilter,
  IdgFilterPanel,
  IdgPageHead,
  IdgStat,
  IdgSubtabs,
  IdgTableFooter,
  PAGE_SIZE,
} from "./idg-page-kit";
import { PatientLabel, type PatientRef, patientText, shortId } from "./idg-people";
import { ACTION_TONE, stateLabel } from "./idg-status";

/** The three statuses `PATCH /idg/action-items/:id` accepts (`open` is genesis-only). */
const PATCH_STATUSES = [
  { value: "in_progress", label: "Start" },
  { value: "completed", label: "Complete" },
  { value: "cancelled", label: "Cancel" },
] as const satisfies readonly { value: ActionItemPatchStatus; label: string }[];

interface ActionItemRow {
  id: string;
  meetingId: string;
  patientId: string | null;
  patient?: PatientRef | null;
  assignedToMembershipId: string;
  status: string;
  dueDate: string;
  linkedArtifactKind: string | null;
  version: number;
}

export function MyActionItems(): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const canAct =
    session?.permissions?.includes("idg.act") ||
    session?.permissions?.includes("idg.coordinate") ||
    false;
  const [items, setItems] = useState<ActionItemRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [status, setStatus] = useState("");
  const [artifact, setArtifact] = useState("");
  const [dueFilter, setDueFilter] = useState<"all" | "overdue" | "next7">("all");
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ kind: "forbidden" | "error"; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err, response } = await client.GET("/api/v1/idg/action-items", {
      params: { query: { assignee: "me" } },
    });
    if (err) {
      setError({
        kind: response.status === 403 || response.status === 404 ? "forbidden" : "error",
        message:
          response.status === 403 || response.status === 404
            ? "Your current role cannot open this IDG work queue."
            : "Could not load your action items.",
      });
      setLoading(false);
      return;
    }
    setItems((data ?? []) as ActionItemRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Advance one item. The SERVER decides whether the transition is legal (`transitionActionItem`) and
   * whether this caller may make it (`is_assignee`); a refusal is rendered here rather than pre-empted.
   */
  async function advance(itemId: string, status: ActionItemPatchStatus): Promise<void> {
    setBusyId(itemId);
    setNotice(null);
    const version = items.find((i) => i.id === itemId)?.version ?? 0;
    const res = await updateActionItem(client, itemId, status, version);
    setBusyId(null);
    setNotice(res.ok ? `Action item ${shortId(itemId)} → ${stateLabel(status)}.` : res.message);
    if (res.ok) await load();
  }

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
        (a.patient?.displayName.toLowerCase().includes(q) ?? false) ||
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
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const activePage = Math.min(page, pageCount);
  const pagedRows = rows.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE);

  const kpis = useMemo(() => {
    const count = (s: string) => items.filter((a) => a.status === s).length;
    return {
      open: count("open"),
      inProgress: count("in_progress"),
      overdue: items.filter((a) => isActionable(a.status) && Date.parse(a.dueDate) < now).length,
      done: items.filter((a) => a.status === "completed" || a.status === "auto_closed").length,
    };
  }, [items, now]);

  const clearFilters = (): void => {
    setSearchQuery("");
    setStatus("");
    setArtifact("");
    setDueFilter("all");
    setPage(1);
  };

  const upcoming = items
    .filter((a) => isActionable(a.status))
    .sort((a, b) => Date.parse(a.dueDate) - Date.parse(b.dueDate))
    .slice(0, 4);
  const statusMix = ["open", "in_progress", "completed", "auto_closed", "cancelled"]
    .map((s) => ({ status: s, count: items.filter((a) => a.status === s).length }))
    .filter((s) => s.count > 0);
  const maxMix = Math.max(...statusMix.map((s) => s.count), 1);

  return (
    <div className="wx-with-rail">
      <div className="wx-with-rail-main" aria-busy={loading}>
        <IdgPageHead
          title="My Action Items"
          subtitle="Track IDG follow-ups assigned to you by due date, status, and linked artifact."
          actions={
            <Link to="/idg/schedule" className="wx-btn-secondary">
              <Glyph name="calendar" size={16} /> IDG Schedule
            </Link>
          }
        />

        <IdgSubtabs current="actions" />

        {notice ? (
          <output aria-live="polite" style={{ fontSize: "0.8125rem", color: t.onSurfaceVariant }}>{notice}</output>
        ) : null}

        <div className="wx-stat-grid" aria-label="Action item summary">
          <IdgStat icon="clipboard-check" label="Open" value={kpis.open} hint="Not started" />
          <IdgStat
            icon="activity"
            label="In progress"
            value={kpis.inProgress}
            hint="Being worked"
            color="var(--color-viz-violet)"
          />
          <IdgStat
            icon="alert"
            label="Carry-forward"
            value={kpis.overdue}
            hint={kpis.overdue ? "Overdue, still open" : "None overdue"}
            color={kpis.overdue ? t.error : t.primary}
          />
          <IdgStat
            icon="check-circle"
            label="Closed"
            value={kpis.done}
            hint="Finished items"
            color={t.success}
          />
        </div>

        {kpis.overdue >= 3 ? (
          <output style={warnBannerStyle}>
            <Glyph name="alert" size={16} />
            <span>
              {kpis.overdue} overdue items are carrying forward. Three or more carry-forwards are a
              compliance concern for the IDG review.
            </span>
          </output>
        ) : null}

        <IdgFilterPanel
          searchLabel="Search IDG action items"
          placeholder="Search by item, meeting or patient…"
          search={searchQuery}
          onSearch={(v) => {
            setSearchQuery(v);
            setPage(1);
          }}
          onClear={activeFilters > 0 ? clearFilters : undefined}
        >
          <IdgFilter
            label="Due"
            ariaLabel="Action item due filter"
            value={dueFilter}
            onChange={(v) => {
              setDueFilter(v as typeof dueFilter);
              setPage(1);
            }}
          >
            <option value="all">All due dates</option>
            <option value="overdue">Overdue</option>
            <option value="next7">Next 7 days</option>
          </IdgFilter>
          <IdgFilter
            label="Status"
            ariaLabel="Action item status"
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          >
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="auto_closed">Auto closed</option>
          </IdgFilter>
          <IdgFilter
            label="Linked"
            ariaLabel="Linked artifact"
            value={artifact}
            onChange={(v) => {
              setArtifact(v);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {artifactOptions.map((option) => (
              <option key={option} value={option}>
                {stateLabel(option)}
              </option>
            ))}
          </IdgFilter>
        </IdgFilterPanel>

        {error ? (
          <div className="wx-list-state">
            <ErrorState
              title={error.kind === "forbidden" ? "Work queue unavailable" : "Action items unavailable"}
              description={error.message}
              onRetry={() => void load()}
              action={<Link to="/idg/schedule">Back to IDG schedule</Link>}
            />
          </div>
        ) : loading && items.length === 0 ? (
          <div className="wx-list-state">
            <LoadingSpinner />
          </div>
        ) : rows.length === 0 ? (
          <div className="wx-list-state">
            <EmptyState
              title={activeFilters > 0 ? "No matching action items" : "No action items"}
              description={
                activeFilters > 0
                  ? "Try adjusting the action item filters."
                  : "You have no IDG action items assigned."
              }
            />
            {activeFilters > 0 ? (
              <button type="button" className="wx-btn-secondary" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null}
          </div>
        ) : (
          <div className="wx-list-table-wrap">
            <table className="wx-list-table wx-list-table-static">
              <caption className="wx-sr-only">My IDG action items</caption>
              <thead>
                <tr>
                  <th scope="col">Action item</th>
                  <th scope="col">Meeting</th>
                  <th scope="col">Patient</th>
                  <th scope="col">Assignee</th>
                  <th scope="col">Linked</th>
                  <th scope="col">Status</th>
                  <th scope="col">Due</th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    Advance
                  </th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((a) => {
                  const overdue = isActionable(a.status) && Date.parse(a.dueDate) < now;
                  return (
                    <tr key={a.id}>
                      <td>
                        <span className="wx-row-title">IDG follow-up</span>
                        <span className="wx-row-sub wx-nums">{shortId(a.id)}</span>
                      </td>
                      <td className="wx-nums">
                        <Link to={`/idg/meetings/${a.meetingId}`}>{shortId(a.meetingId)}</Link>
                      </td>
                      <td>
                        {a.patientId ? (
                          <Link
                            to={`/patients/${a.patientId}/idg-history`}
                            aria-label={`IDG history for ${patientText(a.patientId, a.patient)}`}
                          >
                            <PatientLabel patientId={a.patientId} patient={a.patient} />
                          </Link>
                        ) : (
                          <span style={{ color: t.muted }}>—</span>
                        )}
                      </td>
                      <td title={a.assignedToMembershipId}>
                        You{" "}
                        <span className="wx-row-sub">({shortId(a.assignedToMembershipId)})</span>
                      </td>
                      <td>{a.linkedArtifactKind ? stateLabel(a.linkedArtifactKind) : "—"}</td>
                      <td>
                        <StatusPill
                          label={stateLabel(a.status)}
                          tone={ACTION_TONE[a.status] ?? "neutral"}
                        />
                      </td>
                      <td className="wx-nums">
                        {formatDate(a.dueDate)}
                        {overdue ? (
                          <div style={{ marginTop: "0.25rem" }}>
                            <StatusPill label="Carry-forward" tone="error" />
                          </div>
                        ) : null}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {isActionable(a.status) && canAct ? (
                          <span style={{ display: "inline-flex", gap: "0.375rem" }}>
                            {PATCH_STATUSES.filter(
                              (p) => !(a.status === "in_progress" && p.value === "in_progress"),
                            ).map((p) => (
                              <button
                                key={p.value}
                                type="button"
                                className="wx-btn-secondary wx-btn-sm"
                                disabled={busyId === a.id}
                                onClick={() => void advance(a.id, p.value)}
                              >
                                {p.label}
                              </button>
                            ))}
                          </span>
                        ) : (
                          <span style={{ color: t.muted }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <IdgTableFooter
              page={activePage}
              pages={pageCount}
              pageSize={PAGE_SIZE}
              total={rows.length}
              noun="action items"
              onPage={setPage}
            />
          </div>
        )}
      </div>

      <aside className="wx-with-rail-side" aria-label="Action item context">
        <Panel title="Due next" icon="clock">
          {upcoming.length === 0 ? (
            <p className="wx-rail-empty" style={{ padding: 0 }}>
              {loading ? "Loading…" : "Nothing open or in progress."}
            </p>
          ) : (
            <ul
              style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.625rem" }}
            >
              {upcoming.map((a) => {
                const overdue = Date.parse(a.dueDate) < now;
                return (
                  <li
                    key={a.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "0.5rem",
                      fontSize: "0.8125rem",
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <Link to={`/idg/meetings/${a.meetingId}`} className="wx-row-title">
                        Meeting {shortId(a.meetingId)}
                      </Link>
                      <span className="wx-row-sub">
                        {a.patientId ? patientText(a.patientId, a.patient) : "No patient"}
                      </span>
                    </span>
                    <span
                      className="wx-nums"
                      style={{ color: overdue ? t.error : undefined, whiteSpace: "nowrap" }}
                    >
                      {formatDate(a.dueDate)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Quick actions" icon="zap">
          <div style={{ display: "grid", gap: "0.5rem" }}>
            <Link
              to="/idg/schedule"
              className="wx-btn-secondary"
              style={{ justifyContent: "flex-start" }}
            >
              <Glyph name="calendar" size={16} /> IDG schedule
            </Link>
            <button
              type="button"
              className="wx-btn-secondary"
              style={{ justifyContent: "flex-start" }}
              disabled={kpis.overdue === 0}
              onClick={() => {
                clearFilters();
                setDueFilter("overdue");
              }}
            >
              <Glyph name="alert" size={16} /> Show carry-forward
            </button>
          </div>
        </Panel>

        <Panel title="Items by status" icon="bar-chart">
          {statusMix.length === 0 ? (
            <p className="wx-rail-empty" style={{ padding: 0 }}>
              No action items assigned.
            </p>
          ) : (
            <ul className="wx-hbars">
              {statusMix.map((s) => (
                <li key={s.status}>
                  <span>{stateLabel(s.status)}</span>
                  <span className="wx-hbar-track">
                    <span style={{ width: `${(s.count / maxMix) * 100}%` }} />
                  </span>
                  <strong className="wx-nums">{s.count}</strong>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </aside>
    </div>
  );
}

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

const warnBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: t.radiusMd,
  background: tint(t.warning),
  color: t.warning,
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
} as const;
