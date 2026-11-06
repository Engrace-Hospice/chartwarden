// apps/web/src/modules/16-bereavement — the PHYSICIAN CONDOLENCE LETTER review section of the intake queue (ADR-0109 D6; routes 38-40).
//
// When a death opens a bereavement plan the agency writes a condolence letter to the patient's INTERNAL attending clinician. A human
// reviews it before anything is disclosed: bereavement oversight approves it (optionally adding a short personal note, and — when the care
// team resolved no attending — naming the internal clinician who should receive it) or declines it with a documented reason. This is a
// section of the intake queue, not a screen of its own: the people who assign counselors are the people who review letters.
//
// A reader without `bereavement.letter.read` (403) sees NOTHING here: no heading, no empty state, no hint that letters exist. Any other
// failure is said plainly. Approval and decline carry the version the list READ in `If-Match`; a 412 means another reviewer moved first.
import { StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  type PhysicianLetter,
  approvePhysicianLetter,
  declinePhysicianLetter,
  errorMessage,
  listPhysicianLetters,
} from "./bereavement-api";
import { shortDate, shortId } from "./bereavement-status";
import {
  Card,
  Modal,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  alertStyle,
  linkStyle,
  mutedStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
  visuallyHidden,
} from "./bereavement-ui";

/** The reviewer's note and a decline reason are bounded the way the server bounds them. */
const NOTE_MAX = 1000;
const DECLINE_REASON_MIN = 20;
const MS_PER_DAY = 86_400_000;

type Load =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error"; message: string }
  | { kind: "ready"; letters: PhysicianLetter[] };

type Action = { letter: PhysicianLetter; mode: "approve" | "decline" } | null;

/** Whole days since the letter was opened ("today" is 0). */
export function letterAgeDays(createdAt: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(createdAt)) / MS_PER_DAY));
}

/** The age badge text. A letter past its due date (death + 2 days) says so: a late review is a late letter. */
function ageBadge(letter: PhysicianLetter, now: number): { label: string; overdue: boolean } {
  const days = letterAgeDays(letter.createdAt, now);
  const age = days === 0 ? "Opened today" : days === 1 ? "1 day old" : `${days} days old`;
  const overdue = Date.parse(letter.dueAt) < now;
  return { label: overdue ? `${age} · overdue` : age, overdue };
}

