// apps/web/src/modules/20-field-safety — §5.1 "ACTIVE SOS CENTER" (`/safety/sos`, Track B / ADR-0030).
//
// Open SOS alerts, oldest-and-loudest first. An empty board is a successful answer; a failed read is
// UNKNOWN. Acknowledgment remains a ceremony with action-taken text, not a one-click write.
import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type ActiveSosView,
  type SafetySosAcknowledgeOutcome,
  acknowledgeSos,
  errorMessage,
  getSosAlert,
  listActiveSos,
} from "./safety-api";
import {
  ACKNOWLEDGMENT_OUTCOMES,
  ACK_ACTION_TAKEN_MIN_CHARS,
  DEFAULT_ACK_OUTCOME,
  dateTime,
  durationLabel,
  humanize,
  meetsMinChars,
  minutesSince,
  shortId,
} from "./safety-status";
import {
  Modal,
  Notice,
  SelectField,
  SosStatePill,
  TextAreaField,
  TextField,
  disabledButtonStyle,
  primaryButtonStyle,
} from "./safety-ui";

const POLL_MS = 15_000;
const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

type Board = "ready" | "unknown";
type AckFilter = "all" | "unacknowledged" | "acknowledged";

export function ActiveSosScreen(): JSX.Element {
  const client = useApiClient();
  const [active, setActive] = useState<ActiveSosView | null>(null);
  const [board, setBoard] = useState<Board>("unknown");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [ackFilter, setAckFilter] = useState<AckFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [ackFor, setAckFor] = useState<{ id: string; who: string; version: number } | null>(null);
  const [ackOpening, setAckOpening] = useState<string | null>(null);
  const [actionTaken, setActionTaken] = useState("");
  const [outcome, setOutcome] = useState(DEFAULT_ACK_OUTCOME);
  const [phoneMasked, setPhoneMasked] = useState("");
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const load = useCallback(
    async (background = false) => {
      if (!background) setLoading(true);
      const res = await listActiveSos(client, { background });
      if (res.error || !res.active) {
        setBoard("unknown");
        setError(errorMessage(res.error, "The active-SOS board could not be read."));
      } else {
        setActive(res.active);
        setBoard("ready");
        setError(null);
      }
      setLoading(false);
    },
    [client],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const openAck = useCallback(
    async (id: string, who: string) => {
      setAckOpening(id);
      setModalError(null);
      const res = await getSosAlert(client, id);
      setAckOpening(null);
      if (res.error || !res.alert) {
        setError(errorMessage(res.error, "That alert could not be opened."));
        return;
      }
      setActionTaken("");
      setOutcome(DEFAULT_ACK_OUTCOME);
      setPhoneMasked("");
      setAckFor({ id, who, version: res.alert.version });
    },
    [client],
  );

  const submitAck = useCallback(async () => {
    if (!ackFor) return;
    setSaving(true);
    setModalError(null);
    const res = await acknowledgeSos(client, ackFor.id, ackFor.version, {
      actionTaken,
      outcome: outcome as SafetySosAcknowledgeOutcome,
      ...(phoneMasked.trim() ? { outreachPhoneNumberMasked: phoneMasked.trim() } : {}),
    });
    setSaving(false);
    if (res.error) {
      setModalError(errorMessage(res.error, "The acknowledgment was not recorded."));
      return;
    }
    setAckFor(null);
    await load(true);
  }, [ackFor, actionTaken, client, load, outcome, phoneMasked]);

  const orderedAlerts = useMemo(
    () =>
      [...(active?.alerts ?? [])].sort(
        (a, b) =>
          Number(a.acknowledgedAt !== null) - Number(b.acknowledgedAt !== null) ||
          b.minutesOpen - a.minutesOpen,
      ),
    [active],
  );
  const stateOptions = useMemo(
    () => [...new Set(orderedAlerts.map((alert) => alert.lifecycleState))].sort(),
    [orderedAlerts],
  );
  const filteredAlerts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return orderedAlerts.filter((alert) => {
      const matchesState = !stateFilter || alert.lifecycleState === stateFilter;
      const matchesAck =
        ackFilter === "all" ||
        (ackFilter === "unacknowledged" && alert.acknowledgedAt === null) ||
        (ackFilter === "acknowledged" && alert.acknowledgedAt !== null);
      const matchesSearch =
        !q ||
        alert.id.toLowerCase().includes(q) ||
        alert.postedByFirstName.toLowerCase().includes(q) ||
        alert.lifecycleState.toLowerCase().includes(q);
      return matchesState && matchesAck && matchesSearch;
    });
  }, [ackFilter, orderedAlerts, searchQuery, stateFilter]);

  const activePage = Math.min(page, Math.max(1, Math.ceil(filteredAlerts.length / pageSize)));
  const pagedAlerts = filteredAlerts.slice((activePage - 1) * pageSize, activePage * pageSize);
  const activeFilters = [searchQuery.trim() !== "", stateFilter !== "", ackFilter !== "all"].filter(
    Boolean,
  ).length;

  const clearFilters = (): void => {
    setSearchQuery("");
    setStateFilter("");
    setAckFilter("all");
    setPage(1);
  };

  if (loading && active === null) {
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  }

  if (active === null) {
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState
          title="Active-SOS board unavailable"
          description={
            error ??
            "The board did not answer. This is not no active alerts; treat it as unknown and check by phone."
          }
        />
      </div>
    );
  }

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Active SOS"
            breadcrumb="Field safety"
            actions={
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                <Link to="/safety" style={linkButtonStyle}>
                  Safety board
                </Link>
                <Button
                  type="button"
                  tone="secondary"
                  onClick={() => void load()}
                  loading={loading}
                >
                  Refresh
                </Button>
              </div>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Server answer at {dateTime(active.fetchedAt)}. Polls every {POLL_MS / 1000} seconds.
            </div>
          </PageHeader>
        }
        filters={
          <div style={filterShellStyle}>
            {board === "unknown" ? (
              <Notice tone="warning" assertive>
                <strong>This board did not refresh.</strong> {error} What follows is the last answer
                received at {dateTime(active.fetchedAt)}.
              </Notice>
            ) : null}
            {orderedAlerts.length === 0 ? (
              <Notice tone="success" live>
                <strong>No SOS is open</strong> as of {dateTime(active.fetchedAt)}. The read
                succeeded and returned nothing.
              </Notice>
            ) : (
              <Notice tone="error" assertive>
                <strong>
                  {orderedAlerts.length} SOS{" "}
                  {orderedAlerts.length === 1 ? "alert is" : "alerts are"} open
                </strong>
                . Acknowledging records who answered; resolving still happens on the alert detail.
              </Notice>
            )}
            <div style={toolbarStyle}>
              <div style={toolbarTitleStyle}>
                <span style={toolbarEyebrowStyle}>Open alerts</span>
                <strong>{filteredAlerts.length} matching SOS alerts</strong>
              </div>
              <div style={controlGroupStyle}>
                <label className="wx-search-field">
                  <Glyph name="search" size={16} />
                  <input
                    type="search"
                    placeholder="Search clinician or alert..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setPage(1);
                    }}
                    aria-label="Search active SOS alerts"
                  />
                </label>
                <label className="wx-filter-field">
                  <span>State</span>
                  <select
                    className="wx-select"
                    aria-label="SOS state"
                    value={stateFilter}
                    onChange={(e) => {
                      setStateFilter(e.target.value);
                      setPage(1);
                    }}
                    style={selectStyle}
                  >
                    <option value="">All</option>
                    {stateOptions.map((state) => (
                      <option key={state} value={state}>
                        {humanize(state)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wx-filter-field">
                  <span>Ack</span>
                  <select
                    className="wx-select"
                    aria-label="Acknowledgment status"
                    value={ackFilter}
                    onChange={(e) => {
                      setAckFilter(e.target.value as AckFilter);
                      setPage(1);
                    }}
                    style={selectStyle}
                  >
                    <option value="all">All</option>
                    <option value="unacknowledged">Unacknowledged</option>
                    <option value="acknowledged">Acknowledged</option>
                  </select>
                </label>
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
          filteredAlerts.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title={activeFilters > 0 ? "No matching SOS alerts" : "No active SOS"}
                description={
                  activeFilters > 0
                    ? "Try adjusting the SOS filters."
                    : "The server answered successfully and no SOS alert is currently open."
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
                    <th style={{ ...thStyle, width: "20%" }}>Clinician</th>
                    <th style={{ ...thStyle, width: "18%" }}>Alert</th>
                    <th style={{ ...thStyle, width: "18%" }}>State</th>
                    <th style={{ ...thStyle, width: "16%" }}>Raised</th>
                    <th style={{ ...thStyle, width: "12%" }}>Open for</th>
                    <th style={{ ...thStyle, width: "10%" }}>Ack</th>
                    <th style={{ ...thStyle, width: "6%", textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedAlerts.map((alert) => (
                    <tr key={alert.id} style={rowStyle}>
                      <td style={tdStyle}>{alert.postedByFirstName}</td>
                      <td style={tdStyle}>
                        <Link to={`/safety/sos/${alert.id}`} style={linkStyle}>
                          {shortId(alert.id)}
                        </Link>
                      </td>
                      <td style={tdStyle}>
                        <SosStatePill state={alert.lifecycleState} />
                      </td>
                      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                        {dateTime(alert.postedAt)}
                      </td>
                      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                        {durationLabel(alert.minutesOpen ?? minutesSince(alert.postedAt))}
                      </td>
                      <td style={tdStyle}>
                        {alert.acknowledgedAt ? (
                          <span style={secondaryTextStyle}>{dateTime(alert.acknowledgedAt)}</span>
                        ) : (
                          <span style={{ color: "var(--color-error)", fontWeight: 600 }}>
                            Nobody yet
                          </span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <Button
                          size="sm"
                          tone="secondary"
                          disabled={ackOpening === alert.id}
                          onClick={() => void openAck(alert.id, alert.postedByFirstName)}
                        >
                          {ackOpening === alert.id ? "Opening..." : "Acknowledge"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <OffsetPagination
                page={activePage}
                pageSize={pageSize}
                totalItems={filteredAlerts.length}
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPageSize(nextPageSize);
                  setPage(1);
                }}
                pageSizeOptions={PAGE_SIZES}
                noun="alerts"
              />
            </div>
          )
        }
        fullPageScroll
      />

      {ackFor ? (
        <Modal
          title={`Acknowledge ${ackFor.who}'s SOS`}
          onClose={() => setAckFor(null)}
          footer={
            <button
              type="button"
              onClick={() => void submitAck()}
              disabled={saving || !meetsMinChars(actionTaken, ACK_ACTION_TAKEN_MIN_CHARS)}
              style={
                saving || !meetsMinChars(actionTaken, ACK_ACTION_TAKEN_MIN_CHARS)
                  ? disabledButtonStyle
                  : primaryButtonStyle
              }
            >
              {saving ? "Recording..." : "Record acknowledgment"}
            </button>
          }
        >
          <Notice tone="warning">
            This records that <strong>you</strong> answered, at this moment, and what you did. It
            does not close the alert.
          </Notice>
          <TextAreaField
            label="What did you do?"
            value={actionTaken}
            onChange={setActionTaken}
            rows={4}
            minChars={ACK_ACTION_TAKEN_MIN_CHARS}
            hint="Who you reached, on what number, and what you asked them to do."
          />
          <SelectField
            label="Outcome of your action"
            value={outcome}
            options={ACKNOWLEDGMENT_OUTCOMES.map((v) => ({ value: v, label: humanize(v) }))}
            onChange={setOutcome}
          />
          <TextField
            label="Number you called (masked)"
            value={phoneMasked}
            onChange={setPhoneMasked}
            placeholder="***-***-4417"
            hint="Masked on purpose. Leave blank if you did not call."
          />
          {modalError ? (
            <Notice tone="error" assertive>
              {modalError}
            </Notice>
          ) : null}
          <span style={secondaryTextStyle}>
            This acknowledgment is stamped against version {ackFor.version} of the alert, read when
            this dialog opened.
          </span>
        </Modal>
      ) : null}
    </>
  );
}

const linkButtonStyle = {
  minHeight: "2.25rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  fontWeight: 600,
  textDecoration: "none",
};
const linkStyle = {
  color: "var(--color-primary)",
  textDecoration: "none",
  fontFamily: "var(--font-mono)",
};
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
};
const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};
const searchInputStyle = { minWidth: "16rem", height: "2.25rem", fontSize: "0.85rem" };
const selectStyle = { height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" };
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
};
const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};
const secondaryTextStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
