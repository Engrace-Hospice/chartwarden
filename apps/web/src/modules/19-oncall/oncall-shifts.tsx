// apps/web/src/modules/19-oncall — S19.5 ON-CALL SHIFT MANAGEMENT (`/triage/shifts`, §5.1, Track B /
// ADR-0030). Lists the survey-load-bearing coverage rows and creates manual shifts.
import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import {
  type CurrentOnCallView,
  type OnCallActor,
  type OnCallShiftView,
  type ShiftDiscipline,
  asOnCallActors,
  createShift,
  errorMessage,
  getCurrentOnCall,
  listShifts,
} from "./oncall-api";
import {
  DEFAULT_SHIFT_DISCIPLINE,
  SHIFT_DISCIPLINES,
  SHIFT_STATUS_TONE,
  clockTime,
  dateTime,
  disciplineLabel,
  humanize,
  nowLocalInput,
  shortDate,
  shortId,
  toInstant,
  toneOf,
} from "./oncall-status";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHIFT_PAGE = 200;

const DISCIPLINE_FILTERS = [{ value: "", label: "Discipline: All" }].concat(
  SHIFT_DISCIPLINES.map((discipline) => ({
    value: discipline,
    label: disciplineLabel(discipline),
  })),
);

type StatusFilter = "all" | OnCallShiftView["status"];
type CoverageFilter = "all" | "internal" | "external" | "m17";

function actorLabel(actor: OnCallActor): string {
  if (actor.kind === "membership") {
    return `${disciplineLabel(actor.discipline)} ${shortId(actor.membershipId)}${
      actor.isBackup ? " (backup)" : ""
    }`;
  }
  return `${actor.externalActorLabel ?? "External vendor"} ${shortId(actor.externalActorId)}`;
}

function sourceLabel(shift: OnCallShiftView): string {
  if (shift.m17VisitAssignmentRef) return "M17 roster sync";
  if (shift.externalActorId) return "Vendor";
  return "Manual";
}

function coverageMatches(shift: OnCallShiftView, filter: CoverageFilter): boolean {
  if (filter === "all") return true;
  if (filter === "external") return Boolean(shift.externalActorId);
  if (filter === "m17") return Boolean(shift.m17VisitAssignmentRef);
  return !shift.externalActorId;
}

