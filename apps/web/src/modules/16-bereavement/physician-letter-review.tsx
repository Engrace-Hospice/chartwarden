// apps/web/src/modules/16-bereavement — the PHYSICIAN CONDOLENCE LETTER review section of the intake queue (ADR-0109 D6; routes 38-40).
//
// When a death opens a bereavement plan the agency writes a condolence letter to the patient's INTERNAL attending clinician. A human
// reviews it before anything is disclosed: bereavement oversight approves it (optionally adding a short personal note, and — when the care
// team resolved no attending — naming the internal clinician who should receive it) or declines it with a documented reason. This is a
// section of the intake queue, not a screen of its own: the people who assign counselors are the people who review letters.
//
// A reader without `bereavement.letter.read` sees NOTHING here: the intake queue does not mount this section for them, and a 403 from the
// list (a session whose permission list is stale) hides it too: no heading, no empty state, no hint that letters exist. Any other failure is
// said plainly, with a retry. Approval and decline carry the version the list READ in `If-Match`; a 412/409/404 means another reviewer moved
// first, which is said and the list reloaded. A reload keeps the list on screen: only the first load shows a placeholder.
import { Button, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  type PhysicianLetter,
  approvePhysicianLetter,
  declinePhysicianLetter,
  errorMessage,
  isStaleWrite,
  listPhysicianLetters,
} from "./bereavement-api";
import { countLabel, shortDate, shortId } from "./bereavement-status";
import {
  Card,
  ErrorText,
  Modal,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
  useActionStatus,
  useIdempotencyKey,
  visuallyHidden,
} from "./bereavement-ui";

/** The reviewer's note and a decline reason are bounded the way the server bounds them. */
const NOTE_MAX = 1000;
const DECLINE_REASON_MIN = 20;
const MS_PER_DAY = 86_400_000;
const LIST_LIMIT = 100;
/** Listing the organization's members needs its own permission; a reviewer without it types a user id instead. */
const MEMBER_LIST_PERMISSION = "member.manage";
const LETTERS_LOAD_FAILED = "The physician letters could not be loaded.";
const DECIDED_ELSEWHERE =
  "Someone else already decided that letter, so it is no longer waiting. The list has been refreshed.";

