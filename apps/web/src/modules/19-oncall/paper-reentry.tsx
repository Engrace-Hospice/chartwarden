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
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  t,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import {
  type PaperReentryWorklistView,
  type TriageCallerKind,
  type TriageInboundChannel,
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
  Modal,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  alertStyle,
  disabledButtonStyle,
  enumOptions,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
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

  const lapsed = rows.filter(
    (r) => r.reenteredAt === null && minutesUntil(r.expiresAt) <= 0,
  ).length;
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
      // Always one of HUMAN_INBOUND_CHANNELS / HUMAN_CALLER_KINDS — the SelectFields below offer no
      // other value.
      inboundChannel: inboundChannel as TriageInboundChannel,
      callerKind: callerKind as TriageCallerKind,
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
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Paper re-entry"
            breadcrumb="On-call triage / Business continuity"
            actions={
              <Link to="/triage" style={linkButtonStyle}>
                Triage queue
              </Link>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Re-enter calls taken on paper during outage windows, bounded by documented continuity
              evidence.
            </div>
          </PageHeader>
        }
        filters={
          <div style={filterShellStyle}>
            <Notice tone="warning">
              <strong>This is the one write that back-dates a call.</strong> It exists so that calls
              taken on paper during an outage enter the record with the time they actually happened.
              Each entry is bounded by the outage window it is filed against.
            </Notice>
            {lapsed > 0 ? (
              <Notice tone="error" live>
                {lapsed} window{lapsed === 1 ? " has" : "s have"} lapsed. The re-entry path is
                closed for those; the outage is now a documented gap.
              </Notice>
            ) : null}
            {actionError ? (
              <div role="alert" style={errorBannerStyle}>
                {actionError}
              </div>
            ) : null}
          </div>
        }
        table={
          <div style={tableShellStyle}>
            {sorted.length === 0 ? (
              <div style={emptyShellStyle}>
                <EmptyState
                  title="No paper re-entry rows"
                  description="No outage window has left calls on paper."
                />
              </div>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr style={tableHeadRowStyle}>
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
                        <td style={{ ...td, fontFamily: t.fontMono }}>
                          {shortId(r.providerEntityId)}
                        </td>
                        <td style={{ ...td, fontFamily: t.fontMono }}>{shortId(r.shiftId)}</td>
                        <td style={{ ...td, fontFamily: t.fontMono }}>
                          {shortId(r.assignedToMembershipId)}
                        </td>
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
                              style={busy ? disabledButtonCompactStyle : primaryButtonCompactStyle}
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
          </div>
        }
        fullPageScroll
      />

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
            {dateTime(entering.shiftEndsAt)}. The server enforces that bound; the field below is
            pre-filled with the window's start so nothing is guessed.
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
          <TextField
            label="Caller name"
            value={callerDisplayName}
            onChange={setCallerDisplayName}
          />
          <TextField label="Patient id (optional)" value={patientId} onChange={setPatientId} mono />
          <TextField
            label="Admission id (optional)"
            value={admissionId}
            onChange={setAdmissionId}
            mono
          />
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
            The call is filed with a paper origin flag and both times: the original instant and the
            moment it was typed in. A reviewer sees both, which is the point — the record does not
            pretend the call was entered live.
          </span>
        </Modal>
      ) : null}
    </>
  );
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const tableShellStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const tableHeadRowStyle: CSSProperties = {
  background: "var(--color-surface-low)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};

const emptyShellStyle: CSSProperties = {
  padding: "2rem 1.5rem",
};

const errorBannerStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  color: "var(--color-error-pill-fg)",
  fontSize: "0.85rem",
};

const linkButtonStyle: CSSProperties = {
  ...ghostButtonStyle,
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
};

const primaryButtonCompactStyle: CSSProperties = {
  ...primaryButtonStyle,
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
};

const disabledButtonCompactStyle: CSSProperties = {
  ...disabledButtonStyle,
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
};
