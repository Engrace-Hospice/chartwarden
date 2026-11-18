// apps/web/src/modules/08-encounters — the GRANT-OVERRIDE DRAWER of the supervisor overdue board (ADR-0113). One overdue note's facts, then
// the form that lets a supervisor lift the closure block for the note's author for 1 to 24 hours:
//   POST /api/v1/encounters/closure-overrides  { subjectMembershipId, reason (>= 40 chars), hours }  (fresh step-up, Idempotency-Key)
//   POST /api/v1/encounters/closure-overrides/{id}/revoke                                              (fresh step-up)
// The override lifts only the block for that clinician: the note stays open and its alerts and deadline do not change. A grant is held
// here only for the session (there is no list-overrides route yet), so Revoke is offered for the grant just made.
// STEP-UP: a refusal stashes what was typed (in memory only: the reason is free text) and sends the supervisor to /step-up; the board
// reopens this drawer from `?note=` and the form is restored, and nothing is sent for them. IDEMPOTENCY: the grant runs under
// `useAttemptKey`, so a retry of the SAME attempt after a lost reply carries the same key and an edit starts a new one.
// ANNOUNCING: ONE polite status line sits in the drawer from the first render and its text is filled in when a grant or a revoke lands
// (a live region is only announced for a change inside a region that was already there). Focus moves to the drawer's heading at the same
// moment, because the button that was pressed is replaced by the other state's form. A late answer to a drawer that was closed in the
// meantime records the grant for the board and does nothing else: no navigation, no stashed draft, no state.
import {
  CLOSURE_OVERRIDE_DEFAULT_HOURS,
  CLOSURE_OVERRIDE_MAX_HOURS,
  CLOSURE_OVERRIDE_MIN_REASON_CHARS,
} from "@chartwarden/types";
import {
  Button,
  Glyph,
  InlineAlert,
  StatusPill,
  TextAreaField,
  TextField,
  useApiClient,
  useAttemptKey,
  useDrawerA11y,
} from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { formatClosureInstant } from "../../shell/closure-instant";
import {
  type StepUpDraftOwner,
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
  stepUpRedirectFor,
} from "../../shell/step-up-redirect";
import { useStepUpOwner } from "../../shell/use-step-up-return";
import {
  type ClosureOverrideView,
  type HeldOverride,
  type OverdueNote,
  type RevokedOverrideView,
  SUBJECT_NOT_BLOCKED_CODE,
  describeRefusal,
  grantOverride,
  reasonFieldError,
  refusalSentence,
  revokeOverride,
} from "./closure-api";
import {
  OVERRIDE_MIN_HOURS,
  OVERRIDE_REASON_MAX_CHARS,
  STAGE_LABEL,
  STAGE_TONE,
  isGrantActive,
  overrideStatusText,
  parseOverrideHours,
  reasonLength,
  timingLabel,
} from "./closure-model";
import { ENCOUNTER_TONE, stateLabel } from "./encounter-status";
import { useIsMounted } from "./use-is-mounted";

/** The step-up draft action of the grant form; the board discards an abandoned draft of it. */
export const GRANT_OVERRIDE_ACTION = "encounters.closure.override";
export const CLOSURE_DRAFT_ACTIONS: readonly string[] = [GRANT_OVERRIDE_ACTION];

/** The step-up draft key of the grant form for the note `encounterId` (null when there is no session to scope it to). */
export const grantDraftKey = (owner: StepUpDraftOwner | null, encounterId: string): string | null =>
  stepUpDraftKey(owner, GRANT_OVERRIDE_ACTION, encounterId);

interface Fields {
  reason: string;
  hours: string;
}
type FieldErrors = Partial<Record<keyof Fields, string>>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>).reason === "string" &&
  typeof (value as Record<string, unknown>).hours === "string";

const REASON_HINT_PHI = "Recorded in the audit trail. Do not include patient names or identifiers.";