type Load =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error"; message: string }
  | { kind: "ready"; letters: PhysicianLetter[]; hasMore: boolean; refreshError?: string };

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
  const [retrying, setRetrying] = useState(false);
  const { announce, region } = useActionStatus();
  const latestRequest = useRef(0);

  /** Reload the list; resolves true when it is current. The list on screen is kept while a reload runs or fails. */
  const reload = useCallback(async (): Promise<boolean> => {
    const mine = ++latestRequest.current;
    const fail = (message: string): void =>
      setLoad((prev) =>
        prev.kind === "ready" ? { ...prev, refreshError: message } : { kind: "error", message },
      );
    const { page, error, status } = await listPhysicianLetters(client, {
      status: "pending_review",
      limit: LIST_LIMIT,
    });
    if (mine !== latestRequest.current) return false; // a newer reload (or an unmount) superseded this one
    if (error) {
      // 403 = this reader does not review letters: the section simply is not there.
      if (status === 403) setLoad({ kind: "hidden" });
      else fail(errorMessage(error, LETTERS_LOAD_FAILED));
      return false;
    }
    setLoad({ kind: "ready", letters: page?.data ?? [], hasMore: page?.has_more ?? false });
    return true;
  }, [client]);

  useEffect(() => {
    void reload();
    return () => {
      latestRequest.current += 1;
    };
  }, [reload]);

  const retry = async (): Promise<void> => {
    setRetrying(true);
    const current = await reload();
    setRetrying(false);
    if (current) announce("The letters are up to date.");
  };

  /** Close the modal that just finished, but never a newer one the reader opened since. */
  const closeModalFor = (letterId: string): void =>
    setAction((current) => (current?.letter.letterId === letterId ? null : current));

  const decided = (letter: PhysicianLetter, message: string): void => {
    closeModalFor(letter.letterId);
    announce(message);
    void reload();
  };

  if (load.kind === "hidden") return null;

  const now = Date.now();
  const letters = load.kind === "ready" ? load.letters : [];
  const failure =
    load.kind === "error" ? load.message : load.kind === "ready" ? load.refreshError : undefined;
  return (
    <>
      <Card
        title={
          load.kind === "ready"
            ? `Physician condolence letters awaiting review (${countLabel(letters.length, load.hasMore)})`
            : "Physician condolence letters"
        }
      >
        {region}
        {failure ? (
          <>
            <ErrorText>{failure}</ErrorText>
            <div>
              <Button size="sm" tone="secondary" loading={retrying} onClick={() => void retry()}>
                Try again
              </Button>
            </div>
          </>
        ) : null}
        {load.kind === "loading" ? <LoadingSpinner label="Loading physician letters" /> : null}
        {load.kind === "ready" ? (
          <>
            <span style={mutedStyle}>
              Each letter goes to the patient's attending clinician inside the agency. Nothing is
              sent until you approve it.
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
                            style={ghostButtonStyle}
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
          </>
        ) : null}
      </Card>

      {action?.mode === "approve" ? (
        <ApproveModal
          key={action.letter.letterId}
          letter={action.letter}
          onClose={() => setAction(null)}
          onDone={() => decided(action.letter, "The letter was approved and sent to be rendered.")}
          onStale={() => decided(action.letter, DECIDED_ELSEWHERE)}
        />
      ) : null}
      {action?.mode === "decline" ? (
        <DeclineModal
          key={action.letter.letterId}
          letter={action.letter}
          onClose={() => setAction(null)}
          onDone={() => decided(action.letter, "The letter was declined.")}
          onStale={() => decided(action.letter, DECIDED_ELSEWHERE)}
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
  // A reviewer without the member-list permission would only collect a 403: go straight to the user-id field.
  const mayList = session?.permissions?.includes(MEMBER_LIST_PERMISSION) ?? false;
  const willFetch = enabled && mayList && orgId !== null;
  const [state, setState] = useState<{ clinicians: Clinician[] | null; loading: boolean }>({
    clinicians: null,
    loading: willFetch,
  });

  useEffect(() => {
    if (!willFetch || orgId === null) {
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
  }, [client, willFetch, orgId]);

  return state;
}

function ApproveModal({
  letter,
  onClose,
  onDone,
  onStale,
}: {
  letter: PhysicianLetter;
  onClose: () => void;
  onDone: () => void;
  /** The letter was decided (or removed) by someone else: the parent says so and reloads. */
  onStale: () => void;
}): JSX.Element {
  const client = useApiClient();
  const needsRecipient = letter.attendingUserId === null;
  const { clinicians, loading: loadingClinicians } = useClinicians(needsRecipient);
  const [note, setNote] = useState("");
  const [attendingUserId, setAttendingUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotency = useIdempotencyKey();

  const noteLength = note.trim().length;
  const noteTooLong = noteLength > NOTE_MAX;
  const recipientMissing = needsRecipient && attendingUserId.trim() === "";

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const body = {
      ...(noteLength > 0 ? { personalNote: note.trim() } : {}),
      ...(needsRecipient ? { attendingUserId: attendingUserId.trim() } : {}),
    };
    const { error: err, status } = await approvePhysicianLetter(
      client,
      letter.letterId,
      letter.version,
      body,
      idempotency.keyFor(JSON.stringify(body)),
    );
    idempotency.settle(status);
    setBusy(false);
    if (err) {
      if (isStaleWrite(status)) onStale();
      else setError(errorMessage(err, "The letter could not be approved."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Approve physician condolence letter"
      onClose={onClose}
      busy={busy}
      dirty={note !== "" || attendingUserId !== ""}
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
      {noteTooLong ? <ErrorText>The note is over {NOTE_MAX} characters.</ErrorText> : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}

function DeclineModal({
  letter,
  onClose,
  onDone,
  onStale,
}: {
  letter: PhysicianLetter;
  onClose: () => void;
  onDone: () => void;
  onStale: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotency = useIdempotencyKey();
  const reasonLength = reason.trim().length;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const trimmed = reason.trim();
    const { error: err, status } = await declinePhysicianLetter(
      client,
      letter.letterId,
      letter.version,
      trimmed,
      idempotency.keyFor(trimmed),
    );
    idempotency.settle(status);
    setBusy(false);
    if (err) {
      if (isStaleWrite(status)) onStale();
      else setError(errorMessage(err, "The letter could not be declined."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Decline physician condolence letter"
      onClose={onClose}
      busy={busy}
      dirty={reason !== ""}
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
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}
