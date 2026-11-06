// apps/web/src/modules/16-bereavement — one support group's SESSIONS (ADR-0109 D10, routes 59, 60, 62, 64).
//
// The schedule, oldest first. `bereavement.group.manage` adds a session and cancels a scheduled one (the cancel carries that session's
// version in `If-Match`); `bereavement.group.run` records who came, and only once a session has started (the server refuses earlier). Every
// write carries one `Idempotency-Key` per attempt; a refused stale write closes its dialog, reloads the sessions and says why.
import { Button, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback, useId, useState } from "react";
import type { JSX } from "react";
import { errorMessage, isStaleWrite } from "./bereavement-api";
import { dateTime, humanize, toneOf } from "./bereavement-status";
import {
  Card,
  CheckboxField,
  ErrorText,
  Modal,
  TextField,
  dangerButtonStyle,
  mutedStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
  useIdempotencyKey,
  visuallyHidden,
} from "./bereavement-ui";
import { type Loaded, useLoaded } from "./mailing-load";
import { SESSION_STATUS_TONE, canEditGroup, localToIso, sessionStarted } from "./program-status";
import {
  type Group,
  type GroupRoster,
  type GroupSession,
  addSession,
  cancelSession,
  listSessions,
  recordAttendance,
} from "./programs-api";

const SESSIONS_LOAD_FAILED = "The sessions could not be loaded.";
const SESSION_MOVED =
  "This session changed while you were working on it. The sessions have been refreshed: check them and try again.";

type Ceremony =
  | { kind: "add" }
  | { kind: "cancel"; session: GroupSession }
  | { kind: "attend"; session: GroupSession }
  | null;

