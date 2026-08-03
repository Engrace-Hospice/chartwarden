// apps/web/src/modules/20-field-safety — §5.1 "MY CHECK-INS" (`/me/safety/check-ins`,
// Track B / ADR-0030).
//
// The clinician's own history and the five-minute amendment grace §5.1 names.
//
// ── THE 90-DAY WINDOW IS ASKED FOR, NOT ASSUMED ─────────────────────────────────────────────────────
//
// `GET /safety/check-ins/me/today` defaults to ±24 hours and takes `from`/`to`. §5.1 wants 90 days, so
// this screen sends `from` explicitly. The route name says "today" and the answer is not — the copy says
// which window it actually asked for, because a history page that quietly returned one day would read as
// "I have posted three check-ins in three months".
//
// ── THE GRACE IS THE SERVER'S ANSWER, NEVER A CLIENT CLOCK ──────────────────────────────────────────
//
// `amendableUntil` is `null` on this LIST projection by construction (`read-service-drizzle.ts` says so
// in as many words: "the list is a history view; the grace is answered by the detail route"). So the
// Amend button re-reads the row by id and offers the form only if the SERVER says the window is open. The
// alternative — subtracting five minutes from `postedAt` in the browser — would offer a form that 422s on
// a device whose clock has drifted, at the moment somebody is trying to correct a safety record.
//
// ── AN AMENDMENT IS A NEW ROW ───────────────────────────────────────────────────────────────────────
//
// §2.2.1 makes a correction a fresh check-in that SUPERSEDES the original, and the original stays
// readable because it is what the supervisor may already have acted on. The list shows both, marked, for
// exactly that reason.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
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
  Card,
  CheckInStatusPill,
  CountGrid,
  Modal,
  Notice,
  SelectField,
  TextAreaField,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./safety-ui";

/** §5.1's window, sent explicitly — see the module header on why it is not left to the route's default. */
const HISTORY_DAYS = 90;

export function MyCheckInsScreen(): JSX.Element {
  const client = useApiClient();
  const [day, setDay] = useState<SafetyMyDayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  /** Re-read by id, because only the DETAIL route answers `amendableUntil` (module header, rule 2). */
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
        // Not a modal, and not a silent no-op: the button was offered and the server said no. Say which.
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
      // `status` is always one of the closed vocabulary the SelectField below offers.
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

  if (loading) return <LoadingSpinner />;
  if (!day)
    return (
      <EmptyState
        title="Check-in history unavailable"
        description={
          error ?? "The read did not answer. This is not an empty history — it is an unanswered question."
        }
      />
    );

  const rows = [...day.recentCheckIns].sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  const concerns = rows.filter((r) => r.status !== "ok").length;
  const superseded = rows.filter((r) => r.supersededAt !== null).length;
  const noteOwed = status !== "ok";
  const canSave =
    meetsMinChars(reason, AMENDMENT_REASON_MIN_CHARS) &&
    (!noteOwed || meetsMinChars(note, CONCERN_NOTE_MIN_CHARS));

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>My check-ins</span>}
        breadcrumb="Field safety"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/me/safety" style={ghostButtonStyle}>
              My safety
            </Link>
            <button type="button" onClick={() => void load()} style={ghostButtonStyle}>
              Refresh
            </button>
          </div>
        }
      />

      <Card title={`The last ${HISTORY_DAYS} days`}>
        <CountGrid
          entries={[
            { label: "Check-ins posted", value: rows.length },
            { label: "Not plain OK", value: concerns, tone: concerns > 0 ? "warning" : undefined },
            { label: "Later corrected", value: superseded },
            { label: "Obligations shown", value: day.obligations.length },
          ]}
        />
        <span style={mutedStyle}>
          Read at {dateTime(day.asOf)}, over a window this page asked for explicitly. Everything here is
          yours — the route is scoped to your own membership on the server and cannot be pointed at a
          colleague.
        </span>
      </Card>

      {error ? (
        <Notice tone="warning" live>
          {error}
        </Notice>
      ) : null}

      <Card title="What you posted">
        {rows.length === 0 ? (
          <span style={mutedStyle}>
            No check-ins in this window. If you expected some, that is worth raising — the window is{" "}
            {HISTORY_DAYS} days and the read succeeded.
          </span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Posted</th>
                <th style={th}>Kind</th>
                <th style={th}>You said</th>
                <th style={th}>Your note</th>
                <th style={th}>Visit</th>
                <th style={th}>Standing</th>
                <th style={th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={rowLine}>
                  <td style={td}>{dateTime(r.postedAt)}</td>
                  <td style={td}>{humanize(r.kind)}</td>
                  <td style={td}>
                    <CheckInStatusPill status={r.status} />
                  </td>
                  <td style={td}>
                    {r.concernNote ?? <span style={mutedStyle}>—</span>}
                  </td>
                  <td style={td}>
                    {r.visitId ? (
                      <span style={{ fontFamily: t.fontMono }}>{shortId(r.visitId)}</span>
                    ) : (
                      <span style={mutedStyle}>—</span>
                    )}
                  </td>
                  <td style={td}>
                    {r.supersededAt ? (
                      <>
                        <StatusPill label="Corrected later" tone="neutral" />
                        <div style={mutedStyle}>
                          by {shortId(r.supersededByCheckInId)} at {dateTime(r.supersededAt)}
                        </div>
                      </>
                    ) : r.correctsCheckInId ? (
                      <>
                        <StatusPill label="This is a correction" tone="progress" />
                        <div style={mutedStyle}>of {shortId(r.correctsCheckInId)}</div>
                      </>
                    ) : (
                      <span style={mutedStyle}>Original</span>
                    )}
                    {r.isPartOfSosBracket ? (
                      <div>
                        <StatusPill label="Around an SOS" tone="critical" />
                      </div>
                    ) : null}
                  </td>
                  <td style={td}>
                    {r.supersededAt ? (
                      <span style={mutedStyle}>Superseded</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => void openAmend(r)}
                          disabled={checking === r.id}
                          style={checking === r.id ? disabledButtonStyle : ghostButtonStyle}
                        >
                          {checking === r.id ? "Checking…" : "Amend"}
                        </button>
                        {graceClosed === r.id ? (
                          <div style={{ ...mutedStyle, color: t.error }}>
                            The five-minute grace on this one has closed. It stands as posted — which is
                            the point: a supervisor may already have acted on it.
                          </div>
                        ) : null}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span style={mutedStyle}>
          A correction never erases what you first said. It creates a new row that supersedes the old one,
          and both stay readable — because if you posted "I'm OK" and corrected it ten seconds later,
          somebody may already have read the first.
        </span>
      </Card>

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
              {saving ? "Recording…" : "Record correction"}
            </button>
          }
        >
          <Notice tone="info">
            Amendable until <strong>{dateTime(amending.amendableUntil)}</strong> — the server's answer,
            read just now. This writes a new check-in that supersedes the one from{" "}
            {dateTime(amending.postedAt)}; the original stays on the record.
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
            hint="A short reason. It is what tells a later reader that the change was a correction rather than a change of mind under pressure."
          />
          {modalError ? (
            <Notice tone="error" assertive>
              {modalError}
            </Notice>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