export function OnCallShiftsScreen(): JSX.Element {
  const client = useApiClient();
  const [discipline, setDiscipline] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [coverage, setCoverage] = useState<CoverageFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [shifts, setShifts] = useState<OnCallShiftView[]>([]);
  const [current, setCurrent] = useState<CurrentOnCallView | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [providerEntityId, setProviderEntityId] = useState("");
  const [startsAt, setStartsAt] = useState(nowLocalInput());
  const [endsAt, setEndsAt] = useState(nowLocalInput(12 * 60));
  const [newDiscipline, setNewDiscipline] = useState(DEFAULT_SHIFT_DISCIPLINE);
  const [primaryMembership, setPrimaryMembership] = useState("");
  const [backupMembership, setBackupMembership] = useState("");
  const [externalActorId, setExternalActorId] = useState("");
  const [externalActorLabel, setExternalActorLabel] = useState("");

  const load = useCallback(
    async (cursor?: string) => {
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      const [list, now] = await Promise.all([
        listShifts(client, {
          limit: SHIFT_PAGE,
          ...(cursor ? { cursor } : {}),
          ...(discipline ? { discipline: discipline as ShiftDiscipline } : {}),
        }),
        // "Load more" only appends rows, so the current-on-call card is neither re-fetched nor re-set. This
        // callback must NOT close over `current`: it used to, and `setCurrent` below stores a fresh object on
        // every fetch, so `load` changed identity, the effect re-ran and the page re-fetched
        // /oncall/current + /oncall/shifts in a tight loop (~100 requests/second, indefinitely) whenever
        // someone was on call — which froze the route-walk e2e until its timeout.
        cursor ? Promise.resolve(null) : getCurrentOnCall(client, {}),
      ]);
      if (list.error) {
        setError(errorMessage(list.error, "The on-call roster could not be loaded."));
        setLoading(false);
        setLoadingMore(false);
        return;
      }
      setShifts((existing) =>
        cursor ? existing.concat(list.page?.data ?? []) : (list.page?.data ?? []),
      );
      setNextCursor(list.page?.next_cursor ?? null);
      setTruncated(list.page?.has_more ?? false);
      if (now) setCurrent(now.current);
      setLoading(false);
      setLoadingMore(false);
    },
    [client, discipline],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const visibleShifts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return [...shifts]
      .filter((shift) => {
        const matchesSearch =
          q.length === 0 ||
          shift.id.toLowerCase().includes(q) ||
          shift.providerEntityId.toLowerCase().includes(q) ||
          (shift.primaryOnCallMembershipId ?? "").toLowerCase().includes(q) ||
          (shift.backupMembershipId ?? "").toLowerCase().includes(q) ||
          (shift.externalActorId ?? "").toLowerCase().includes(q) ||
          (shift.externalActorLabel ?? "").toLowerCase().includes(q) ||
          disciplineLabel(shift.discipline).toLowerCase().includes(q) ||
          humanize(shift.status).toLowerCase().includes(q);
        const matchesStatus = status === "all" || shift.status === status;
        return matchesSearch && matchesStatus && coverageMatches(shift, coverage);
      })
      .sort((a, b) => a.shiftStartsAt.localeCompare(b.shiftStartsAt));
  }, [coverage, searchQuery, shifts, status]);

  const gapEntities = current?.perProviderEntity.filter((entity) => entity.rnCoverageGap) ?? [];

  const isExternal = newDiscipline === "external";
  const canCreate =
    UUID_RE.test(providerEntityId) &&
    startsAt !== "" &&
    endsAt !== "" &&
    Date.parse(endsAt) > Date.parse(startsAt) &&
    (isExternal ? UUID_RE.test(externalActorId) : UUID_RE.test(primaryMembership)) &&
    !busy;

  async function commitCreate(): Promise<void> {
    setBusy(true);
    setActionError(null);
    const res = await createShift(client, {
      providerEntityId,
      shiftStartsAt: toInstant(startsAt),
      shiftEndsAt: toInstant(endsAt),
      discipline: newDiscipline as ShiftDiscipline,
      ...(isExternal
        ? {
            externalActorId,
            ...(externalActorLabel ? { externalActorLabel } : {}),
          }
        : {
            primaryOnCallMembershipId: primaryMembership,
            ...(UUID_RE.test(backupMembership) ? { backupMembershipId: backupMembership } : {}),
          }),
    });
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, "The shift could not be created."));
      return;
    }
    setCreating(false);
    await load();
  }

  const hasActiveFilters =
    searchQuery.trim() !== "" || discipline !== "" || status !== "all" || coverage !== "all";

  const clearFilters = (): void => {
    setSearchQuery("");
    setDiscipline("");
    setStatus("all");
    setCoverage("all");
  };

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="On-call roster"
            breadcrumb="On-call / Shifts"
            actions={
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <Button tone="primary" onClick={() => setCreating(true)}>
                  Add shift
                </Button>
                <Link to="/triage/policy" style={linkButtonStyle}>
                  On-call policy
                </Link>
              </div>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Prove per-provider coverage and manage the scheduled on-call windows.
            </div>
          </PageHeader>
        }
        filters={
          <div style={filterShellStyle}>
            {gapEntities.length > 0 ? (
              <div role="alert" style={errorBannerStyle}>
                <Glyph name="alert" size={16} />
                <span>
                  {gapEntities.length} provider entit
                  {gapEntities.length === 1 ? "y has" : "ies have"} no RN covering right now.
                </span>
              </div>
            ) : current ? (
              <output style={successBannerStyle}>
                <Glyph name="check-circle" size={16} />
                <span>
                  Every provider entity in scope has RN coverage as of {dateTime(current.asOf)}.
                </span>
              </output>
            ) : (
              <output style={warningBannerStyle}>
                <Glyph name="alert" size={16} />
                <span>The live coverage verdict could not be read.</span>
              </output>
            )}
            {actionError ? (
              <div role="alert" style={errorBannerStyle}>
                <Glyph name="alert" size={16} />
                <span>{actionError}</span>
              </div>
            ) : null}
            {error ? (
              <div role="alert" style={errorBannerStyle}>
                <Glyph name="alert" size={16} />
                <span>{error}</span>
              </div>
            ) : null}
            <div style={coveragePanelStyle}>
              {(current?.perProviderEntity ?? []).map((entity) => {
                const actors = asOnCallActors(entity.actors);
                return (
                  <div key={entity.providerEntityId} style={coverageRowStyle}>
                    <div style={{ minWidth: 0 }}>
                      <code className="wx-data-md" style={codeStyle}>
                        {shortId(entity.providerEntityId)}
                      </code>
                      <div style={subtleTextStyle}>
                        {actors.length > 0
                          ? actors.map(actorLabel).join(" · ")
                          : "No covering actor"}
                      </div>
                    </div>
                    <StatusPill
                      label={entity.rnCoverageGap ? "Gap" : "Covered"}
                      tone={entity.rnCoverageGap ? "error" : "success"}
                    />
                  </div>
                );
              })}
            </div>
            <div style={toolbarStyle}>
              <div style={searchBoxStyle}>
                <Glyph name="eye" size={14} />
                <input
                  type="search"
                  placeholder="Search shift, provider, actor, discipline..."
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  aria-label="Search on-call shifts"
                  style={searchInputStyle}
                />
              </div>
              <select
                value={discipline}
                onChange={(event) => setDiscipline(event.target.value)}
                aria-label="Filter shifts by discipline"
                style={selectStyle}
              >
                {DISCIPLINE_FILTERS.map((option) => (
                  <option key={option.value || "all"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as StatusFilter)}
                aria-label="Filter shifts by status"
                style={selectStyle}
              >
                <option value="all">Status: All</option>
                <option value="scheduled">Scheduled</option>
                <option value="active">Active</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <select
                value={coverage}
                onChange={(event) => setCoverage(event.target.value as CoverageFilter)}
                aria-label="Filter shifts by coverage source"
                style={selectStyle}
              >
                <option value="all">Source: All</option>
                <option value="internal">Internal</option>
                <option value="external">External</option>
                <option value="m17">M17 synced</option>
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
          loading ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : visibleShifts.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title={hasActiveFilters ? "No matching shifts" : "No shifts scheduled"}
                description={
                  hasActiveFilters
                    ? "Adjust the search or clear filters to return to the loaded roster."
                    : "Add a shift, or let the M17 roster sync fill the schedule."
                }
                action={
                  hasActiveFilters ? (
                    <Button tone="secondary" size="sm" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  ) : (
                    <Button tone="primary" size="sm" onClick={() => setCreating(true)}>
                      Add shift
                    </Button>
                  )
                }
              />
            </div>
          ) : (
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead>
                  <tr style={headerRowStyle}>
                    <th style={{ ...thStyle, width: "12%" }}>Shift</th>
                    <th style={{ ...thStyle, width: "14%" }}>Provider</th>
                    <th style={{ ...thStyle, width: "20%" }}>Window</th>
                    <th style={{ ...thStyle, width: "13%" }}>Discipline</th>
                    <th style={{ ...thStyle, width: "15%" }}>Primary</th>
                    <th style={{ ...thStyle, width: "12%" }}>Source</th>
                    <th style={{ ...thStyle, width: "14%" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleShifts.map((shift) => (
                    <tr key={shift.id} style={rowStyle}>
                      <td style={tdStyle}>
                        <Link to={`/triage/shifts/${shift.id}`} style={callLinkStyle}>
                          {shortId(shift.id)}
                        </Link>
                      </td>
                      <td style={tdStyle}>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(shift.providerEntityId)}
                        </code>
                      </td>
                      <td style={tdStyle}>
                        <div style={{ color: "var(--color-on-surface)", fontWeight: 600 }}>
                          {shortDate(shift.shiftStartsAt)} {clockTime(shift.shiftStartsAt)}
                        </div>
                        <div style={subtleTextStyle}>
                          to{" "}
                          {shortDate(shift.shiftEndsAt) === shortDate(shift.shiftStartsAt)
                            ? clockTime(shift.shiftEndsAt)
                            : `${shortDate(shift.shiftEndsAt)} ${clockTime(shift.shiftEndsAt)}`}
                        </div>
                      </td>
                      <td style={tdStyle}>{disciplineLabel(shift.discipline)}</td>
                      <td style={tdStyle}>
                        {shift.externalActorId
                          ? (shift.externalActorLabel ?? "External vendor")
                          : shortId(shift.primaryOnCallMembershipId)}
                        {shift.backupMembershipId ? (
                          <div style={subtleTextStyle}>
                            Backup {shortId(shift.backupMembershipId)}
                          </div>
                        ) : null}
                      </td>
                      <td style={tdStyle}>{sourceLabel(shift)}</td>
                      <td style={tdStyle}>
                        <StatusPill
                          label={humanize(shift.status)}
                          tone={toneOf(SHIFT_STATUS_TONE, shift.status)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={footerStyle}>
                <span style={subtleTextStyle}>
                  Showing {visibleShifts.length} of {shifts.length} loaded shifts
                  {truncated ? " · more available" : ""}.
                </span>
                {nextCursor ? (
                  <Button
                    size="sm"
                    tone="secondary"
                    onClick={() => void load(nextCursor)}
                    disabled={loadingMore}
                  >
                    {loadingMore ? "Loading..." : "Load more"}
                  </Button>
                ) : null}
              </div>
            </div>
          )
        }
        fullPageScroll
      />

      {creating ? (
        <CreateShiftModal
          busy={busy}
          canCreate={canCreate}
          isExternal={isExternal}
          providerEntityId={providerEntityId}
          startsAt={startsAt}
          endsAt={endsAt}
          discipline={newDiscipline}
          primaryMembership={primaryMembership}
          backupMembership={backupMembership}
          externalActorId={externalActorId}
          externalActorLabel={externalActorLabel}
          onProviderEntityIdChange={setProviderEntityId}
          onStartsAtChange={setStartsAt}
          onEndsAtChange={setEndsAt}
          onDisciplineChange={setNewDiscipline}
          onPrimaryMembershipChange={setPrimaryMembership}
          onBackupMembershipChange={setBackupMembership}
          onExternalActorIdChange={setExternalActorId}
          onExternalActorLabelChange={setExternalActorLabel}
          onClose={() => setCreating(false)}
          onSubmit={() => void commitCreate()}
        />
      ) : null}
    </>
  );
}

function CreateShiftModal({
  busy,
  canCreate,
  isExternal,
  providerEntityId,
  startsAt,
  endsAt,
  discipline,
  primaryMembership,
  backupMembership,
  externalActorId,
  externalActorLabel,
  onProviderEntityIdChange,
  onStartsAtChange,
  onEndsAtChange,
  onDisciplineChange,
  onPrimaryMembershipChange,
  onBackupMembershipChange,
  onExternalActorIdChange,
  onExternalActorLabelChange,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  canCreate: boolean;
  isExternal: boolean;
  providerEntityId: string;
  startsAt: string;
  endsAt: string;
  discipline: string;
  primaryMembership: string;
  backupMembership: string;
  externalActorId: string;
  externalActorLabel: string;
  onProviderEntityIdChange: (value: string) => void;
  onStartsAtChange: (value: string) => void;
  onEndsAtChange: (value: string) => void;
  onDisciplineChange: (value: string) => void;
  onPrimaryMembershipChange: (value: string) => void;
  onBackupMembershipChange: (value: string) => void;
  onExternalActorIdChange: (value: string) => void;
  onExternalActorLabelChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <Modal open onClose={onClose} ariaLabel="Add on-call shift" width="38rem">
      <div style={modalBodyStyle}>
        <h2 style={modalTitleStyle}>Add an on-call shift</h2>
        <output style={infoBannerStyle}>
          <Glyph name="info" size={16} />
          <span>The policy snapshot is pinned by the server when the shift activates.</span>
        </output>
        <div style={fieldGridStyle}>
          <TextField
            label="Provider entity id"
            value={providerEntityId}
            onChange={onProviderEntityIdChange}
            mono
          />
          <TextField
            label="Starts at"
            value={startsAt}
            onChange={onStartsAtChange}
            type="datetime-local"
          />
          <TextField
            label="Ends at"
            value={endsAt}
            onChange={onEndsAtChange}
            type="datetime-local"
          />
          <label style={fieldStyle}>
            <span style={labelStyle}>Discipline</span>
            <select
              value={discipline}
              onChange={(event) => onDisciplineChange(event.target.value)}
              style={inputStyle}
            >
              {SHIFT_DISCIPLINES.map((value) => (
                <option key={value} value={value}>
                  {disciplineLabel(value)}
                </option>
              ))}
            </select>
          </label>
          {isExternal ? (
            <>
              <TextField
                label="External vendor id"
                value={externalActorId}
                onChange={onExternalActorIdChange}
                mono
              />
              <TextField
                label="Vendor-side label"
                value={externalActorLabel}
                onChange={onExternalActorLabelChange}
              />
            </>
          ) : (
            <>
              <TextField
                label="Primary membership id"
                value={primaryMembership}
                onChange={onPrimaryMembershipChange}
                mono
              />
              <TextField
                label="Backup membership id"
                value={backupMembership}
                onChange={onBackupMembershipChange}
                mono
              />
            </>
          )}
        </div>
        <div style={modalFooterStyle}>
          <Button type="button" tone="tertiary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" tone="primary" disabled={!canCreate} onClick={onSubmit}>
            {busy ? "Creating..." : "Create shift"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  mono,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "datetime-local";
  mono?: boolean;
}): JSX.Element {
  return (
    <label style={fieldStyle}>
      <span style={labelStyle}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{
          ...inputStyle,
          ...(mono ? { fontFamily: "var(--font-mono)" } : {}),
        }}
      />
    </label>
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

const coveragePanelStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))",
  gap: "0.5rem",
};

const coverageRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.65rem 0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
};

const searchBoxStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  minWidth: "min(100%, 20rem)",
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

const footerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  paddingTop: "0.875rem",
};

const subtleTextStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};

const codeStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};

const callLinkStyle: CSSProperties = {
  color: "var(--color-primary)",
  textDecoration: "none",
  fontWeight: 700,
};

const linkButtonStyle: CSSProperties = {
  minHeight: "2.25rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0.45rem 0.8rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  fontWeight: 650,
  textDecoration: "none",
};

const bannerBaseStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};

const infoBannerStyle: CSSProperties = {
  ...bannerBaseStyle,
  background: "var(--color-primary-tint)",
  border: "1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)",
  color: "var(--color-on-surface)",
};

const successBannerStyle: CSSProperties = {
  ...bannerBaseStyle,
  background: "color-mix(in srgb, var(--color-success) 10%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-success) 30%, transparent)",
  color: "var(--color-on-surface)",
};

const warningBannerStyle: CSSProperties = {
  ...bannerBaseStyle,
  background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
  color: "var(--color-on-surface)",
};

const errorBannerStyle: CSSProperties = {
  ...bannerBaseStyle,
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
};

const modalBodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "1.25rem",
};

const modalTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface)",
  fontSize: "1rem",
  fontWeight: 650,
};

const fieldGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
  gap: "0.875rem",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};

const labelStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
  fontWeight: 650,
  textTransform: "uppercase",
};

const inputStyle: CSSProperties = {
  width: "100%",
  minHeight: "2.35rem",
  padding: "0.5rem 0.65rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};

const modalFooterStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
};