export function PhysicianLetterReview(): JSX.Element | null {
  const client = useApiClient();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [action, setAction] = useState<Action>(null);

  const reload = useCallback(async () => {
    const { page, error, status } = await listPhysicianLetters(client, {
      status: "pending_review",
      limit: 100,
    });
    if (error) {
      // 403 = this reader does not review letters: the section simply is not there.
      setLoad(
        status === 403
          ? { kind: "hidden" }
          : {
              kind: "error",
              message: errorMessage(error, "The physician letters could not be loaded."),
            },
      );
      return;
    }
    setLoad({ kind: "ready", letters: page?.data ?? [] });
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (load.kind === "loading" || load.kind === "hidden") return null;
  if (load.kind === "error") {
    return (
      <Card title="Physician condolence letters">
        <p style={alertStyle}>{load.message}</p>
      </Card>
    );
  }

  const now = Date.now();
  const { letters } = load;
  return (
    <>
      <Card title={`Physician condolence letters awaiting review (${letters.length})`}>
        <span style={mutedStyle}>
          Each letter goes to the patient's attending clinician inside the agency. Nothing is sent
          until you approve it.
        </span>
        {letters.length === 0 ? (
          <span style={mutedStyle}>No letters are waiting for review.</span>
        ) : (
          <table style={tableStyle} aria-label="Physician letters awaiting review">
            <thead>
              <tr>
                <th style={th}>Plan</th>
                <th style={th}>Age</th>
                <th style={th}>Due</th>
                <th style={th}>Attending</th>
                <th style={th}>
                  <span style={visuallyHidden}>Review</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {letters.map((letter) => {
                const badge = ageBadge(letter, now);
                return (
                  <tr key={letter.letterId} style={rowLine}>
                    <td style={td}>
                      <Link to={`/bereavement/plans/${letter.planId}`} style={linkStyle}>
                        {shortId(letter.planId)}
                      </Link>
                    </td>
                    <td style={td}>
                      <StatusPill
                        label={badge.label}
                        tone={badge.overdue ? "warning" : "neutral"}
                      />
                    </td>
                    <td style={td}>{shortDate(letter.dueAt)}</td>
                    <td style={td}>
                      {letter.attendingUserId ? (
                        shortId(letter.attendingUserId)
                      ) : (
                        <span style={mutedStyle}>None resolved</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        style={primaryButtonStyle}
                        aria-label={`Approve the letter for plan ${shortId(letter.planId)}`}
                        onClick={() => setAction({ letter, mode: "approve" })}
                      >
                        Approve
                      </button>{" "}
                      <button
                        type="button"
                        style={{
                          ...primaryButtonStyle,
                          background: "transparent",
                          color: "inherit",
                        }}
                        aria-label={`Decline the letter for plan ${shortId(letter.planId)}`}
                        onClick={() => setAction({ letter, mode: "decline" })}
                      >
                        Decline
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {action?.mode === "approve" ? (
        <ApproveModal
          letter={action.letter}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            void reload();
          }}
        />
      ) : null}
      {action?.mode === "decline" ? (
        <DeclineModal
          letter={action.letter}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            void reload();
          }}
        />
      ) : null}
    </>
  );
}

/** One internal member the reviewer may name as the recipient (a user id the server re-checks as an ACTIVE member). */
interface Clinician {
  readonly userId: string;
  readonly label: string;
}

/**
 * The internal clinician picker. It lists the organization's active members when the reviewer may read them; a reviewer who may not
 * (the member list needs its own permission) gets a plain user-id field instead. Either way the SERVER decides: it refuses a user who is
 * not an active member of this organization, so a typed id proves nothing until the approval answers.
 */
function useClinicians(enabled: boolean): { clinicians: Clinician[] | null; loading: boolean } {
  const client = useApiClient();
  const session = useSession();
  const orgId = session?.organizationId ?? null;
  const [state, setState] = useState<{ clinicians: Clinician[] | null; loading: boolean }>({
    clinicians: null,
    loading: enabled,
  });

  useEffect(() => {
    if (!enabled || orgId === null) {
      setState({ clinicians: null, loading: false });
      return;
    }
    let active = true;
    void client
      .GET("/api/v1/orgs/{id}/members", { params: { path: { id: orgId }, query: {} } })
      .then((res) => {
        if (!active) return;
        if (res.error || !res.data) {
          setState({ clinicians: null, loading: false });
          return;
        }
        const clinicians = res.data.members
          .filter((m) => m.status === "active")
          .map((m) => ({
            userId: m.userId,
            label: m.displayName ?? m.email ?? shortId(m.userId),
          }))
          .sort((a, b) => a.label.localeCompare(b.label));
        setState({ clinicians, loading: false });
      })
      .catch(() => {
        if (active) setState({ clinicians: null, loading: false });
      });
    return () => {
      active = false;
    };
  }, [client, enabled, orgId]);

  return state;
}

function ApproveModal({
  letter,
  onClose,
  onDone,
}: {
  letter: PhysicianLetter;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const client = useApiClient();
  const needsRecipient = letter.attendingUserId === null;
  const { clinicians, loading: loadingClinicians } = useClinicians(needsRecipient);
  const [note, setNote] = useState("");
  const [attendingUserId, setAttendingUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noteLength = note.trim().length;
  const noteTooLong = noteLength > NOTE_MAX;
  const recipientMissing = needsRecipient && attendingUserId.trim() === "";

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const { error: err } = await approvePhysicianLetter(client, letter.letterId, letter.version, {
      ...(noteLength > 0 ? { personalNote: note.trim() } : {}),
      ...(needsRecipient ? { attendingUserId: attendingUserId.trim() } : {}),
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The letter could not be approved."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Approve physician condolence letter"
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || noteTooLong || recipientMissing}
          onClick={submit}
        >
          {busy ? "Approving…" : "Approve letter"}
        </button>
      }
    >
      <span style={mutedStyle}>
        Plan {shortId(letter.planId)} · read at version {letter.version}. Approving sends the letter
        to Module 22 to be rendered; a letter someone else already decided is refused.
      </span>
      {needsRecipient ? (
        <>
          <Notice tone="warning">
            The care team has no attending clinician on record for this patient. Choose the
            clinician inside the agency who should receive the letter.
          </Notice>
          {loadingClinicians ? (
            <span style={mutedStyle}>Loading the agency's clinicians…</span>
          ) : clinicians !== null ? (
            <SelectField
              label="Internal clinician"
              value={attendingUserId}
              onChange={setAttendingUserId}
              options={[
                { value: "", label: "Choose a clinician…" },
                ...clinicians.map((c) => ({ value: c.userId, label: c.label })),
              ]}
            />
          ) : (
            <TextField
              label="Internal clinician user id"
              value={attendingUserId}
              onChange={setAttendingUserId}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          )}
        </>
      ) : (
        <span style={mutedStyle}>
          Addressed to the attending clinician on the care team ({shortId(letter.attendingUserId)}).
        </span>
      )}
      <TextAreaField
        label="Personal note (optional)"
        value={note}
        onChange={setNote}
        hint={`${noteLength} of ${NOTE_MAX} characters. Printed on the letter and kept sealed in the record.`}
      />
      {noteTooLong ? <p style={alertStyle}>The note is over {NOTE_MAX} characters.</p> : null}
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}

function DeclineModal({
  letter,
  onClose,
  onDone,
}: {
  letter: PhysicianLetter;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonLength = reason.trim().length;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const { error: err } = await declinePhysicianLetter(
      client,
      letter.letterId,
      letter.version,
      reason.trim(),
    );
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The letter could not be declined."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Decline physician condolence letter"
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || reasonLength < DECLINE_REASON_MIN}
          onClick={submit}
        >
          {busy ? "Declining…" : "Decline letter"}
        </button>
      }
    >
      <span style={mutedStyle}>
        Plan {shortId(letter.planId)} · read at version {letter.version}. A declined letter is not
        sent and is not reopened.
      </span>
      <TextAreaField
        label="Reason"
        value={reason}
        onChange={setReason}
        hint={`At least ${DECLINE_REASON_MIN} characters (${reasonLength} so far). Kept in the record; do not include clinical detail.`}
      />
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}