/**
 * Where the open note stands on the board's latest read. `listed`: it is there and overrides are on. `gone`: a refresh no longer lists it
 * (it was probably closed), so granting may find nothing to lift. `not-blocking`: the organization's mode is no longer `block`, so no
 * override is needed. In the last two the drawer stays open, with what was typed, until the supervisor closes it.
 */
export type NoteBoardState = "listed" | "gone" | "not-blocking";

const BOARD_STATE_TEXT: Readonly<Record<Exclude<NoteBoardState, "listed">, string>> = {
  gone: "This note is no longer on the board, so it may already be closed. The panel stays open until you close it.",
  "not-blocking":
    "Your organization no longer blocks clinicians for overdue notes, so no override is needed. The panel stays open until you close it.",
};

/** The status line's box: it takes no room while it is empty, and lines up with the cards below once it has something to say. */
const statusLineStyle = (hasText: boolean) =>
  hasText ? ({ display: "block", padding: "0 1.125rem" } as const) : undefined;

export interface OverrideGrantDrawerProps {
  readonly note: OverdueNote;
  readonly patientName: string;
  readonly clinicianName: string;
  /** The grant made for this clinician in this session, if any (it may have expired or been revoked). */
  readonly grant: HeldOverride | null;
  /** Where the note stands on the board's latest read (the drawer is kept open for the supervisor when it is not `listed`). */
  readonly boardState: NoteBoardState;
  /** True when the supervisor is genuinely back from /step-up: a stashed draft for this note is restored. */
  readonly resume: boolean;
  readonly onClose: () => void;
  readonly onGranted: (grant: ClosureOverrideView) => void;
  readonly onRevoked: (grant: RevokedOverrideView) => void;
  /** The server says the board's picture is out of date (the clinician is no longer blocked): the board re-reads. */
  readonly onStale: () => void;
}

export function OverrideGrantDrawer({
  note,
  patientName,
  clinicianName,
  grant,
  boardState,
  resume,
  onClose,
  onGranted,
  onRevoked,
  onStale,
}: OverrideGrantDrawerProps): JSX.Element {
  const owner = useStepUpOwner();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const now = new Date();
  const active = grant !== null && isGrantActive(grant, now);
  const close = (): void => {
    clearStepUpDraft(grantDraftKey(owner, note.encounterId)); // closing abandons the draft
    onClose();
  };
  // Escape closes through the same path as Close and Cancel (so it abandons the stashed draft too), and a grant or a revoke resets the
  // drawer's "edited" latch: after a grant the typed reason is gone, so Escape must close again.
  const drawer = useDrawerA11y<HTMLElement>(
    close,
    `${grant?.id ?? "none"}:${active ? "active" : "idle"}`,
  );
  // The pressed button is replaced by the other state's form, so focus goes to a part of the drawer that stays. Once the drawer is gone
  // the ref is null and nothing moves.
  const settled =
    <T,>(done: (settledGrant: T) => void) =>
    (settledGrant: T): void => {
      headingRef.current?.focus();
      done(settledGrant);
    };
  // A grant's confirmation is good news (success); that the board no longer needs an override here is a notice (info).
  const grantText = overrideStatusText(grant, clinicianName, now);
  const boardText = boardState === "listed" ? null : BOARD_STATE_TEXT[boardState];
  const statusText = grantText ?? boardText;
  return (
    <aside className="wx-admission-drawer" {...drawer} aria-label={`Override for ${clinicianName}`}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="shield-check" size={20} />
        </span>
        <div>
          <h2 ref={headingRef} tabIndex={-1}>
            Grant override
          </h2>
          <div className="wx-row-sub">{clinicianName}</div>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close override panel" onClick={close}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <output style={statusLineStyle(statusText !== null)}>
        {statusText ? (
          <InlineAlert tone={grantText === null ? "info" : "success"} live={false}>
            {statusText}
          </InlineAlert>
        ) : null}
      </output>
      <div className="wx-drawer-body">
        <NoteFacts note={note} patientName={patientName} clinicianName={clinicianName} />
        {active && grant ? (
          <ActiveGrant grant={grant} onRevoked={settled(onRevoked)} />
        ) : (
          <section className="wx-drawer-card">
            <h3>Lift the block for a while</h3>
            <p className="wx-row-sub">
              {`${clinicianName} will be able to use the rest of the app for the hours you choose. The note stays open: its alerts and deadline do not change, and this does not replace a late-entry override. Your name and the reason are recorded in the audit trail.`}
            </p>
            <GrantForm
              note={note}
              resume={resume}
              onGranted={settled(onGranted)}
              onStale={onStale}
              onCancel={close}
            />
          </section>
        )}
      </div>
    </aside>
  );
}

