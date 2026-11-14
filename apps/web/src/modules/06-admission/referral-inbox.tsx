import {
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  StatusPill,
  formatDateOnly,
  interactiveRowProps,
  t,
  useApiClient,
} from "@chartwarden/ui";
import type { CSSProperties, JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  PATIENT_RESOLUTION_LABEL,
  PATIENT_RESOLUTION_TONE,
  PRIORITY_LABEL,
  REFERRAL_TONE,
  stateLabel,
} from "./admission-status";
import { AdmissionsTabs, Avatar, Filter, Stat } from "./admissions-chrome";
import { INTAKE_WORKLIST_LABEL, deriveIntakeWorkspace } from "./intake-workspace-stage";
import { type ReferralListQuery, type ReferralView, listReferrals } from "./referrals-api";

const FILTERS = [
  ["", "All"],
  ["needs_review", "Needs review"],
  ["waiting", "Waiting on information"],
  ["ready", "Ready to start admission"],
  ["in_progress", "In progress"],
  ["closed", "Completed / closed"],
  ["mine", "Assigned to me"],
  ["unassigned", "Unassigned"],
] as const;

const PAGE_SIZES = [10, 15, 20, 30, 50] as const;

export function ReferralInbox(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<ReferralView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState("");
  const [resolution, setResolution] = useState("");
  const [source, setSource] = useState("");
  const [includeConverted, setIncludeConverted] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  const query = useMemo<ReferralListQuery>(() => {
    const q: ReferralListQuery = { limit: 100 };
    if (filter === "mine") q.assigned = "mine";
    else if (filter === "unassigned") q.assigned = "unassigned";
    else if (filter === "needs_review") q.status = "received";
    else if (filter === "waiting") q.status = "pending_information";
    else if (filter === "ready") q.status = "qualified";
    else if (filter === "in_progress") q.status = "under_review";
    if (search.trim()) q.q = search.trim();
    if (priority) q.priority = priority;
    if (resolution) q.patientResolutionStatus = resolution;
    if (source) q.source = source;
    if (includeConverted || filter === "closed") q.includeConverted = true;
    return q;
  }, [filter, includeConverted, priority, resolution, search, source]);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const data = await listReferrals(client, { ...query, ...(cursor ? { cursor } : {}) });
        setItems((prev) => (cursor ? [...prev, ...data.items] : data.items));
        setNextCursor(data.nextCursor);
      } catch (err) {
        setError(errorMessage(err, "Could not load the referral inbox."));
      } finally {
        setLoading(false);
      }
    },
    [client, query],
  );

  useEffect(() => {
    setPage(1);
    void load();
  }, [load]);

  const counts = useMemo(
    () => ({
      needsReview: items.filter((r) => r.status === "received").length,
      waiting: items.filter((r) => r.status === "pending_information").length,
      ready: items.filter((r) => r.status === "qualified").length,
      inProgress: items.filter((r) => r.status === "under_review").length,
      closed: items.filter((r) => isClosed(r.status)).length,
    }),
    [items],
  );
  const visibleItems = useMemo(
    () => (filter === "closed" ? items.filter((item) => isClosed(item.status)) : items),
    [filter, items],
  );
  const pageCount = Math.max(1, Math.ceil(visibleItems.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const paged = visibleItems.slice((activePage - 1) * pageSize, activePage * pageSize);
  const filtered = filter || search || priority || resolution || source || includeConverted;

  function clearFilters(): void {
    setFilter("");
    setSearch("");
    setPriority("");
    setResolution("");
    setSource("");
    setIncludeConverted(false);
    setPage(1);
  }

  return (
    <div className="wx-admissions">
      <div className="wx-admissions-main">
        <header className="wx-page-head">
          <div>
            <h1 style={{ fontSize: "1.875rem" }}>Intake</h1>
            <p>Review incoming referrals and continue the next required intake task.</p>
          </div>
          <Link to="/referrals/new" className="wx-btn-primary">
            <Glyph name="plus" size={16} /> New intake
          </Link>
        </header>

        <AdmissionsTabs current="/referrals" />

        <p className="wx-row-sub" style={{ margin: "0 0 0.5rem" }}>
          Counts reflect referrals currently loaded in this view.
        </p>
        <div className="wx-stat-grid wx-stat-grid-5" aria-label="Loaded intake summary">
          <Stat
            icon="file-text"
            value={counts.needsReview}
            label="Needs review"
            hint="In loaded results"
          />
          <Stat
            icon="clock"
            value={counts.waiting}
            label="Waiting on information"
            hint="In loaded results"
            color="var(--color-viz-amber)"
          />
          <Stat
            icon="check-circle"
            value={counts.ready}
            label="Ready to start admission"
            hint="In loaded results"
            color={t.success}
          />
          <Stat
            icon="users"
            value={counts.inProgress}
            label="In progress"
            hint="In loaded results"
            color="var(--color-viz-violet)"
          />
          <Stat
            icon="file-check"
            value={counts.closed}
            label="Completed / closed"
            hint="In loaded results"
          />
        </div>

        <div className="wx-filter-panel">
          <label className="wx-search-field">
            <Glyph name="search" size={16} />
            <input
              type="search"
              value={search}
              onChange={(ev) => setSearch(ev.target.value)}
              placeholder="Search patient, source, referrer, diagnosis…"
              aria-label="Search referrals"
            />
          </label>
          <Filter label="Queue" value={filter} onChange={setFilter} ariaLabel="Referral queue">
            {FILTERS.map(([value, label]) => (
              <option key={value || "all"} value={value}>
                {label}
              </option>
            ))}
          </Filter>
          <Filter label="Priority" value={priority} onChange={setPriority}>
            <option value="">All</option>
            <option value="routine">Routine</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Filter>
          <Filter
            label="Patient match"
            value={resolution}
            onChange={setResolution}
            ariaLabel="Patient resolution"
          >
            <option value="">All</option>
            <option value="unresolved">Not resolved</option>
            <option value="possible_match">Review match</option>
            <option value="matched">Matched</option>
            <option value="created">New patient</option>
          </Filter>
          <Filter label="Source" value={source} onChange={setSource}>
            <option value="">All</option>
            <option value="phone">Phone</option>
            <option value="fax">Fax</option>
            <option value="portal">Portal</option>
            <option value="walk_in">Walk-in</option>
            <option value="self_referral">Self referral</option>
            <option value="physician_office">Physician office</option>
            <option value="hospital_discharge_planner">Hospital discharge planner</option>
          </Filter>
          <label className="wx-filter-check">
            <input
              type="checkbox"
              checked={includeConverted}
              onChange={(ev) => setIncludeConverted(ev.target.checked)}
            />
            Show converted referrals
          </label>
          {filtered ? (
            <button type="button" className="wx-btn-secondary" onClick={clearFilters}>
              <Glyph name="filter" size={15} /> Clear
            </button>
          ) : null}
        </div>

        {error ? (
          <div className="wx-list-state" role="alert">
            <EmptyState title="Referrals unavailable" description={error} />
            <button type="button" className="wx-btn-secondary" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : visibleItems.length === 0 ? (
          <div className="wx-list-state">
            <EmptyState
              title={filtered ? "No referrals match these filters." : "No referrals yet."}
              description={
                filtered
                  ? "Try another search or filter."
                  : "Create a referral to begin the intake process."
              }
            />
            {filtered ? (
              <button type="button" className="wx-btn-secondary" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null}
            {nextCursor ? (
              <button
                type="button"
                className="wx-btn-secondary"
                onClick={() => void load(nextCursor)}
                disabled={loading}
              >
                Load more
              </button>
            ) : null}
          </div>
        ) : (
          <div className="wx-list-table-wrap">
            <ReferralTable items={paged} onOpen={(id) => navigate(`/referrals/${id}/intake`)} />
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              pageSizeOptions={[...PAGE_SIZES]}
              totalItems={visibleItems.length}
              noun="referrals"
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
            {nextCursor ? (
              <div style={{ display: "flex", justifyContent: "center", padding: "0 1rem 1rem" }}>
                <button
                  type="button"
                  className="wx-btn-secondary"
                  onClick={() => void load(nextCursor)}
                  disabled={loading}
                >
                  Load more
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ReferralTable({
  items,
  onOpen,
}: { items: ReferralView[]; onOpen: (id: string) => void }): JSX.Element {
  return (
    <table className="wx-list-table" style={{ minWidth: "64rem" }}>
      <caption className="wx-sr-only">Referrals</caption>
      <thead>
        <tr>
          <th scope="col">Patient</th>
          <th scope="col">Source</th>
          <th scope="col">Received</th>
          <th scope="col">Diagnosis / reason</th>
          <th scope="col">Priority</th>
          <th scope="col">Owner</th>
          <th scope="col">Status</th>
          <th scope="col">Patient match</th>
          <th scope="col">Next action</th>
        </tr>
      </thead>
      <tbody>
        {items.map((r) => (
          <tr
            key={r.id}
            className="wx-data-row-interactive"
            {...interactiveRowProps(() => onOpen(r.id), false, true)}
          >
            <td>
              <span style={{ display: "flex", alignItems: "center", gap: "0.625rem" }}>
                <Avatar name={firstLast(r.patientNameAtReceipt)} />
                <span style={{ minWidth: 0 }}>
                  <button type="button" className="wx-row-title" onClick={() => onOpen(r.id)}>
                    {r.patientNameAtReceipt}
                  </button>
                  <span className="wx-row-sub">
                    {r.patientDobAtReceipt
                      ? `DOB ${formatDateOnly(r.patientDobAtReceipt)}`
                      : "DOB not provided"}
                  </span>
                </span>
              </span>
            </td>
            <td>
              <span style={{ display: "block" }}>
                {r.referrerOrganization || sourceLabel(r.source)}
              </span>
              <span className="wx-row-sub">{sourceLabel(r.source)}</span>
            </td>
            <td className="wx-nums" style={{ whiteSpace: "nowrap" }}>
              {formatDateTime(r.receivedAt)}
            </td>
            <td style={{ maxWidth: "18rem" }}>
              {r.referringDxText || r.externalReferralId || "Not provided"}
            </td>
            <td>
              <PriorityBadge value={r.priority} />
            </td>
            <td>
              {r.assignedToUserId
                ? `Assigned to ${r.assignedToDisplayName || "Staff member"}`
                : "Unassigned"}
            </td>
            <td>
              <StatusPill
                label={INTAKE_WORKLIST_LABEL[r.status]}
                tone={REFERRAL_TONE[r.status] ?? "neutral"}
              />
              <span className="wx-row-sub">{stateLabel(r.status)}</span>
            </td>
            <td>
              <StatusPill
                label={
                  PATIENT_RESOLUTION_LABEL[r.patientResolutionStatus] ?? r.patientResolutionStatus
                }
                tone={PATIENT_RESOLUTION_TONE[r.patientResolutionStatus] ?? "neutral"}
              />
            </td>
            <td>
              <Link className="wx-row-title" to={`/referrals/${r.id}/intake`}>
                {deriveIntakeWorkspace(r).primaryAction.label}
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PriorityBadge({ value }: { value: string }): JSX.Element {
  const urgent = value === "urgent";
  return (
    <span style={{ ...priorityBadge, ...(urgent ? urgentBadge : {}) }}>
      {PRIORITY_LABEL[value] ?? value}
    </span>
  );
}

// Referral names often arrive "LAST, FIRST"; the avatar's initials read first-then-last.
function firstLast(name: string): string {
  const [last, first] = name.split(",").map((part) => part.trim());
  return first ? `${first} ${last}` : name;
}

function sourceLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function isClosed(status: ReferralView["status"]): boolean {
  return ["converted", "declined", "duplicate", "withdrawn"].includes(status);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function errorMessage(err: unknown, fallback: string): string {
  const e = err as { error?: { message?: string }; message?: string };
  return e.error?.message ?? e.message ?? fallback;
}

const priorityBadge: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "999px",
  padding: "0.18rem 0.5rem",
  fontSize: "0.78rem",
};
const urgentBadge: CSSProperties = {
  borderColor: "var(--color-error)",
  color: "var(--color-error)",
  fontWeight: 700,
};
