import {
  Button,
  LoadingSpinner,
  SelectField,
  StatusPill,
  TextField,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the PAYER APPEAL section of the denial rail (milestone 12a-1): a commercial (or
// Medicare Advantage plan) payer's own appeal levels, one chain per denial, shown beside the Medicare work and never in
// place of it. Nothing is built in: the levels come from the path YOUR organization recorded from its contract (a payer
// with none reads "No appeal path recorded for this payer" and links to where to add it), a deadline is computed only
// from a complete VERIFIED path row and the notice date you typed (a draft path reads "awaiting verification" and computes
// nothing), and a level with no due date says so loudly. Nothing is filed or sent from here: you record what you did.
// The server owns every rule and its refusal is shown verbatim (ADR-0030). A failed refresh keeps the last good data on
// screen with a Retry; a conflict reloads and keeps what you typed.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, JSX, ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  BlockedReason,
  ButtonRow,
  ErrorAlert,
  Facts,
  Hint,
  NoticeAlert,
  RetryAlert,
  WarningAlert,
} from "./action-ui";
import {
  LEVEL_KINDS,
  type PayerAppealCase,
  type PayerAppealDenialView,
  loadPayerAppeals,
  movePayerAppeal,
  openPayerAppeal,
  recordPayerNotice,
} from "./payer-appeal-api";
import { RecordedDeadlines } from "./recorded-deadlines";
import { APPEAL_STATE_TONE, formatDay, humanize, toneOf } from "./remittance-status";
import { useGuardedLoad } from "./use-guarded-load";

export const MA_HINT =
  "This patient has Medicare Advantage coverage. Hospice for Medicare Advantage enrollees is generally paid by Original Medicare through the MAC, so check that this denial belongs to a plan before using a plan appeal path. This is not legal advice.";
const TERMINAL = new Set(["closed", "withdrawn"]);
const IN_FLIGHT = new Set(["draft", "submitted", "under_review"]);

type Reload = () => Promise<void>;

export interface PayerAppealPanelProps {
  readonly denialId: string;
  /** Holds payer_appeal.manage: may open and move levels. */
  readonly canManage: boolean;
  /** Holds payer_appeal_path.manage: gets the link to add a missing path. */
  readonly canManagePaths: boolean;
  /** Changes when something on this denial was written elsewhere: the panel reads again. */
  readonly refreshKey?: string | number;
  /** Called after this panel changed something and re-read it (the parent refreshes its own sections). */
  readonly onChanged?: () => void;
}

function DeadlineLine({ c }: { readonly c: PayerAppealCase }): JSX.Element | null {
  if (c.deadlineAt) {
    return (
      <p className="wx-action-hint">
        <strong>Filing deadline:</strong> {formatDay(c.deadlineAt)} (computed from your path
        {c.derivation ? `; last filing day ${formatDay(c.derivation.lastFilingDay)}` : ""}){" "}
        {c.windowVerified ? null : <StatusPill label="Window not verified" tone="warning" />}
      </p>
    );
  }
  return c.prompt ? <output className="wx-action-hint is-alert">{c.prompt}</output> : null;
}

/** A small inline form: Enter submits, a disabled submit says why. */
function InlineForm(props: {
  readonly label: string;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly blockedReason: string | null;
  readonly onSubmit: () => void;
  readonly onCancel?: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  const reasonId = useId();
  const blocked = props.blockedReason !== null;
  function submit(e: FormEvent): void {
    e.preventDefault();
    if (!blocked && !props.busy) props.onSubmit();
  }
  return (
    <form aria-label={props.label} onSubmit={submit} noValidate>
      {props.children}
      {blocked ? <BlockedReason id={reasonId}>{props.blockedReason}</BlockedReason> : null}
      <ButtonRow>
        <Button
          type="submit"
          size="sm"
          disabled={props.busy || blocked}
          aria-describedby={blocked ? reasonId : undefined}
        >
          {props.busy ? "Working…" : props.submitLabel}
        </Button>
        {props.onCancel ? (
          <Button size="sm" tone="tertiary" disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
      </ButtonRow>
    </form>
  );
}

function CaseCard(props: {
  readonly c: PayerAppealCase;
  readonly canManage: boolean;
  /** Re-reads the panel and resolves once the new data is on screen. */
  readonly reload: Reload;
  readonly onWrite: () => void;
}): JSX.Element {
  const { c } = props;
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noticeDate, setNoticeDate] = useState("");
  const [payerReference, setPayerReference] = useState(c.payerReference ?? "");
  const [reviewer, setReviewer] = useState(c.externalReviewerName ?? "");
  const [outcome, setOutcome] = useState("");
  const [dispositionKind, setDispositionKind] = useState("");
  const [dispositionNote, setDispositionNote] = useState("");
  const [deciding, setDeciding] = useState(false);
  const mounted = useRef(true);
  const editable = props.canManage && !TERMINAL.has(c.state);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The case changed state: a half-filled decision no longer describes it. A reload after a conflict that left the state
  // alone keeps what was typed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: state is the explicit reset trigger
  useEffect(() => {
    setDeciding(false);
    setOutcome("");
    setDispositionKind("");
    setDispositionNote("");
  }, [c.state]);

  /** Runs one write; on a conflict the panel reloads (typed values stay) and the server's message is shown. */
  async function run(
    write: () => Promise<{ ok: true } | { ok: false; message: string; status: number | null }>,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    props.onWrite();
    const res = await write();
    if (res.ok || res.status === 409) await props.reload();
    if (!mounted.current) return;
    setBusy(false);
    if (!res.ok) setError(res.message);
  }

  const move = (kind: "submit" | "begin_review" | "decide" | "close" | "withdraw"): Promise<void> =>
    run(() =>
      movePayerAppeal(client, c, {
        move: kind,
        ...(payerReference.trim() ? { payerReference: payerReference.trim() } : {}),
        ...(reviewer.trim() ? { externalReviewerName: reviewer.trim() } : {}),
        ...(kind === "decide"
          ? {
              outcome: outcome as "favorable" | "partial" | "unfavorable",
              ...(dispositionKind
                ? {
                    dispositionKind: dispositionKind as
                      | "decision"
                      | "remand"
                      | "dismissal"
                      | "other",
                    ...(dispositionNote.trim() ? { dispositionNote: dispositionNote.trim() } : {}),
                  }
                : {}),
            }
          : {}),
      }),
    );

  const saveNotice = (): Promise<void> =>
    run(async () => {
      const res = await recordPayerNotice(client, c, noticeDate);
      if (res.ok) setNoticeDate("");
      return res;
    });

  const decisionBlocked =
    outcome === ""
      ? "Choose the outcome."
      : dispositionKind === "other" && !dispositionNote.trim()
        ? "Describe the disposition when it is 'other'."
        : null;

  return (
    <section aria-label={`Payer appeal level ${c.levelLabel}`}>
      <h4 className="wx-action-title">
        {c.levelLabel}{" "}
        <StatusPill label={humanize(c.state)} tone={toneOf(APPEAL_STATE_TONE, c.state)} />{" "}
        {c.levelKind === "external_review" ? (
          <StatusPill label="External review" tone="progress" />
        ) : null}
      </h4>
      <Facts
        items={[
          ["Program", humanize(c.program)],
          ["Notice date", c.noticeDatedOn ? formatDay(c.noticeDatedOn) : "Not entered"],
          ["Payer reference", c.payerReference ?? "—"],
          ...(c.levelKind === "external_review"
            ? ([["Reviewer", c.externalReviewerName ?? "—"]] as const)
            : []),
          ["Decision", c.decisionOutcome ? humanize(c.decisionOutcome) : "—"],
        ]}
      />
      <DeadlineLine c={c} />
      {c.pathAwaitingVerification ? (
        <Hint>
          This level was opened under a draft path, so no window was taken from it. Once the path is
          verified, withdraw this level and open it again to pick the window up.
        </Hint>
      ) : null}
      {c.decisionOverdue ? (
        <WarningAlert>
          The decision days recorded on your path have passed since this level was submitted.
        </WarningAlert>
      ) : null}
      {c.needsManualReview ? (
        <WarningAlert>
          Disposition: {humanize(c.dispositionKind)}. A person must look at this; no next level was
          opened.
        </WarningAlert>
      ) : null}
      {editable && c.state === "draft" && c.deadlineSource === "none" ? (
        <InlineForm
          label="Record the notice date"
          submitLabel="Save notice date"
          busy={busy}
          blockedReason={noticeDate === "" ? "Enter the date printed on the notice." : null}
          onSubmit={() => void saveNotice()}
        >
          <TextField
            label="Notice date (printed on the notice)"
            type="date"
            required
            value={noticeDate}
            onChange={(e) => setNoticeDate(e.target.value)}
          />
        </InlineForm>
      ) : null}
      <RecordedDeadlines
        subject={{ kind: "payer_appeal", id: c.id }}
        deadlines={c.deadlines}
        allowNoticeDocument={false}
        editable={editable}
        onChanged={() => void props.reload()}
      />
      {editable ? (
        <>
          <TextField
            label="Payer reference (optional)"
            value={payerReference}
            onChange={(e) => setPayerReference(e.target.value)}
            maxLength={200}
          />
          {c.levelKind === "external_review" ? (
            <TextField
              label="Reviewer name (as the notice states it)"
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
              maxLength={200}
            />
          ) : null}
          {deciding ? (
            <InlineForm
              label="Record the decision"
              submitLabel="Record decision"
              busy={busy}
              blockedReason={decisionBlocked}
              onSubmit={() => void move("decide")}
              onCancel={() => setDeciding(false)}
            >
              <SelectField
                label="Outcome"
                required
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
                options={[
                  { value: "", label: "Choose..." },
                  { value: "favorable", label: "Favorable" },
                  { value: "partial", label: "Partial" },
                  { value: "unfavorable", label: "Unfavorable" },
                ]}
              />
              <SelectField
                label="Disposition (optional label)"
                value={dispositionKind}
                onChange={(e) => setDispositionKind(e.target.value)}
                options={[
                  { value: "", label: "None" },
                  { value: "decision", label: "Decision" },
                  { value: "remand", label: "Remand" },
                  { value: "dismissal", label: "Dismissal" },
                  { value: "other", label: "Other" },
                ]}
              />
              {dispositionKind ? (
                <TextField
                  label="Disposition note"
                  required={dispositionKind === "other"}
                  value={dispositionNote}
                  onChange={(e) => setDispositionNote(e.target.value)}
                  maxLength={500}
                />
              ) : null}
            </InlineForm>
          ) : (
            <ButtonRow>
              {c.state === "draft" ? (
                <Button size="sm" disabled={busy} onClick={() => void move("submit")}>
                  Record as submitted
                </Button>
              ) : null}
              {c.state === "submitted" ? (
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={busy}
                  onClick={() => void move("begin_review")}
                >
                  Mark under review
                </Button>
              ) : null}
              {c.state === "under_review" ? (
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={busy}
                  onClick={() => setDeciding(true)}
                >
                  Record decision
                </Button>
              ) : null}
              {c.state === "decided" ? (
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={busy}
                  onClick={() => void move("close")}
                >
                  Close level
                </Button>
              ) : null}
              {c.state !== "decided" ? (
                <Button
                  size="sm"
                  tone="tertiary"
                  disabled={busy}
                  onClick={() => void move("withdraw")}
                >
                  Withdraw
                </Button>
              ) : null}
            </ButtonRow>
          )}
          <Hint>Nothing is sent from here: record what you filed with the payer.</Hint>
        </>
      ) : null}
      <ErrorAlert message={error} />
    </section>
  );
}

function OpenForm(props: {
  readonly view: PayerAppealDenialView;
  readonly denialId: string;
  readonly priorId: string | undefined;
  readonly reload: Reload;
  readonly onOpened: () => void;
}): JSX.Element {
  const { view } = props;
  const client = useApiClient();
  const levels = view.path?.levels ?? [];
  const [chosenOrdinal, setOrdinal] = useState("");
  // The chosen level survives a reload that changes the path; one no longer on the path falls back to the first.
  const ordinal = levels.some((l) => String(l.ordinal) === chosenOrdinal)
    ? chosenOrdinal
    : String(levels[0]?.ordinal ?? "");
  const [levelLabel, setLevelLabel] = useState("");
  const [levelKind, setLevelKind] = useState("internal");
  const [noticeDate, setNoticeDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const named = levels.length === 0;

  async function open(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await openPayerAppeal(client, props.denialId, {
      ...(named
        ? {
            levelLabel: levelLabel.trim(),
            levelKind: levelKind as "internal" | "external_review" | "other",
          }
        : { levelOrdinal: Number(ordinal) }),
      ...(noticeDate ? { noticeDate } : {}),
      ...(props.priorId ? { priorLevelCaseId: props.priorId } : {}),
    });
    // A conflict (the denial or path moved under us) reloads and keeps what was typed; success reloads and closes the form.
    if (res.ok || res.status === 409) await props.reload();
    // The form is replaced once the new level lands (its key changes), so the notice is raised before the mounted check.
    if (res.ok) props.onOpened();
    if (!mounted.current) return;
    setBusy(false);
    if (!res.ok) setError(res.message);
  }

  const blockedReason = named
    ? levelLabel.trim() === ""
      ? "Name the level you are filing."
      : null
    : ordinal === ""
      ? "Choose the level."
      : null;

  return (
    <section aria-label="Open a payer appeal level">
      <h4 className="wx-action-title">Open a payer appeal level</h4>
      <InlineForm
        label="Open a payer appeal level"
        submitLabel="Open level"
        busy={busy}
        blockedReason={blockedReason}
        onSubmit={() => void open()}
      >
        {named ? (
          <TextField
            label="Level (as the payer's notice names it)"
            required
            value={levelLabel}
            onChange={(e) => setLevelLabel(e.target.value)}
            maxLength={120}
          />
        ) : (
          <SelectField
            label="Level"
            required
            value={ordinal}
            onChange={(e) => setOrdinal(e.target.value)}
            options={levels.map((l) => ({
              value: String(l.ordinal),
              label: `${l.ordinal}. ${l.levelLabel}`,
            }))}
          />
        )}
        {named ? (
          <SelectField
            label="Kind"
            value={levelKind}
            onChange={(e) => setLevelKind(e.target.value)}
            options={LEVEL_KINDS.map((k) => ({ value: k, label: humanize(k) }))}
          />
        ) : null}
        <TextField
          label="Notice date (printed on the notice this level's clock runs from)"
          type="date"
          value={noticeDate}
          onChange={(e) => setNoticeDate(e.target.value)}
        />
        <Hint>
          Without a notice date, or a complete window on a verified path, no due date is computed.
        </Hint>
      </InlineForm>
      <ErrorAlert message={error} />
    </section>
  );
}

export function PayerAppealPanel(props: PayerAppealPanelProps): JSX.Element | null {
  const client = useApiClient();
  const fetcher = useCallback(
    () => loadPayerAppeals(client, props.denialId),
    [client, props.denialId],
  );
  const { data: view, error, load } = useGuardedLoad(fetcher);
  const [notice, setNotice] = useState<string | null>(null);
  const [clearedFor, setClearedFor] = useState(props.denialId);
  const firstRender = useRef(true);
  const ownBump = useRef(false);

  // Another denial: nothing typed or noticed for the last one carries over.
  if (clearedFor !== props.denialId) {
    setClearedFor(props.denialId);
    setNotice(null);
  }

  // A refreshKey bump from the parent re-reads, except the bump this panel itself caused (it already re-read).
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the explicit "read again" trigger
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (ownBump.current) {
      ownBump.current = false;
      return;
    }
    void load();
  }, [props.refreshKey]);

  const reload: Reload = useCallback(async () => {
    await load();
    if (props.onChanged) {
      ownBump.current = true;
      props.onChanged();
    }
  }, [load, props.onChanged]);

  if (!view) {
    return error ? (
      <RetryAlert message={`Payer appeals unavailable: ${error}`} onRetry={() => void load()} />
    ) : (
      <LoadingSpinner />
    );
  }
  // A Medicare, Medicaid or advice-less denial has no payer appeal; its own work is elsewhere on this rail.
  if (view.refusal !== null && view.cases.length === 0) return null;

  const inFlight = view.cases.some((c) => IN_FLIGHT.has(c.state));
  const last = view.cases[view.cases.length - 1];
  return (
    <section aria-label="Payer appeal">
      <h3 className="wx-action-title">Payer appeal</h3>
      {error ? (
        <RetryAlert
          message={`Payer appeals could not be refreshed: ${error}`}
          onRetry={() => void load()}
        />
      ) : null}
      <Facts
        items={[
          ["Payer", view.payerName ?? "Payer not resolved"],
          ["Payer type", view.payerKind ? humanize(view.payerKind) : "Not resolved"],
        ]}
      />
      {view.maHint ? <WarningAlert>{MA_HINT}</WarningAlert> : null}
      <NoticeAlert message={notice} />
      {view.path ? (
        <section aria-label="Recorded appeal path">
          <p className="wx-action-hint">
            <strong>Appeal path (revision {view.path.revision}):</strong>{" "}
            {view.path.verified ? (
              <StatusPill label="Verified" tone="success" />
            ) : (
              <StatusPill label="Draft - not verified" tone="warning" />
            )}
          </p>
          <ol className="wx-action-hint wx-action-list">
            {view.path.levels.map((l) => (
              <li key={l.ordinal}>
                {l.levelLabel} · {humanize(l.levelKind)} · files: {humanize(l.whoFiles)}
                {l.windowComplete ? "" : " · no filing window recorded"}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {view.pathPrompt ? (
        <WarningAlert>
          {view.pathPrompt}
          {view.path === null && !view.payerUnresolved && props.canManagePaths ? (
            <>
              {". "}
              <Link to="/remittance/payer-appeal-paths">Add a path</Link>
            </>
          ) : null}
        </WarningAlert>
      ) : null}
      {view.cases.map((c) => (
        <CaseCard
          key={c.id}
          c={c}
          canManage={props.canManage}
          reload={reload}
          onWrite={() => setNotice(null)}
        />
      ))}
      {props.canManage && view.refusal === null && !view.payerUnresolved && !inFlight ? (
        <OpenForm
          key={view.cases.length}
          view={view}
          denialId={props.denialId}
          priorId={
            last && (last.state === "decided" || last.state === "closed") ? last.id : undefined
          }
          reload={reload}
          onOpened={() => setNotice("Payer appeal level opened.")}
        />
      ) : null}
    </section>
  );
}
