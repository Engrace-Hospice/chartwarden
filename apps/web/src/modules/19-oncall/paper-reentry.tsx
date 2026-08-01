// apps/web/src/modules/19-oncall — THE BCP PAPER RE-ENTRY WORKLIST (`/triage/paper-reentry`, §2.7,
// Track B / ADR-0030).
//
// A SCREEN §5.1 DOES NOT LIST, for the reason its route exists at all: §4.6 adds `triage.paper_reentry`
// with a step-up, and nav gating is per-screen. A permission nobody can exercise is one that gets granted
// and forgotten — and this one is the single write in M19 that can back-date a call past a coverage gap,
// which is exactly what §8.3.2 lists as the way a gap gets hidden. It gets its own screen, its own nav
// entry and its own copy about what it does.
//
// THE BACK-DATED INSTANT IS BOUNDED BY THE WORKLIST ROW, NOT BY THIS FORM. Each row names the outage
// window it was filed against, and the server range-checks `paperOriginalOpenedAt` against it. The form
// pre-fills the window's start and says what the bound is, so a DON entering last night's paper log is
// never guessing — and cannot quietly move a call outside the outage it belongs to.
//
// A WORKLIST ROW EXPIRES. §2.7 gives the row a TTL; after it lapses the re-entry path closes and the
// outage becomes a documented gap rather than a set of calls that appear days later. The screen sorts by
// expiry and marks what is close, because "we ran out of time to type it in" is a finding, not a filing.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type PaperReentryWorklistView,
  errorMessage,
  listPaperReentryWorklist,
  reenterPaperCall,
} from "./oncall-api";
import {
  DEFAULT_CALLER_KIND,
  DEFAULT_INBOUND_CHANNEL,
  HUMAN_CALLER_KINDS,
  HUMAN_INBOUND_CHANNELS,
  dateTime,
  durationLabel,
  shortId,
  toInstant,
} from "./oncall-status";
import {
  Card,
  CountGrid,
  Modal,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  alertStyle,
  columnStyle,
  disabledButtonStyle,
  enumOptions,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
} from "./oncall-ui";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minutes until an instant (negative once it has passed). */
function minutesUntil(value: string, now = Date.now()): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : Math.floor((ms - now) / 60_000);
}