export function GroupSessions({
  group,
  mayManage,
  mayRun,
  roster,
  announce,
  onAttendanceRecorded,
}: {
  group: Group;
  mayManage: boolean;
  mayRun: boolean;
  roster: Loaded<GroupRoster>;
  announce: (message: string) => void;
  onAttendanceRecorded: () => void;
}): JSX.Element | null {
  const client = useApiClient();
  const fetchSessions = useCallback(
    () => listSessions(client, group.groupId),
    [client, group.groupId],
  );
  const { state, reload } = useLoaded<GroupSession[]>(fetchSessions, SESSIONS_LOAD_FAILED);
  const [ceremony, setCeremony] = useState<Ceremony>(null);

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <LoadingSpinner label="Loading the sessions" />;
  const failure = state.kind === "error" ? state.message : state.notice;
  const sessions = state.kind === "ready" ? state.data : [];
  const mayAdd = mayManage && canEditGroup(group.status);
  const enrolled =
    roster.kind === "ready"
      ? roster.data.entries.filter((e) => e.enrollmentStatus === "enrolled")
      : [];
  const finish = (message: string): void => {
    setCeremony(null);
    void reload();
    announce(message);
  };

  return (
    <Card
      title="Sessions"
      actions={
        mayAdd ? (
          <Button size="sm" tone="secondary" onClick={() => setCeremony({ kind: "add" })}>
            Add session
          </Button>
        ) : null
      }
    >
      {failure ? (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>{failure}</ErrorText>
          <Button size="sm" tone="secondary" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      ) : null}
      {state.kind === "ready" && sessions.length === 0 ? (
        <span style={mutedStyle}>No session is scheduled.</span>
      ) : null}
      {sessions.length > 0 ? (
        <table style={tableStyle} aria-label="Group sessions">
          <thead>
            <tr>
              <th style={thNum}>No.</th>
              <th style={th}>Starts</th>
              <th style={th}>Ends</th>
              <th style={th}>Status</th>
              <th style={thNum}>Attendees</th>
              <th style={th}>
                <span style={visuallyHidden}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.sessionId} style={rowLine}>
                <td style={tdNum}>{session.sessionNo}</td>
                <td style={td}>{dateTime(session.startsAt)}</td>
                <td style={td}>{dateTime(session.endsAt)}</td>
                <td style={td}>
                  <StatusPill
                    label={humanize(session.status)}
                    tone={toneOf(SESSION_STATUS_TONE, session.status)}
                  />
                </td>
                <td style={tdNum}>{session.attendeeCount}</td>
                <td style={td}>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    {mayRun && sessionStarted(session) ? (
                      <Button
                        size="sm"
                        tone="secondary"
                        aria-label={`Record attendance for session ${session.sessionNo}`}
                        onClick={() => setCeremony({ kind: "attend", session })}
                      >
                        Record attendance
                      </Button>
                    ) : null}
                    {mayManage && session.status === "scheduled" ? (
                      <Button
                        size="sm"
                        tone="secondary"
                        aria-label={`Cancel session ${session.sessionNo}`}
                        onClick={() => setCeremony({ kind: "cancel", session })}
                      >
                        Cancel session
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {ceremony?.kind === "add" ? (
        <AddSessionModal
          onClose={() => setCeremony(null)}
          submit={(body, key) => addSession(client, group.groupId, body, key)}
          onDone={finish}
        />
      ) : null}
      {ceremony?.kind === "cancel" ? (
        <CancelSessionModal
          session={ceremony.session}
          onClose={() => setCeremony(null)}
          submit={(key) =>
            cancelSession(
              client,
              group.groupId,
              ceremony.session.sessionId,
              ceremony.session.version,
              key,
            )
          }
          onDone={(message) => finish(message)}
        />
      ) : null}
      {ceremony?.kind === "attend" ? (
        <AttendanceModal
          session={ceremony.session}
          enrolled={enrolled}
          onClose={() => setCeremony(null)}
          submit={(ids, key) =>
            recordAttendance(client, group.groupId, ceremony.session.sessionId, ids, key)
          }
          onDone={(message) => {
            finish(message);
            onAttendanceRecorded();
          }}
        />
      ) : null}
    </Card>
  );
}

type Result<T> = { data: T | null; error: unknown; status: number };

/** One write per dialog: an idempotency key per attempt, the dialog stays open on a failure that is not stale. */
function useDialogWrite<A extends unknown[], T>(
  call: (key: string, ...args: A) => Promise<Result<T>>,
  fallback: string,
) {
  const keys = useIdempotencyKey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    fingerprint: string,
    ...args: A
  ): Promise<{ data: T } | { stale: string } | null> => {
    if (busy) return null;
    setBusy(true);
    setError(null);
    const res = await call(keys.keyFor(fingerprint), ...args);
    keys.settle(res.status);
    setBusy(false);
    if (res.error || res.data === null) {
      if (isStaleWrite(res.status)) {
        return { stale: res.status === 412 ? SESSION_MOVED : errorMessage(res.error, fallback) };
      }
      setError(errorMessage(res.error, fallback));
      return null;
    }
    return { data: res.data };
  };
  return { busy, error, setError, run };
}

function AddSessionModal({
  onClose,
  submit,
  onDone,
}: {
  onClose: () => void;
  submit: (
    body: { startsAt: string; endsAt: string },
    key: string,
  ) => Promise<Result<GroupSession>>;
  onDone: (message: string) => void;
}): JSX.Element {
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const write = useDialogWrite(
    (key, body: { startsAt: string; endsAt: string }) => submit(body, key),
    "The session could not be added.",
  );
  const save = async (): Promise<void> => {
    const startsAt = localToIso(starts);
    const endsAt = localToIso(ends);
    if (!startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt)) {
      write.setError("Choose a start and an end, with the end after the start.");
      return;
    }
    const out = await write.run(`${startsAt}|${endsAt}`, { startsAt, endsAt });
    if (out) onDone("stale" in out ? out.stale : "The session was added.");
  };
  return (
    <Modal
      title="Add a session"
      onClose={onClose}
      busy={write.busy}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={write.busy}
          onClick={() => void save()}
        >
          {write.busy ? "Adding…" : "Add session"}
        </button>
      }
    >
      <TextField label="Starts" type="datetime-local" value={starts} onChange={setStarts} />
      <TextField label="Ends" type="datetime-local" value={ends} onChange={setEnds} />
      {write.error ? <ErrorText>{write.error}</ErrorText> : null}
    </Modal>
  );
}