function NoteFacts({
  note,
  patientName,
  clinicianName,
}: {
  note: OverdueNote;
  patientName: string;
  clinicianName: string;
}): JSX.Element {
  return (
    <section className="wx-drawer-card">
      <div className="wx-drawer-card-head">
        <h3>Open note</h3>
        <StatusPill label={STAGE_LABEL[note.stage]} tone={STAGE_TONE[note.stage]} />
      </div>
      <dl className="wx-kv">
        <Fact label="Patient">{patientName}</Fact>
        <Fact label="Clinician">{clinicianName}</Fact>
        <Fact label="Visit">
          {`${stateLabel(note.encounterType)}, ${stateLabel(note.discipline)}`}
        </Fact>
        <Fact label="Service date">
          <span className="wx-nums">{note.serviceDate}</span>
        </Fact>
        <Fact label="Status">
          <StatusPill
            label={stateLabel(note.status)}
            tone={ENCOUNTER_TONE[note.status] ?? "neutral"}
          />
        </Fact>
        <Fact label="Deadline">
          <span className="wx-nums">{formatClosureInstant(note.deadlineAt)}</span>
        </Fact>
        <Fact label="Timing">
          {timingLabel(note.stage, note.hoursOverdue, note.deadlineAt, new Date())}
        </Fact>
      </dl>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function ActiveGrant({
  grant,
  onRevoked,
}: {
  grant: HeldOverride;
  onRevoked: (grant: RevokedOverrideView) => void;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const mounted = useIsMounted();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const revoke = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const outcome = await revokeOverride(client, grant.id);
    inFlight.current = false;
    if (mounted.current) setBusy(false);
    if (outcome.ok) {
      onRevoked(outcome.data); // the board keeps it even if the drawer was closed meanwhile
      return;
    }
    if (!mounted.current) return; // the supervisor left: no navigation, no state
    if (outcome.status === 401) {
      navigate("/login");
      return;
    }
    const stepUp = stepUpRedirectFor(outcome.error, `${location.pathname}${location.search}`);
    if (stepUp) {
      navigate(stepUp);
      return;
    }
    setError(refusalSentence(describeRefusal(outcome)));
  };

  return (
    <section className="wx-drawer-card">
      <h3>Override active</h3>
      <p className="wx-row-sub">
        Revoke it to limit them again at once. The grant is kept in the audit trail either way.
      </p>
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      <div className="wx-drawer-actions">
        <Button tone="secondary" loading={busy} onClick={() => void revoke()}>
          Revoke override
        </Button>
      </div>
    </section>
  );
}

function GrantForm({
  note,
  resume,
  onGranted,
  onStale,
  onCancel,
}: {
  note: OverdueNote;
  resume: boolean;
  onGranted: (grant: ClosureOverrideView) => void;
  onStale: () => void;
  onCancel: () => void;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const owner = useStepUpOwner();
  const mounted = useIsMounted();
  const draftKey = grantDraftKey(owner, note.encounterId);
  const [fields, setFields] = useState<Fields>(() => {
    const draft = resume ? peekStepUpDraft<unknown>(draftKey) : null;
    return isFields(draft) ? draft : { reason: "", hours: String(CLOSURE_OVERRIDE_DEFAULT_HOURS) };
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // One key per attempt, held by the shared useAttemptKey: kept across a retry of the same request while no answer settled it (a thrown
  // fetch, a gateway page, the in-flight 409), renewed on any other answer and when the reason, the hours or the clinician change.
  const attempt = useAttemptKey();

  // Fixing a field retires the refusal that was about it: leaving the old error and aria-invalid beside a "Long enough." hint contradicts it.
  const edit =
    (name: keyof Fields) =>
    (value: string): void => {
      setFields((previous) => ({ ...previous, [name]: value }));
      setFieldErrors(({ [name]: _fixed, ...rest }) => rest);
    };

  const submit = async (): Promise<void> => {
    if (inFlight.current) return;
    const hours = parseOverrideHours(fields.hours);
    const errors: FieldErrors = {
      ...(reasonLength(fields.reason) < CLOSURE_OVERRIDE_MIN_REASON_CHARS
        ? {
            reason: `Enter at least ${CLOSURE_OVERRIDE_MIN_REASON_CHARS} characters so the audit trail says why.`,
          }
        : {}),
      ...(hours === null
        ? {
            hours: `Enter a whole number of hours from ${OVERRIDE_MIN_HOURS} to ${CLOSURE_OVERRIDE_MAX_HOURS}.`,
          }
        : {}),
    };
    setFieldErrors(errors);
    setNotice(null);
    if (hours === null || errors.reason) return;
    inFlight.current = true;
    setBusy(true);
    const outcome = await grantOverride(client, attempt, {
      subjectMembershipId: note.authoredByMembershipId,
      reason: fields.reason.trim(),
      hours,
    });
    inFlight.current = false;
    if (mounted.current) setBusy(false);
    if (outcome.ok) {
      clearStepUpDraft(draftKey);
      onGranted(outcome.data); // the board keeps it even if the drawer was closed meanwhile
      return;
    }
    if (!mounted.current) return; // the supervisor left: no navigation, no stashed draft, no state
    if (outcome.status === 401) {
      navigate("/login");
      return;
    }
    const stepUp = stepUpRedirectFor(outcome.error, `${location.pathname}${location.search}`);
    if (stepUp) {
      // The guard refused before doing anything and the attempt key is already retired: stash what was typed and re-verify.
      stashStepUpDraft(draftKey, fields);
      navigate(stepUp);
      return;
    }
    const failure = describeRefusal(outcome);
    const reasonError = reasonFieldError(failure);
    const hoursError = failure.fieldErrors.hours;
    setFieldErrors({
      ...(reasonError ? { reason: reasonError } : {}),
      ...(hoursError ? { hours: hoursError } : {}),
    });
    setNotice(reasonError || hoursError ? null : refusalSentence(failure));
    if (failure.code === SUBJECT_NOT_BLOCKED_CODE) onStale();
  };

  const remaining = CLOSURE_OVERRIDE_MIN_REASON_CHARS - reasonLength(fields.reason);
  return (
    <form
      className="wx-form-stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextAreaField
        label="Reason"
        required
        rows={4}
        maxLength={OVERRIDE_REASON_MAX_CHARS}
        value={fields.reason}
        error={fieldErrors.reason}
        hint={`${REASON_HINT_PHI} ${
          remaining > 0
            ? `${remaining} more characters needed (${CLOSURE_OVERRIDE_MIN_REASON_CHARS} minimum).`
            : "Long enough."
        }`}
        onChange={(event) => edit("reason")(event.target.value)}
      />
      <TextField
        label="Hours"
        required
        inputMode="numeric"
        autoComplete="off"
        value={fields.hours}
        error={fieldErrors.hours}
        hint={`${OVERRIDE_MIN_HOURS} to ${CLOSURE_OVERRIDE_MAX_HOURS} hours. It ends by itself.`}
        onChange={(event) => edit("hours")(event.target.value)}
      />
      {notice ? <InlineAlert tone="error">{notice}</InlineAlert> : null}
      <div className="wx-drawer-actions">
        <Button type="submit" loading={busy}>
          Grant override
        </Button>
        <Button tone="tertiary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