/** A `datetime-local` value from an ISO instant, for pre-filling the window start. */
function localFromInstant(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PaperReentryWorklistScreen(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<PaperReentryWorklistView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState<PaperReentryWorklistView | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // re-entry fields
  const [openedAt, setOpenedAt] = useState("");
  const [inboundChannel, setInboundChannel] = useState(DEFAULT_INBOUND_CHANNEL);
  const [callerKind, setCallerKind] = useState(DEFAULT_CALLER_KIND);
  const [callerDisplayName, setCallerDisplayName] = useState("");
  const [patientId, setPatientId] = useState("");
  const [admissionId, setAdmissionId] = useState("");
  const [chiefComplaint, setChiefComplaint] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listPaperReentryWorklist(client);
    if (res.error) {
      setError(errorMessage(res.error, "The re-entry worklist could not be loaded."));
      setLoading(false);
      return;
    }
    setRows(res.rows ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const outstanding = rows.filter((r) => r.reenteredAt === null);
  const expiringSoon = outstanding.filter((r) => minutesUntil(r.expiresAt) < 12 * 60).length;
  const lapsed = outstanding.filter((r) => minutesUntil(r.expiresAt) <= 0).length;
  const sorted = [...rows].sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));

  const anchorValid =
    (patientId === "" && admissionId === "") ||
    (UUID_RE.test(patientId) && UUID_RE.test(admissionId));
  const canEnter = entering !== null && openedAt !== "" && anchorValid && !busy;

  async function commit(): Promise<void> {
    if (!entering) return;
    setBusy(true);
    setActionError(null);
    const res = await reenterPaperCall(client, {
      worklistId: entering.id,
      providerEntityId: entering.providerEntityId,
      paperOriginalOpenedAt: toInstant(openedAt),
      inboundChannel,
      callerKind,
      ...(callerDisplayName ? { callerDisplayName } : {}),
      ...(patientId ? { patientId, admissionId } : {}),
      ...(chiefComplaint ? { chiefComplaintText: chiefComplaint } : {}),
    });
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, "The paper call could not be re-entered."));
      return;
    }
    setEntering(null);
    setChiefComplaint("");
    setCallerDisplayName("");
    setPatientId("");
    setAdmissionId("");
    await load();
  }

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Paper re-entry</span>}
        breadcrumb="On-call triage · business continuity"
        actions={
          <Link to="/triage" style={ghostButtonStyle}>
            Triage queue
          </Link>
        }
      />

      <Notice tone="warning">
        <strong>This is the one write that back-dates a call.</strong> It exists so that calls taken on
        paper during an outage enter the record with the time they actually happened — and it is gated by
        its own permission and a step-up, because the same capability is how a coverage gap would be hidden.
        Each entry is bounded by the outage window it is filed against; the server refuses an instant
        outside it.
      </Notice>

      <Card title="Worklist">
        <CountGrid
          entries={[
            { label: "Rows", value: rows.length },
            { label: "Outstanding", value: outstanding.length },
            {
              label: "Expiring within 12h",
              value: expiringSoon,
              tone: expiringSoon > 0 ? "error" : undefined,
            },
            { label: "Lapsed", value: lapsed, tone: lapsed > 0 ? "error" : undefined },
          ]}
        />
        {lapsed > 0 ? (
          <Notice tone="error" live>
            {lapsed} window{lapsed === 1 ? " has" : "s have"} lapsed. The re-entry path is closed for
            those: what was on paper stays on paper, and the outage is a documented gap rather than a set
            of calls that appear days later with a time nobody can corroborate.
          </Notice>
        ) : null}
      </Card>

      <Card title="Outage windows">
        {sorted.length === 0 ? (
          <span style={mutedStyle}>
            Nothing is outstanding. A worklist row is created when an outage window closes — an empty list
            means no outage has left calls on paper.
          </span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Window</th>
                <th style={th}>Provider entity</th>
                <th style={th}>Shift</th>
                <th style={th}>Assigned to</th>
                <th style={thNum}>Expires in</th>
                <th style={th}>Re-entered</th>
                <th style={th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const remaining = minutesUntil(r.expiresAt);
                const done = r.reenteredAt !== null;
                return (
                  <tr key={r.id} style={rowLine}>
                    <td style={td}>
                      {dateTime(r.shiftStartsAt)} → {dateTime(r.shiftEndsAt)}
                    </td>
                    <td style={{ ...td, fontFamily: t.fontMono }}>{shortId(r.providerEntityId)}</td>
                    <td style={{ ...td, fontFamily: t.fontMono }}>{shortId(r.shiftId)}</td>
                    <td style={{ ...td, fontFamily: t.fontMono }}>{shortId(r.assignedToMembershipId)}</td>
                    <td style={tdNum}>
                      {remaining > 0 ? (
                        durationLabel(remaining)
                      ) : (
                        <StatusPill label="Lapsed" tone="error" />
                      )}
                    </td>
                    <td style={td}>
                      {done ? (
                        r.linkedTriageCallId ? (
                          <Link to={`/triage/calls/${r.linkedTriageCallId}`} style={linkStyle}>
                            {dateTime(r.reenteredAt)}
                          </Link>
                        ) : (
                          dateTime(r.reenteredAt)
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={td}>
                      {done ? (
                        <span style={mutedStyle}>filed</span>
                      ) : remaining <= 0 ? (
                        <span style={mutedStyle}>window closed</span>
                      ) : (
                        <button
                          type="button"
                          style={busy ? disabledButtonStyle : primaryButtonStyle}
                          disabled={busy}
                          onClick={() => {
                            setEntering(r);
                            setOpenedAt(localFromInstant(r.shiftStartsAt));
                          }}
                        >
                          Re-enter a call
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      {entering ? (
        <Modal
          title="Re-enter a call taken on paper"
          onClose={() => setEntering(null)}
          footer={
            <button
              type="button"
              disabled={!canEnter}
              style={canEnter ? primaryButtonStyle : disabledButtonStyle}
              onClick={() => void commit()}
            >
              File the call
            </button>
          }
        >
          <Notice tone="warning">
            The original time must fall inside {dateTime(entering.shiftStartsAt)} →{" "}
            {dateTime(entering.shiftEndsAt)}. The server enforces that bound; the field below is pre-filled
            with the window's start so nothing is guessed.
          </Notice>
          <TextField
            label="When the call actually came in"
            value={openedAt}
            onChange={setOpenedAt}
            type="datetime-local"
          />
          <SelectField
            label="Inbound channel"
            value={inboundChannel}
            options={enumOptions(HUMAN_INBOUND_CHANNELS)}
            onChange={setInboundChannel}
          />
          <SelectField
            label="Caller kind"
            value={callerKind}
            options={enumOptions(HUMAN_CALLER_KINDS)}
            onChange={setCallerKind}
          />
          <TextField label="Caller name" value={callerDisplayName} onChange={setCallerDisplayName} />
          <TextField label="Patient id (optional)" value={patientId} onChange={setPatientId} mono />
          <TextField label="Admission id (optional)" value={admissionId} onChange={setAdmissionId} mono />
          {!anchorValid ? (
            <p style={alertStyle}>Patient and admission travel together or not at all.</p>
          ) : null}
          <TextAreaField
            label="Chief complaint as recorded on paper"
            value={chiefComplaint}
            onChange={setChiefComplaint}
            rows={3}
          />
          <span style={mutedStyle}>
            The call is filed with a paper origin flag and both times: the original instant and the moment
            it was typed in. A reviewer sees both, which is the point — the record does not pretend the call
            was entered live.
          </span>
        </Modal>
      ) : null}
    </div>
  );
}