function CancelSessionModal({
  session,
  onClose,
  submit,
  onDone,
}: {
  session: GroupSession;
  onClose: () => void;
  submit: (key: string) => Promise<Result<GroupSession>>;
  onDone: (message: string) => void;
}): JSX.Element {
  const descId = useId();
  const write = useDialogWrite((key) => submit(key), "The session could not be cancelled.");
  const confirm = async (): Promise<void> => {
    const out = await write.run(`cancel:${session.sessionId}:${session.version}`);
    if (out) onDone("stale" in out ? out.stale : `Session ${session.sessionNo} was cancelled.`);
  };
  return (
    <Modal
      title={`Cancel session ${session.sessionNo}`}
      onClose={onClose}
      busy={write.busy}
      role="alertdialog"
      describedBy={descId}
      cancelLabel="Keep session"
      footer={
        <button
          type="button"
          style={dangerButtonStyle}
          disabled={write.busy}
          onClick={() => void confirm()}
        >
          {write.busy ? "Cancelling…" : "Yes, cancel this session"}
        </button>
      }
    >
      <span id={descId} style={mutedStyle}>
        The session on {dateTime(session.startsAt)} will not take place. A cancelled session cannot
        be restored; add a new one instead.
      </span>
      {write.error ? <ErrorText>{write.error}</ErrorText> : null}
    </Modal>
  );
}

function AttendanceModal({
  session,
  enrolled,
  onClose,
  submit,
  onDone,
}: {
  session: GroupSession;
  enrolled: GroupRoster["entries"];
  onClose: () => void;
  submit: (
    ids: string[],
    key: string,
  ) => Promise<Result<{ recordedCount: number; alreadyRecordedCount: number }>>;
  onDone: (message: string) => void;
}): JSX.Element {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const write = useDialogWrite(
    (key, ids: string[]) => submit(ids, key),
    "Attendance could not be recorded.",
  );
  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const save = async (): Promise<void> => {
    const ids = [...picked].sort();
    const out = await write.run(`attend:${session.sessionId}:${ids.join(",")}`, ids);
    if (!out) return;
    if ("stale" in out) {
      onDone(out.stale);
      return;
    }
    const { recordedCount, alreadyRecordedCount } = out.data;
    onDone(
      alreadyRecordedCount > 0
        ? `Attendance recorded for ${recordedCount}. ${alreadyRecordedCount} had already been recorded.`
        : `Attendance recorded for ${recordedCount}.`,
    );
  };
  return (
    <Modal
      title={`Attendance for session ${session.sessionNo}`}
      onClose={onClose}
      busy={write.busy}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={write.busy || picked.size === 0}
          onClick={() => void save()}
        >
          {write.busy ? "Recording…" : "Record attendance"}
        </button>
      }
    >
      {enrolled.length === 0 ? (
        <span style={mutedStyle}>
          No enrolled family to mark. Enroll families from their contact page.
        </span>
      ) : (
        <fieldset
          disabled={write.busy}
          style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: "0.4rem" }}
        >
          <legend style={mutedStyle}>Who came to this session?</legend>
          {enrolled.map((entry) => (
            <CheckboxField
              key={entry.contactId}
              label={entry.displayName}
              checked={picked.has(entry.contactId)}
              onChange={(on) => toggle(entry.contactId, on)}
            />
          ))}
        </fieldset>
      )}
      {write.error ? <ErrorText>{write.error}</ErrorText> : null}
    </Modal>
  );
}
