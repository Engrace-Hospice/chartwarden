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
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  isoToLocalInput,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import { AdmissionLookupField, PatientLookupField } from "../../shell/entity-lookups";
import { FormDrawer } from "../../shell/form-drawer";
import { runDrawerWrite } from "./drawer-write";
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
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  disabledButtonStyle,
  enumOptions,
  ghostButtonStyle,
  linkStyle,
  primaryButtonStyle,
  tdNum,
  thNum,
} from "./oncall-ui";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minutes until an instant (negative once it has passed). */
function minutesUntil(value: string, now = Date.now()): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : Math.floor((ms - now) / 60_000);
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

  // Opening a worklist row, switching to another, or closing (`null`) starts from a blank form: a draft typed for
  // one outage window must never ride into another window's filing, and a refused write's message is not carried over.
  function openFor(row: PaperReentryWorklistView | null): void {
    // The row whose drawer is already open: choosing it again must not wipe the draft being typed.
    if (row !== null && row.id === entering?.id) return;
    setEntering(row);
    setActionError(null);
    setOpenedAt(row ? isoToLocalInput(row.shiftStartsAt) : "");
    setInboundChannel(DEFAULT_INBOUND_CHANNEL);
    setCallerKind(DEFAULT_CALLER_KIND);
    setCallerDisplayName("");
    setPatientId("");
    setAdmissionId("");
    setChiefComplaint("");
  }

  async function commit(): Promise<void> {
    if (!entering) return;
    const saved = await runDrawerWrite(
      { setBusy, setError: setActionError },
      () =>
        reenterPaperCall(client, {
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
        }),
      "The paper call could not be re-entered.",
    );
    if (!saved) return;
    openFor(null);
    await load();
  }

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Paper re-entry"
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
              {lapsed} window{lapsed === 1 ? " has" : "s have"} lapsed. The re-entry path is closed
              for those; the outage is now a documented gap.
            </Notice>
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
            <table>
              <thead>
                <tr>
                  <th>Window</th>
                  <th>Provider entity</th>
                  <th>Shift</th>
                  <th>Assigned to</th>
                  <th style={thNum}>Expires in</th>
                  <th>Re-entered</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const remaining = minutesUntil(r.expiresAt);
                  const done = r.reenteredAt !== null;
                  return (
                    <tr key={r.id}>
                      <td>
                        {dateTime(r.shiftStartsAt)} → {dateTime(r.shiftEndsAt)}
                      </td>
                      <td className="wx-data-md">{shortId(r.providerEntityId)}</td>
                      <td className="wx-data-md">{shortId(r.shiftId)}</td>
                      <td className="wx-data-md">{shortId(r.assignedToMembershipId)}</td>
                      <td style={tdNum}>
                        {remaining > 0 ? (
                          durationLabel(remaining)
                        ) : (
                          <StatusPill label="Lapsed" tone="error" />
                        )}
                      </td>
                      <td>
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
                      <td>
                        {done ? (
                          <span className="wx-text-muted">filed</span>
                        ) : remaining <= 0 ? (
                          <span className="wx-text-muted">window closed</span>
                        ) : (
                          <button
                            type="button"
                            style={busy ? disabledButtonCompactStyle : primaryButtonCompactStyle}
                            disabled={busy}
                            onClick={() => openFor(r)}
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
      detail={
        entering ? (
          <FormDrawer
            key={entering.id}
            title="Re-enter a call taken on paper"
            busy={busy}
            onClose={() => openFor(null)}
            error={actionError}
            save={
              <Button
                tone="primary"
                size="lg"
                type="button"
                disabled={!canEnter}
                onClick={() => void commit()}
              >
                File the call
              </Button>
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
            <PatientLookupField
              label="Patient (optional)"
              value={patientId}
              onChange={(id) => {
                setPatientId(id);
                setAdmissionId("");
              }}
            />
            <AdmissionLookupField
              label="Admission (optional)"
              value={admissionId}
              patientId={patientId}
              onChange={(id) => setAdmissionId(id)}
            />
            {!anchorValid ? (
              <p className="wx-text-error">Patient and admission travel together or not at all.</p>
            ) : null}
            <TextAreaField
              label="Chief complaint as recorded on paper"
              value={chiefComplaint}
              onChange={setChiefComplaint}
              rows={3}
            />
            <span className="wx-text-muted">
              The call is filed with a paper origin flag and both times: the original instant and
              the moment it was typed in. A reviewer sees both, which is the point — the record does
              not pretend the call was entered live.
            </span>
          </FormDrawer>
        ) : undefined
      }
    />
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

const emptyShellStyle: CSSProperties = {
  padding: "2rem 1.5rem",
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
