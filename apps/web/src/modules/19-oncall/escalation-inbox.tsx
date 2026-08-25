// apps/web/src/modules/19-oncall — S19.4 ESCALATION INBOX (`/triage/escalations`, §5.1, Track B /
// ADR-0030). Mandatory rows sort first, then ladder rung, then server-computed minutes open.
import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
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
  type EscalationInboxItem,
  type EscalationTier,
  acknowledgeEscalation,
  errorMessage,
  listEscalations,
  resolveEscalation,
} from "./oncall-api";
import {
  ESCALATION_STATE_TONE,
  ESCALATION_TIERS,
  dateTime,
  durationLabel,
  humanize,
  shortId,
  tierLabel,
  toneOf,
} from "./oncall-status";
import { CallStatePill, TierPill } from "./oncall-ui";

const INBOX_PAGE = 100;
const RESOLUTION_MIN_CHARS = 30;

const TIER_FILTERS = [{ value: "", label: "Tier: All" }].concat(
  ESCALATION_TIERS.map((tier) => ({ value: tier, label: tierLabel(tier) })),
);
const OPEN_FILTERS = [
  { value: "open", label: "Show: Outstanding" },
  { value: "all", label: "Show: Including resolved" },
];
type AttentionFilter = "all" | "mandatory" | "open" | "over_hour" | "external";

function inboxRank(a: EscalationInboxItem, b: EscalationInboxItem): number {
  if (a.mandatory !== b.mandatory) return a.mandatory ? -1 : 1;
  const rank = (row: EscalationInboxItem) => ESCALATION_TIERS.indexOf(row.tier);
  if (rank(a) !== rank(b)) return rank(b) - rank(a);
  return b.minutesOpen - a.minutesOpen;
}

function matchesAttention(row: EscalationInboxItem, filter: AttentionFilter): boolean {
  if (filter === "all") return true;
  if (filter === "mandatory") return row.mandatory && row.state !== "resolved";
  if (filter === "open") return row.state === "open";
  if (filter === "over_hour") return row.state === "open" && row.minutesOpen >= 60;
  return row.tier === "tier_5_external" || row.escalatedToExternalActorId !== null;
}

