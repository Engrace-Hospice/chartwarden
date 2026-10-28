// apps/web/src/modules/19-oncall — S19.3 ACTIVE TRIAGE QUEUE (`/triage`, §5.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_ON_CALL_TRIAGE.md — "Use Work Queue + Documentation
// Workspace." This screen is the Work-Queue half; the Documentation-Workspace half is the triage panel.
//
// The board is sorted by unresolved clinical risk, not newest-first: open escalation, red flag, then age.
// Counts are derived only from the fetched PHI page. M19 intentionally publishes no aggregate total_count.
import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import {
  type TriageCallListItem,
  type TriageCallSource,
  type TriageCallState,
  errorMessage,
  listTriageCalls,
} from "./oncall-api";
import {
  CALL_SOURCE_TONE,
  SOURCE_FILTERS,
  STATE_FILTERS,
  dateTime,
  dispositionLabel,
  durationLabel,
  humanize,
  minutesSince,
  shortId,
  toneOf,
} from "./oncall-status";
import { CallStatePill } from "./oncall-ui";

/** §4.1.1's `triageCalls` hard max. */
const QUEUE_PAGE = 100;

type AttentionFilter = "all" | "escalated" | "red_flag" | "callback" | "pending_note";

function boardRank(a: TriageCallListItem, b: TriageCallListItem): number {
  if (a.openEscalationCount !== b.openEscalationCount) {
    return b.openEscalationCount - a.openEscalationCount;
  }
  if (a.redFlagAnswerCount !== b.redFlagAnswerCount) {
    return b.redFlagAnswerCount - a.redFlagAnswerCount;
  }
  return a.openedAt.localeCompare(b.openedAt);
}

function matchesAttention(call: TriageCallListItem, filter: AttentionFilter): boolean {
  if (filter === "all") return true;
  if (filter === "escalated") return call.openEscalationCount > 0;
  if (filter === "red_flag") return call.redFlagAnswerCount > 0;
  if (filter === "callback") return call.state === "awaiting_callback";
  return call.state === "documented_pending_encounter";
}

