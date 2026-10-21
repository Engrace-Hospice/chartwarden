// apps/web/src/modules/20-field-safety - §5.1 "MY CHECK-INS" (`/me/safety/check-ins`,
// Track B / ADR-0030).
//
// The clinician's own check-in history and the five-minute amendment grace.
import {
  Button,
  EmptyState,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type SafetyCheckInStatus,
  type SafetyCheckInView,
  type SafetyMyDayView,
  amendCheckIn,
  errorMessage,
  getCheckIn,
  getMyDay,
} from "./safety-api";
import {
  AMENDMENT_REASON_MIN_CHARS,
  CONCERN_NOTE_MIN_CHARS,
  checkInStatusLabel,
  dateTime,
  daysAgoInstant,
  humanize,
  meetsMinChars,
  shortId,
} from "./safety-status";
import {
  CheckInStatusPill,
  Modal,
  Notice,
  SelectField,
  TextAreaField,
  disabledButtonStyle,
  primaryButtonStyle,
} from "./safety-ui";

const HISTORY_DAYS = 90;
const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function MyCheckInsScreen(): JSX.Element {
  const client = useApiClient();
  const [day, setDay] = useState<SafetyMyDayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [amending, setAmending] = useState<SafetyCheckInView | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [graceClosed, setGraceClosed] = useState<string | null>(null);
  const [status, setStatus] = useState("ok");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getMyDay(client, { limit: 100, from: daysAgoInstant(HISTORY_DAYS) });
    if (res.error || !res.day) {
      setError(errorMessage(res.error, "Your check-in history could not be read."));
      setDay(null);
    } else {
      setDay(res.day);
      setError(null);
    }
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const openAmend = useCallback(
    async (row: SafetyCheckInView) => {
      setChecking(row.id);
      setGraceClosed(null);
      setModalError(null);
      const res = await getCheckIn(client, row.id);
      setChecking(null);
      if (res.error || !res.checkIn) {
        setError(errorMessage(res.error, "That check-in could not be re-read."));
        return;
      }
      if (res.checkIn.amendableUntil === null) {
        setGraceClosed(row.id);
        return;
      }
      setStatus(res.checkIn.status);
      setNote(res.checkIn.concernNote ?? "");
      setReason("");
      setAmending(res.checkIn);
    },
    [client],
  );

  const submitAmend = useCallback(async () => {
    if (!amending) return;
    setSaving(true);
    setModalError(null);
    const res = await amendCheckIn(client, amending.id, {
      status: status as SafetyCheckInStatus,
      ...(status !== "ok" ? { concernNote: note } : {}),
      amendmentReason: reason,
    });
    setSaving(false);
    if (res.error) {
      setModalError(errorMessage(res.error, "The amendment was not recorded."));
      return;
    }
    setAmending(null);
    await load();
  }, [amending, client, load, note, reason, status]);

  const rows = useMemo(
    () => [...(day?.recentCheckIns ?? [])].sort((a, b) => b.postedAt.localeCompare(a.postedAt)),
    [day],
  );
  const activePage = Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize)));
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const noteOwed = status !== "ok";
  const canSave =
    meetsMinChars(reason, AMENDMENT_REASON_MIN_CHARS) &&
    (!noteOwed || meetsMinChars(note, CONCERN_NOTE_MIN_CHARS));

  if (loading && !day) {
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  }

  if (!day) {
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState
          title="Check-in history unavailable"
          description={
            error ??
            "The read did not answer. This is not an empty history; it is an unanswered question."
          }
        />
      </div>
    );
  }

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="My Check-ins"
          breadcrumb="Field safety"
          actions={
            <div style={actionGroupStyle}>
              <Link to="/me/safety" style={linkButtonStyle}>
                My safety
              </Link>
              <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
                Refresh
              </Button>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Last {HISTORY_DAYS} days requested explicitly. Read at {dateTime(day.asOf)}.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <Notice tone="warning" live>
              {error}
            </Notice>
          ) : null}
          <div role="note" style={noteStyle}>
            <StatusPill label="Own history" tone="neutral" />
            <span>
              Amendments re-read the row by id because only the detail route answers whether the
              grace window is still open.
            </span>
          </div>
        </div>
      }
      table={
        <div style={tableWrapStyle}>
          {rows.length === 0 ? (
            <div style={{ padding: "2rem 0" }}>
              <EmptyState
                title="No check-ins in this window"
                description={`The ${HISTORY_DAYS}-day read succeeded and returned no check-ins.`}
              />
            </div>
          ) : (
            <>
              <table style={tableStyle}>
                <thead>
                  <tr style={headerRowStyle}>
                    <th style={{ ...thStyle, width: "17%" }}>Posted</th>
                    <th style={{ ...thStyle, width: "13%" }}>Kind</th>
                    <th style={{ ...thStyle, width: "14%" }}>You said</th>
                    <th style={{ ...thStyle, width: "22%" }}>Your note</th>
                    <th style={{ ...thStyle, width: "12%" }}>Visit</th>
                    <th style={{ ...thStyle, width: "14%" }}>Standing</th>
                    <th style={{ ...thStyle, width: "8%", textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((row) => (
                    <CheckInRow
                      key={row.id}
                      row={row}
                      checking={checking === row.id}
                      graceClosed={graceClosed === row.id}
                      onAmend={openAmend}
                    />
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
                pageSizeOptions={PAGE_SIZES}
                noun="check-ins"
              />
            </>
          )}
          <div role="note" style={noteStyle}>
            <StatusPill label="Append-only" tone="neutral" />
            <span>
              A correction creates a new row and supersedes the original. It never erases what was
              first posted.
            </span>
          </div>
          {amending ? (
            <Modal
              title="Amend this check-in"
              onClose={() => setAmending(null)}
              footer={
                <button
                  type="button"
                  onClick={() => void submitAmend()}
                  disabled={saving || !canSave}
                  style={saving || !canSave ? disabledButtonStyle : primaryButtonStyle}
                >
                  {saving ? "Recording..." : "Record correction"}
                </button>
              }
            >
              <Notice tone="info">
                Amendable until <strong>{dateTime(amending.amendableUntil)}</strong>. This writes a
                new check-in that supersedes the one from {dateTime(amending.postedAt)}.
              </Notice>
              <SelectField
                label="What you meant to say"
                value={status}
                options={[
                  { value: "ok", label: checkInStatusLabel("ok") },
                  { value: "concerned_continue", label: checkInStatusLabel("concerned_continue") },
                  { value: "concerned_stop", label: checkInStatusLabel("concerned_stop") },
                ]}
                onChange={setStatus}
              />
              {noteOwed ? (
                <TextAreaField
                  label="Your note"
                  value={note}
                  onChange={setNote}
                  rows={4}
                  minChars={CONCERN_NOTE_MIN_CHARS}
                />
              ) : null}
              <TextAreaField
                label="Why the correction?"
                value={reason}
                onChange={setReason}
                rows={3}
                minChars={AMENDMENT_REASON_MIN_CHARS}
                hint="A short reason for the audit trail."
              />
              {modalError ? (
                <Notice tone="error" assertive>
                  {modalError}
                </Notice>
              ) : null}
            </Modal>
          ) : null}
        </div>
      }
      fullPageScroll
    />
  );
}

function CheckInRow({
  row,
  checking,
  graceClosed,
  onAmend,
}: {
  row: SafetyCheckInView;
  checking: boolean;
  graceClosed: boolean;
  onAmend: (row: SafetyCheckInView) => Promise<void>;
}): JSX.Element {
  return (
    <tr style={rowStyle}>
      <td style={tdStyle}>{dateTime(row.postedAt)}</td>
      <td style={tdStyle}>{humanize(row.kind)}</td>
      <td style={tdStyle}>
        <CheckInStatusPill status={row.status} />
      </td>
      <td style={tdStyle}>{row.concernNote ?? <span style={secondaryTextStyle}>-</span>}</td>
      <td style={tdMonoStyle}>{row.visitId ? shortId(row.visitId) : "-"}</td>
      <td style={tdStyle}>
        <div style={primaryCellStyle}>
          {row.supersededAt ? (
            <>
              <StatusPill label="Corrected later" tone="neutral" />
              <span style={secondaryTextStyle}>
                by {row.supersededByCheckInId ? shortId(row.supersededByCheckInId) : "unknown"} at{" "}
                {dateTime(row.supersededAt)}
              </span>
            </>
          ) : row.correctsCheckInId ? (
            <>
              <StatusPill label="Correction" tone="progress" />
              <span style={secondaryTextStyle}>of {shortId(row.correctsCheckInId)}</span>
            </>
          ) : (
            <span style={secondaryTextStyle}>Original</span>
          )}
          {row.isPartOfSosBracket ? <StatusPill label="Around SOS" tone="critical" /> : null}
        </div>
      </td>
      <td style={{ ...tdStyle, textAlign: "right" }}>
        {row.supersededAt ? (
          <span style={secondaryTextStyle}>Superseded</span>
        ) : (
          <div style={actionCellStyle}>
            <Button size="sm" tone="tertiary" disabled={checking} onClick={() => void onAmend(row)}>
              {checking ? "Checking..." : "Amend"}
            </Button>
            {graceClosed ? (
              <span style={{ ...secondaryTextStyle, color: "var(--color-error)" }}>
                Grace closed
              </span>
            ) : null}
          </div>
        )}
      </td>
    </tr>
  );
}

const actionGroupStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "0.5rem",
};
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
const filterShellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const tableWrapStyle = {
  width: "100%",
  overflowX: "auto" as const,
  padding: "0 1.5rem 1.5rem",
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
const tdMonoStyle = {
  ...tdStyle,
  fontFamily: "var(--font-mono)",
};
const primaryCellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "flex-start",
  gap: "0.25rem",
  minWidth: 0,
};
const secondaryTextStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const actionCellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "flex-end",
  gap: "0.375rem",
};
const noteStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  marginTop: "1rem",
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
};
