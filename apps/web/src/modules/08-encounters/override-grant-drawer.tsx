// apps/web/src/modules/08-encounters — the GRANT-OVERRIDE DRAWER of the supervisor overdue board (ADR-0113). One overdue note's facts, then
// the form that lets a supervisor lift the closure block for the note's author for 1 to 24 hours:
//   POST /api/v1/encounters/closure-overrides  { subjectMembershipId, reason (>= 40 chars), hours }  (fresh step-up, Idempotency-Key)
//   POST /api/v1/encounters/closure-overrides/{id}/revoke                                              (fresh step-up)
// The override lifts only the block for that clinician: the note stays open and its alerts and deadline do not change. A grant is held
// here only for the session (there is no list-overrides route yet), so Revoke is offered for the grant just made.
// STEP-UP: a refusal stashes what was typed (in memory only: the reason is free text) and sends the supervisor to /step-up; the board
// reopens this drawer from `?note=` and the form is restored, and nothing is sent for them. IDEMPOTENCY: the grant runs under
// `useAttemptKey`, so a retry of the SAME attempt after a lost reply carries the same key and an edit starts a new one.
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
  type OverdueNote,
  describeRefusal,
  grantOverride,
  revokeOverride,
} from "./closure-api";
import {
  OVERRIDE_DEFAULT_HOURS,
  OVERRIDE_MAX_HOURS,
  OVERRIDE_MIN_HOURS,
  OVERRIDE_MIN_REASON_CHARS,
  STAGE_LABEL,
  STAGE_TONE,
  formatInstant,
  isGrantActive,
  parseOverrideHours,
  reasonLength,
  timingLabel,
} from "./closure-model";
import { ENCOUNTER_TONE, stateLabel } from "./encounter-status";

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

export interface OverrideGrantDrawerProps {
  readonly note: OverdueNote;
  readonly patientName: string;
  readonly clinicianName: string;
  /** The grant made for this clinician in this session, if any (it may have expired or been revoked). */
  readonly grant: ClosureOverrideView | null;
  /** True when the supervisor is genuinely back from /step-up: a stashed draft for this note is restored. */
  readonly resume: boolean;
  readonly onClose: () => void;
  readonly onGranted: (grant: ClosureOverrideView) => void;
  readonly onRevoked: (grant: ClosureOverrideView) => void;
}

export function OverrideGrantDrawer({
  note,
  patientName,
  clinicianName,
  grant,
  resume,
  onClose,
  onGranted,
  onRevoked,
}: OverrideGrantDrawerProps): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  const owner = useStepUpOwner();
  const active = grant !== null && isGrantActive(grant, new Date());
  const close = (): void => {
    clearStepUpDraft(grantDraftKey(owner, note.encounterId)); // closing abandons the draft
    onClose();
  };
  return (
    <aside className="wx-admission-drawer" {...drawer} aria-label={`Override for ${clinicianName}`}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="shield-check" size={20} />
        </span>
        <div>
          <h2>Grant override</h2>
          <div className="wx-row-sub">{clinicianName}</div>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close override panel" onClick={close}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        <NoteFacts note={note} patientName={patientName} clinicianName={clinicianName} />
        {active && grant ? (
          <ActiveGrant grant={grant} clinicianName={clinicianName} onRevoked={onRevoked} />
        ) : (
          <section className="wx-drawer-card">
            <h3>Lift the block for a while</h3>
            {grant?.revokedAt ? (
              <InlineAlert tone="success">
                Override revoked. {clinicianName} is limited again while the note is past its
                deadline.
              </InlineAlert>
            ) : null}
            <p className="wx-row-sub">
              {`${clinicianName} will be able to use the rest of the app for the hours you choose. The note stays open: its alerts and deadline do not change, and this does not replace a late-entry override. Your name and the reason are recorded in the audit trail.`}
            </p>
            <GrantForm note={note} resume={resume} onGranted={onGranted} onCancel={close} />
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
          <span className="wx-nums">{formatInstant(note.deadlineAt)}</span>
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
  clinicianName,
  onRevoked,
}: {
  grant: ClosureOverrideView;
  clinicianName: string;
  onRevoked: (grant: ClosureOverrideView) => void;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
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
    setBusy(false);
    if (outcome.ok) {
      onRevoked(outcome.data);
      return;
    }
    if (outcome.status === 401) {
      navigate("/login");
      return;
    }
    const stepUp = stepUpRedirectFor(outcome.error, `${location.pathname}${location.search}`);
    if (stepUp) {
      navigate(stepUp);
      return;
    }
    setError(describeRefusal(outcome).message);
  };

  return (
    <section className="wx-drawer-card">
      <h3>Override active</h3>
      <InlineAlert tone="success">
        {`${clinicianName} is not blocked until ${formatInstant(grant.expiresAt)}.`}
      </InlineAlert>
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
  onCancel,
}: {
  note: OverdueNote;
  resume: boolean;
  onGranted: (grant: ClosureOverrideView) => void;
  onCancel: () => void;
}): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const owner = useStepUpOwner();
  const draftKey = grantDraftKey(owner, note.encounterId);
  const [fields, setFields] = useState<Fields>(() => {
    const draft = resume ? peekStepUpDraft<unknown>(draftKey) : null;
    return isFields(draft) ? draft : { reason: "", hours: String(OVERRIDE_DEFAULT_HOURS) };
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // One key per attempt, held by the shared useAttemptKey: kept across a retry of the same request while no answer settled it (a thrown
  // fetch, a gateway page, the in-flight 409), renewed on any other answer and when the reason, the hours or the clinician change.
  const attempt = useAttemptKey();

  const edit =
    (name: keyof Fields) =>
    (value: string): void =>
      setFields((previous) => ({ ...previous, [name]: value }));

  const submit = async (): Promise<void> => {
    if (inFlight.current) return;
    const hours = parseOverrideHours(fields.hours);
    const errors: FieldErrors = {
      ...(reasonLength(fields.reason) < OVERRIDE_MIN_REASON_CHARS
        ? {
            reason: `Enter at least ${OVERRIDE_MIN_REASON_CHARS} characters so the audit trail says why.`,
          }
        : {}),
      ...(hours === null
        ? {
            hours: `Enter a whole number of hours from ${OVERRIDE_MIN_HOURS} to ${OVERRIDE_MAX_HOURS}.`,
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
    setBusy(false);
    if (outcome.ok) {
      clearStepUpDraft(draftKey);
      onGranted(outcome.data);
      return;
    }
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
    const reasonError = failure.fieldErrors.reason;
    const hoursError = failure.fieldErrors.hours;
    setFieldErrors({
      ...(reasonError ? { reason: reasonError } : {}),
      ...(hoursError ? { hours: hoursError } : {}),
    });
    setNotice(reasonError || hoursError ? null : (failure.details[0]?.message ?? failure.message));
  };

  const remaining = OVERRIDE_MIN_REASON_CHARS - reasonLength(fields.reason);
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
        value={fields.reason}
        error={fieldErrors.reason}
        hint={`${REASON_HINT_PHI} ${
          remaining > 0
            ? `${remaining} more characters needed (${OVERRIDE_MIN_REASON_CHARS} minimum).`
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
        hint={`${OVERRIDE_MIN_HOURS} to ${OVERRIDE_MAX_HOURS} hours. It ends by itself.`}
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