export function TriageQueueScreen(): JSX.Element {
  const client = useApiClient();
  const [state, setState] = useState("");
  const [source, setSource] = useState<"" | TriageCallSource>("");
  const [attention, setAttention] = useState<AttentionFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [calls, setCalls] = useState<TriageCallListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      const res = await listTriageCalls(client, {
        limit: QUEUE_PAGE,
        ...(cursor ? { cursor } : {}),
        ...(state ? { state: state as TriageCallState } : { openOnly: true }),
      });
      if (res.error) {
        setError(errorMessage(res.error, "The triage queue could not be loaded."));
        setLoading(false);
        setLoadingMore(false);
        return;
      }
      setCalls((current) =>
        cursor ? current.concat(res.page?.data ?? []) : (res.page?.data ?? []),
      );
      setNextCursor(res.page?.next_cursor ?? null);
      setTruncated(res.page?.has_more ?? false);
      setLoading(false);
      setLoadingMore(false);
    },
    [client, state],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const visibleCalls = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return [...calls]
      .filter((call) => {
        const matchesSearch =
          q.length === 0 ||
          call.id.toLowerCase().includes(q) ||
          call.providerEntityId.toLowerCase().includes(q) ||
          (call.patientId ?? "").toLowerCase().includes(q) ||
          humanize(call.callerKind).toLowerCase().includes(q) ||
          humanize(call.inboundChannel).toLowerCase().includes(q) ||
          (call.protocolLabel ?? "").toLowerCase().includes(q) ||
          (call.disposition ? dispositionLabel(call.disposition).toLowerCase().includes(q) : false);
        const matchesSource = source === "" || call.source === source;
        return matchesSearch && matchesSource && matchesAttention(call, attention);
      })
      .sort(boardRank);
  }, [attention, calls, searchQuery, source]);

  const unresolved = calls.filter((call) => call.state === "escalated_unresolved").length;
  const hasActiveFilters =
    searchQuery.trim() !== "" || state !== "" || source !== "" || attention !== "all";

  const clearLocalFilters = (): void => {
    setSearchQuery("");
    setSource("");
    setAttention("all");
  };

  const clearAllFilters = (): void => {
    clearLocalFilters();
    setState("");
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Triage queue"
          actions={
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <Link to="/triage/intake" style={primaryLinkStyle}>
                Take a call
              </Link>
              <Link to="/triage/escalations" style={linkButtonStyle}>
                Escalations
              </Link>
              <Link to="/me/oncall" style={linkButtonStyle}>
                My on-call
              </Link>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Prioritize unanswered escalation, red flags, callbacks, and unsigned documentation.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {unresolved > 0 ? (
            <div role="alert" style={criticalBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>
                {unresolved} call{unresolved === 1 ? " is" : "s are"} escalated and unresolved. Only
                hand-off is allowed until escalation is acknowledged.
              </span>
            </div>
          ) : null}
          {truncated ? (
            <output style={infoBannerStyle}>
              <Glyph name="info" size={16} />
              <span>
                More rows match this server filter. Counts are page-derived; use Load more for the
                next cursor.
              </span>
            </output>
          ) : null}
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
            <label className="wx-search-field">
              <Glyph name="search" size={16} />
              <input
                type="search"
                placeholder="Search call, patient, protocol, provider..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                aria-label="Search triage calls"
              />
            </label>
            <label className="wx-filter-field">
              <span>State</span>
              <select
                className="wx-select"
                value={state}
                onChange={(event) => {
                  setState(event.target.value);
                  clearLocalFilters();
                }}
                aria-label="Filter triage calls by state"
              >
                {STATE_FILTERS.map((option) => (
                  <option key={option.key} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="wx-filter-field">
              <span>Source</span>
              <select
                className="wx-select"
                value={source}
                onChange={(event) => setSource(event.target.value as "" | TriageCallSource)}
                aria-label="Filter triage calls by source"
              >
                {SOURCE_FILTERS.map((option) => (
                  <option key={option.key} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="wx-filter-field">
              <span>Attention</span>
              <select
                className="wx-select"
                value={attention}
                onChange={(event) => setAttention(event.target.value as AttentionFilter)}
                aria-label="Filter triage calls by attention"
              >
                <option value="all">All</option>
                <option value="escalated">Escalated</option>
                <option value="red_flag">Red flags</option>
                <option value="callback">Awaiting callback</option>
                <option value="pending_note">Pending note</option>
              </select>
            </label>
            {hasActiveFilters ? (
              <Button size="sm" tone="tertiary" onClick={clearAllFilters}>
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
        ) : visibleCalls.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={hasActiveFilters ? "No matching calls" : "Nothing open on this board"}
              description={
                hasActiveFilters
                  ? "Adjust the filters or clear them to return to the loaded triage board."
                  : "A quiet board is normal. Calls outside your reach remain absent by design."
              }
              action={
                hasActiveFilters ? (
                  <Button tone="secondary" size="sm" onClick={clearAllFilters}>
                    Clear filters
                  </Button>
                ) : (
                  <Link to="/triage/intake" style={primaryLinkStyle}>
                    Take a call
                  </Link>
                )
              }
            />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={{ ...thStyle, width: "13%" }}>Call</th>
                  <th style={{ ...thStyle, width: "17%" }}>State</th>
                  <th style={{ ...thStyle, width: "14%" }}>Patient</th>
                  <th style={{ ...thStyle, width: "16%" }}>Caller</th>
                  <th style={{ ...thStyle, width: "15%" }}>Protocol</th>
                  <th style={{ ...thStyle, width: "13%" }}>Signals</th>
                  <th style={{ ...thStyle, width: "12%" }}>Open</th>
                </tr>
              </thead>
              <tbody>
                {visibleCalls.map((call) => (
                  <tr key={call.id} style={rowStyle}>
                    <td style={tdStyle}>
                      <Link to={`/triage/calls/${call.id}`} style={callLinkStyle}>
                        {shortId(call.id)}
                      </Link>
                      <div style={subtleTextStyle}>{dateTime(call.openedAt)}</div>
                    </td>
                    <td style={tdStyle}>
                      <CallStatePill state={call.state} />
                    </td>
                    <td style={tdStyle}>
                      {call.patientId ? (
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(call.patientId)}
                        </code>
                      ) : (
                        <span style={subtleTextStyle}>Not identified</span>
                      )}
                    </td>
                    <td style={tdStyle}>
                      <div style={{ color: "var(--color-on-surface)", fontWeight: 600 }}>
                        {humanize(call.callerKind)}
                      </div>
                      <div style={subtleTextStyle}>{humanize(call.inboundChannel)}</div>
                    </td>
                    <td style={tdStyle}>
                      <div style={{ color: "var(--color-on-surface)" }}>
                        {call.protocolLabel ?? "—"}
                      </div>
                      <div style={subtleTextStyle}>
                        {call.disposition ? dispositionLabel(call.disposition) : "No disposition"}
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <div style={signalStackStyle}>
                        <StatusPill
                          label={humanize(call.source)}
                          tone={toneOf(CALL_SOURCE_TONE, call.source)}
                        />
                        {call.openEscalationCount > 0 ? (
                          <StatusPill tone="error" label={`${call.openEscalationCount} esc`} />
                        ) : null}
                        {call.redFlagAnswerCount > 0 ? (
                          <StatusPill tone="critical" label={`${call.redFlagAnswerCount} red`} />
                        ) : null}
                      </div>
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {call.closedAt ? "—" : durationLabel(minutesSince(call.openedAt))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={footerStyle}>
              <span style={subtleTextStyle}>
                Showing {visibleCalls.length} of {calls.length} loaded calls
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
  minWidth: "min(100%, 20rem)",
  color: "var(--color-on-surface-variant)",
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
};

const tdStyle: CSSProperties = {
  padding: "0.875rem 1rem",
  verticalAlign: "middle",
  color: "var(--color-on-surface-variant)",
};

const rowStyle: CSSProperties = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};

const signalStackStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.35rem",
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

const linkButtonBaseStyle: CSSProperties = {
  minHeight: "2.25rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0.45rem 0.8rem",
  borderRadius: "var(--radius-md)",
  fontSize: "0.85rem",
  fontWeight: 650,
  textDecoration: "none",
};

const primaryLinkStyle: CSSProperties = {
  ...linkButtonBaseStyle,
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
};

const linkButtonStyle: CSSProperties = {
  ...linkButtonBaseStyle,
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
};

const bannerBaseStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};

const criticalBannerStyle: CSSProperties = {
  ...bannerBaseStyle,
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
};

const infoBannerStyle: CSSProperties = {
  ...bannerBaseStyle,
  background: "var(--color-primary-tint)",
  border: "1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)",
  color: "var(--color-on-surface)",
};

const errorBannerStyle: CSSProperties = {
  ...criticalBannerStyle,
  justifyContent: "space-between",
};

const dismissButtonStyle: CSSProperties = {
  border: "none",
  background: "none",
  color: "inherit",
  cursor: "pointer",
  fontWeight: 600,
};
