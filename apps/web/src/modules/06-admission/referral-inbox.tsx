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
} from "@wardenx/ui";
import type { CSSProperties, JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  PATIENT_RESOLUTION_LABEL,
  PATIENT_RESOLUTION_TONE,
  PRIORITY_LABEL,
  REFERRAL_TONE,
  stateLabel,
} from "./admission-status";
import { type ReferralListQuery, type ReferralView, listReferrals } from "./referrals-api";

const FILTERS = [
  ["", "All"],
  ["received", "New"],
  ["mine", "My referrals"],
  ["unassigned", "Unassigned"],
  ["pending_information", "Pending information"],
  ["qualified", "Ready"],
  ["declined", "Declined"],
] as const;

const PAGE_SIZES = [10, 15, 20, 30, 50] as const;

export function ReferralInbox(): JSX.Element {
  const client = useApiClient();
  const session = useSession();
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
    else if (filter) q.status = filter;
    if (search.trim()) q.q = search.trim();
    if (priority) q.priority = priority;
    if (resolution) q.patientResolutionStatus = resolution;
    if (source) q.source = source;
    if (includeConverted) q.includeConverted = true;
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
      received: items.filter((r) => r.status === "received").length,
      unassigned: items.filter((r) => !r.assignedToUserId).length,
      mine: items.filter((r) => r.assignedToUserId === session?.userId).length,
      pending: items.filter((r) => r.status === "pending_information").length,
      ready: items.filter((r) => r.status === "qualified").length,
    }),
    [items, session?.userId],
  );
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const paged = items.slice((activePage - 1) * pageSize, activePage * pageSize);
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
    <WorkQueueLayout
      header={
        <PageHeader
          title="Referral Inbox"
          breadcrumb="Admissions / Intake"
          actions={
            <Button tone="primary" onClick={() => navigate("/referrals/new")}>
              New Referral
            </Button>
          }
        >
          <div style={muted}>Review and manage incoming referrals before admission.</div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard label="New" value={counts.received} detail="Awaiting review" tone="info" />
          <KpiCard
            label="Unassigned"
            value={counts.unassigned}
            detail="Needs owner"
            tone="warning"
          />
          <KpiCard
            label="My referrals"
            value={counts.mine}
            detail="Assigned to you"
            tone="neutral"
          />
          <KpiCard
            label="Pending information"
            value={counts.pending}
            detail="Waiting on source"
            tone="warning"
          />
          <KpiCard
            label="Ready"
            value={counts.ready}
            detail="Qualified for admission"
            tone="success"
          />
        </KpiStrip>
      }
      filters={
        <div style={filtersStyle}>
          {error ? (
            <div role="alert" style={alert}>
              {error}
            </div>
          ) : null}
          <div style={filterRow}>
            <div style={tabs}>
              {FILTERS.map(([value, label]) => (
                <button
                  key={value || "all"}
                  type="button"
                  onClick={() => setFilter(value)}
                  style={tab(filter === value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div style={tools}>
              <div style={{ position: "relative", minWidth: "18rem" }}>
                <input
                  type="search"
                  value={search}
                  onChange={(ev) => setSearch(ev.target.value)}
                  placeholder="Search patient, source, referrer, diagnosis..."
                  aria-label="Search referrals"
                  style={{ width: "100%", paddingLeft: "2rem" }}
                />
                <span style={searchIcon}>
                  <Glyph name="search" size={14} />
                </span>
              </div>
              <select
                aria-label="Priority"
                value={priority}
                onChange={(ev) => setPriority(ev.target.value)}
              >
                <option value="">Priority: All</option>
                <option value="routine">Routine</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
              <select
                aria-label="Patient resolution"
                value={resolution}
                onChange={(ev) => setResolution(ev.target.value)}
              >
                <option value="">Patient match: All</option>
                <option value="unresolved">Not resolved</option>
                <option value="possible_match">Review match</option>
                <option value="matched">Matched</option>
                <option value="created">New patient</option>
              </select>
              <select
                aria-label="Source"
                value={source}
                onChange={(ev) => setSource(ev.target.value)}
              >
                <option value="">Source: All</option>
                <option value="phone">Phone</option>
                <option value="fax">Fax</option>
                <option value="portal">Portal</option>
                <option value="walk_in">Walk-in</option>
                <option value="self_referral">Self referral</option>
                <option value="physician_office">Physician office</option>
                <option value="hospital_discharge_planner">Hospital discharge planner</option>
              </select>
              <label style={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={includeConverted}
                  onChange={(ev) => setIncludeConverted(ev.target.checked)}
                />
                Show converted referrals
              </label>
              {filtered ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      }
      table={
        loading && items.length === 0 ? (
          <div style={loadingBox}>
            <LoadingSpinner />
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={filtered ? "No referrals match these filters." : "No referrals yet."}
              description={
                filtered
                  ? "Try another search or filter."
                  : "Create a referral to begin the intake process."
              }
            />
          </div>
        ) : (
          <>
            <ReferralTable items={paged} onOpen={(id) => navigate(`/referrals/${id}`)} />
            <div style={pager}>
              <OffsetPagination
                page={activePage}
                pageSize={pageSize}
                pageSizeOptions={[...PAGE_SIZES]}
                totalItems={items.length}
                noun="referrals"
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
              {nextCursor ? (
                <Button
                  size="sm"
                  tone="secondary"
                  onClick={() => void load(nextCursor)}
                  disabled={loading}
                >
                  Load more
                </Button>
              ) : null}
            </div>
          </>
        )
      }
    />
  );
}

function ReferralTable({
  items,
  onOpen,
}: { items: ReferralView[]; onOpen: (id: string) => void }): JSX.Element {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>Patient</th>
            <th style={th}>Source</th>
            <th style={th}>Received</th>
            <th style={th}>Diagnosis / reason</th>
            <th style={th}>Priority</th>
            <th style={th}>Owner</th>
            <th style={th}>Status</th>
            <th style={th}>Patient match</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr
              key={r.id}
              style={tr}
              className="wx-data-row-interactive"
              {...interactiveRowProps(() => onOpen(r.id), false, true)}
            >
              <td style={td}>
                <button type="button" style={linkButton} onClick={() => onOpen(r.id)}>
                  {r.patientNameAtReceipt}
                </button>
                <div style={subtext}>
                  {r.patientDobAtReceipt
                    ? `DOB ${formatDate(r.patientDobAtReceipt)}`
                    : "DOB not provided"}
                </div>
              </td>
              <td style={td}>
                <div>{r.referrerOrganization || sourceLabel(r.source)}</div>
                <div style={subtext}>{sourceLabel(r.source)}</div>
              </td>
              <td style={td}>{formatDateTime(r.receivedAt)}</td>
              <td style={{ ...td, maxWidth: "18rem" }}>
                {r.referringDxText || r.externalReferralId || "Not provided"}
              </td>
              <td style={td}>
                <PriorityBadge value={r.priority} />
              </td>
              <td style={td}>
                {r.assignedToUserId ? `Assigned to ${shortId(r.assignedToUserId)}` : "Unassigned"}
              </td>
              <td style={td}>
                <StatusPill
                  label={stateLabel(r.status)}
                  tone={REFERRAL_TONE[r.status] ?? "neutral"}
                />
              </td>
              <td style={td}>
                <StatusPill
                  label={
                    PATIENT_RESOLUTION_LABEL[r.patientResolutionStatus] ?? r.patientResolutionStatus
                  }
                  tone={PATIENT_RESOLUTION_TONE[r.patientResolutionStatus] ?? "neutral"}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

function sourceLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
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

const muted: CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: "0.875rem" };
const filtersStyle: CSSProperties = {
  padding: "0 1.5rem 0.75rem",
  display: "grid",
  gap: "0.75rem",
};
const filterRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
};
const tabs: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "0.25rem" };
const tools: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem",
  alignItems: "center",
};
const checkboxLabel: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
  fontSize: "0.875rem",
  whiteSpace: "nowrap",
};
const tab = (active: boolean): CSSProperties => ({
  border: "1px solid var(--color-outline-variant)",
  background: active ? "var(--color-primary-container)" : "var(--color-surface)",
  color: active ? "var(--color-on-primary-container)" : "var(--color-on-surface)",
  borderRadius: "8px",
  padding: "0.45rem 0.7rem",
  cursor: "pointer",
});
const searchIcon: CSSProperties = {
  position: "absolute",
  left: "0.625rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: "var(--color-on-surface-variant)",
};
const alert: CSSProperties = {
  padding: "0.65rem 0.85rem",
  borderRadius: "8px",
  border: "1px solid color-mix(in srgb, var(--color-error) 35%, transparent)",
  color: "var(--color-error-pill-fg)",
};
const loadingBox: CSSProperties = { padding: "3rem 1.5rem", textAlign: "center" };
const table: CSSProperties = { width: "100%", borderCollapse: "collapse", minWidth: "72rem" };
const th: CSSProperties = {
  textAlign: "left",
  padding: "0.75rem",
  borderBottom: "1px solid var(--color-outline-variant)",
  fontSize: "0.78rem",
  color: "var(--color-on-surface-variant)",
};
const td: CSSProperties = {
  padding: "0.85rem 0.75rem",
  borderBottom: "1px solid var(--color-outline-variant)",
  verticalAlign: "top",
};
const tr: CSSProperties = { cursor: "pointer" };
const subtext: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.78rem",
  marginTop: "0.2rem",
};
const linkButton: CSSProperties = {
  border: 0,
  background: "transparent",
  color: "var(--color-primary)",
  padding: 0,
  font: "inherit",
  fontWeight: 700,
  cursor: "pointer",
};
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
const pager: CSSProperties = {
  padding: "1rem 1.5rem",
  display: "flex",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
};