export function EscalationInboxScreen(): JSX.Element {
  const client = useApiClient();
  const [tier, setTier] = useState("");
  const [scope, setScope] = useState("open");
  const [attention, setAttention] = useState<AttentionFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [rows, setRows] = useState<EscalationInboxItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<EscalationInboxItem | null>(null);
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      const res = await listEscalations(client, {
        limit: INBOX_PAGE,
        ...(cursor ? { cursor } : {}),
        ...(tier ? { tier: tier as EscalationTier } : {}),
        ...(scope === "all" ? { openOnly: false } : {}),
      });
      if (res.error) {
        setError(errorMessage(res.error, "The escalation inbox could not be loaded."));
        setLoading(false);
        setLoadingMore(false);
        return;
      }
      setRows((current) =>
        cursor ? current.concat(res.page?.data ?? []) : (res.page?.data ?? []),
      );
      setNextCursor(res.page?.next_cursor ?? null);
      setTruncated(res.page?.has_more ?? false);
      setLoading(false);
      setLoadingMore(false);
    },
    [client, scope, tier],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const visibleRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return [...rows]
      .filter((row) => {
        const matchesSearch =
          q.length === 0 ||
          row.id.toLowerCase().includes(q) ||
          row.triageCallId.toLowerCase().includes(q) ||
          row.providerEntityId.toLowerCase().includes(q) ||
          (row.patientId ?? "").toLowerCase().includes(q) ||
          tierLabel(row.tier).toLowerCase().includes(q) ||
          humanize(row.triggerKind).toLowerCase().includes(q) ||
          humanize(row.state).toLowerCase().includes(q);
        return matchesSearch && matchesAttention(row, attention);
      })
      .sort(inboxRank);
  }, [attention, rows, searchQuery]);

  const unacknowledged = rows.filter((row) => row.state === "open").length;
  const mandatoryOpen = rows.filter((row) => row.mandatory && row.state !== "resolved").length;
  const overAnHour = rows.filter((row) => row.state === "open" && row.minutesOpen >= 60).length;
  const external = rows.filter(
    (row) => row.tier === "tier_5_external" || row.escalatedToExternalActorId !== null,
  ).length;
  const hasActiveFilters =
    searchQuery.trim() !== "" || tier !== "" || scope !== "open" || attention !== "all";

  async function ack(row: EscalationInboxItem): Promise<void> {
    setBusy(true);
    setActionError(null);
    const res = await acknowledgeEscalation(client, row.id, row.version);
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, "That page could not be acknowledged."));
      return;
    }
    await load();
  }

  async function commitResolve(): Promise<void> {
    if (!resolving) return;
    setBusy(true);
    setActionError(null);
    const res = await resolveEscalation(client, resolving.id, resolving.version, { resolution });
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, "That page could not be resolved."));
      return;
    }
    setResolving(null);
    setResolution("");
    await load();
  }

  const clearFilters = (): void => {
    setTier("");
    setScope("open");
    setAttention("all");
    setSearchQuery("");
  };

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Escalation inbox"
            breadcrumb="On-call / Escalations"
            actions={
              <Link to="/triage" style={linkButtonStyle}>
                Triage queue
              </Link>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Acknowledge pages quickly, then resolve the ones that require a named response.
            </div>
          </PageHeader>
        }
        kpis={
          <KpiStrip>
            <KpiCard
              label="Loaded"
              value={loading ? "—" : rows.length}
              detail={truncated ? `At least ${rows.length}` : "Fetched page"}
              tone={rows.length > 0 ? "info" : "neutral"}
              accentColor={
                rows.length > 0 ? "var(--color-primary)" : "var(--color-outline-variant)"
              }
              selected={attention === "all"}
              onSelect={() => setAttention("all")}
            />
            <KpiCard
              label="Unacknowledged"
              value={loading ? "—" : unacknowledged}
              detail="Needs response"
              tone={unacknowledged > 0 ? "danger" : "neutral"}
              accentColor={
                unacknowledged > 0 ? "var(--color-error)" : "var(--color-outline-variant)"
              }
              selected={attention === "open"}
              onSelect={() => setAttention("open")}
            />
            <KpiCard
              label="Mandatory"
              value={loading ? "—" : mandatoryOpen}
              detail="Platform floor"
              tone={mandatoryOpen > 0 ? "danger" : "neutral"}
              accentColor={
                mandatoryOpen > 0 ? "var(--color-error)" : "var(--color-outline-variant)"
              }
              selected={attention === "mandatory"}
              onSelect={() => setAttention("mandatory")}
            />
            <KpiCard
              label="Over 1h"
              value={loading ? "—" : overAnHour}
              detail="Still open"
              tone={overAnHour > 0 ? "warning" : "neutral"}
              accentColor={overAnHour > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
              selected={attention === "over_hour"}
              onSelect={() => setAttention("over_hour")}
            />
            <KpiCard
              label="External"
              value={loading ? "—" : external}
              detail="Vendor tier"
              tone={external > 0 ? "warning" : "neutral"}
              accentColor={external > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
              selected={attention === "external"}
              onSelect={() => setAttention("external")}
            />
          </KpiStrip>
        }
        filters={
          <div style={filterShellStyle}>
            {mandatoryOpen > 0 ? (
              <div role="alert" style={errorBannerStyle}>
                <Glyph name="alert" size={16} />
                <span>
                  {mandatoryOpen} mandatory escalation{mandatoryOpen === 1 ? "" : "s"} still need
                  explicit resolution.
                </span>
              </div>
            ) : null}
            {truncated ? (
              <output style={infoBannerStyle}>
                <Glyph name="info" size={16} />
                <span>More escalations match this filter. Counts are page-derived.</span>
              </output>
            ) : null}
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
            <div style={toolbarStyle}>
              <div style={searchBoxStyle}>
                <Glyph name="eye" size={14} />
                <input
                  type="search"
                  placeholder="Search page, call, patient, tier..."
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  aria-label="Search escalations"
                  style={searchInputStyle}
                />
              </div>
              <select
                value={tier}
                onChange={(event) => {
                  setTier(event.target.value);
                  setAttention("all");
                }}
                aria-label="Filter escalations by tier"
                style={selectStyle}
              >
                {TIER_FILTERS.map((option) => (
                  <option key={option.value || "all"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value)}
                aria-label="Filter escalations by scope"
                style={selectStyle}
              >
                {OPEN_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                value={attention}
                onChange={(event) => setAttention(event.target.value as AttentionFilter)}
                aria-label="Filter escalations by attention"
                style={selectStyle}
              >
                <option value="all">Attention: All</option>
                <option value="mandatory">Mandatory</option>
                <option value="open">Unacknowledged</option>
                <option value="over_hour">Over 1h</option>
                <option value="external">External</option>
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
          ) : visibleRows.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title={hasActiveFilters ? "No matching escalations" : "Nothing outstanding"}
                description={
                  hasActiveFilters
                    ? "Adjust the search or clear filters to return to the loaded inbox."
                    : "Your tier band has no open pages right now."
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
                    <th style={{ ...thStyle, width: "18%" }}>Tier</th>
                    <th style={{ ...thStyle, width: "15%" }}>Trigger</th>
                    <th style={{ ...thStyle, width: "14%" }}>State</th>
                    <th style={{ ...thStyle, width: "13%" }}>Call</th>
                    <th style={{ ...thStyle, width: "14%" }}>Patient</th>
                    <th style={{ ...thStyle, width: "12%" }}>Open</th>
                    <th style={{ ...thStyle, width: "14%" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <tr key={row.id} style={rowStyle}>
                      <td style={tdStyle}>
                        <div style={pillStackStyle}>
                          <TierPill tier={row.tier} />
                          {row.mandatory ? (
                            <StatusPill label="Platform floor" tone="critical" />
                          ) : null}
                        </div>
                      </td>
                      <td style={tdStyle}>{humanize(row.triggerKind)}</td>
                      <td style={tdStyle}>
                        <div style={pillStackStyle}>
                          <StatusPill
                            label={humanize(row.state)}
                            tone={toneOf(ESCALATION_STATE_TONE, row.state)}
                          />
                          <CallStatePill state={row.callState} />
                        </div>
                      </td>
                      <td style={tdStyle}>
                        <Link to={`/triage/calls/${row.triageCallId}`} style={callLinkStyle}>
                          {shortId(row.triageCallId)}
                        </Link>
                        <div style={subtleTextStyle}>{dateTime(row.escalatedAt)}</div>
                      </td>
                      <td style={tdStyle}>
                        {row.patientId ? (
                          <code className="wx-data-md" style={codeStyle}>
                            {shortId(row.patientId)}
                          </code>
                        ) : (
                          <span style={subtleTextStyle}>Not identified</span>
                        )}
                      </td>
                      <td
                        style={{ ...tdStyle, fontVariantNumeric: "tabular-nums", fontWeight: 650 }}
                      >
                        {durationLabel(row.minutesOpen)}
                      </td>
                      <td style={tdStyle}>
                        <div style={actionStackStyle}>
                          {row.state === "open" ? (
                            <Button
                              size="sm"
                              tone="primary"
                              disabled={busy}
                              onClick={() => void ack(row)}
                            >
                              Acknowledge
                            </Button>
                          ) : null}
                          {row.state === "acknowledged" ? (
                            <Button
                              size="sm"
                              tone="secondary"
                              disabled={busy}
                              onClick={() => {
                                setResolving(row);
                                setResolution("");
                              }}
                            >
                              Resolve
                            </Button>
                          ) : null}
                          {row.state === "resolved" ? (
                            <span style={subtleTextStyle}>Closed</span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={footerStyle}>
                <span style={subtleTextStyle}>
                  Showing {visibleRows.length} of {rows.length} loaded escalations
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
      {resolving ? (
        <ResolveModal
          row={resolving}
          resolution={resolution}
          busy={busy}
          onChange={setResolution}
          onClose={() => setResolving(null)}
          onSubmit={() => void commitResolve()}
        />
      ) : null}
    </>
  );
}

function ResolveModal({
  row,
  resolution,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  row: EscalationInboxItem;
  resolution: string;
  busy: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}): JSX.Element {
  const canSubmit = !busy && resolution.trim().length >= RESOLUTION_MIN_CHARS;
  return (
    <Modal open onClose={onClose} ariaLabel="Resolve escalation" width="36rem">
      <div style={modalBodyStyle}>
        <div style={sectionHeaderStyle}>
          <h2 style={modalTitleStyle}>Resolve escalation</h2>
          <TierPill tier={row.tier} />
        </div>
        {row.mandatory ? (
          <div role="alert" style={warningBannerStyle}>
            <Glyph name="alert" size={16} />
            <span>This mandatory escalation needs an explicit resolution record.</span>
          </div>
        ) : null}
        <label style={fieldStyle}>
          <span style={labelStyle}>Resolution</span>
          <textarea
            value={resolution}
            rows={5}
            onChange={(event) => onChange(event.target.value)}
            style={textareaStyle}
          />
          <span style={hintStyle}>
            Minimum {RESOLUTION_MIN_CHARS} characters. This is the named response record.
          </span>
        </label>
        <div style={modalFooterStyle}>
          <Button type="button" tone="tertiary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" tone="primary" disabled={!canSubmit} onClick={onSubmit}>
            {busy ? "Recording..." : "Record resolution"}
          </Button>
        </div>
      </div>
    </Modal>
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
  minWidth: "min(100%, 19rem)",
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

const pillStackStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.35rem",
};

const actionStackStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.4rem",
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

const errorBannerStyle: CSSProperties = {
  ...bannerBaseStyle,
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
};

const warningBannerStyle: CSSProperties = {
  ...bannerBaseStyle,
  background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
  color: "var(--color-on-surface)",
};

const modalBodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "1.25rem",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
};

const modalTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface)",
  fontSize: "1rem",
  fontWeight: 650,
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

const textareaStyle: CSSProperties = {
  width: "100%",
  minHeight: "7rem",
  padding: "0.55rem 0.65rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
  fontFamily: "inherit",
  resize: "vertical",
};

const hintStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};

const modalFooterStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
};
