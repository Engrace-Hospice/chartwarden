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
// from a complete path row and the notice date you typed (badged "Window not verified" until a second person verified
// the path), and a level with no due date says so loudly. Nothing is filed or sent from here: you record what you did.
// The server owns every rule and its refusal is shown verbatim (ADR-0030).
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { ButtonRow, ErrorAlert, Facts, Hint, NoticeAlert, WarningAlert } from "./action-ui";
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

export const MA_HINT =
  "This patient has Medicare Advantage coverage. Hospice for Medicare Advantage enrollees is generally paid by Original Medicare through the MAC, so check that this denial belongs to a plan before using a plan appeal path. This is not legal advice.";
const TERMINAL = new Set(["closed", "withdrawn"]);

export interface PayerAppealPanelProps {
  readonly denialId: string;
  /** Holds payer_appeal.manage: may open and move levels. */
  readonly canManage: boolean;
  /** Holds payer_appeal_path.manage: gets the link to add a missing path. */
  readonly canManagePaths: boolean;
  readonly refreshKey?: string | number;
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

function CaseCard(props: {
  readonly c: PayerAppealCase;
  readonly canManage: boolean;
  readonly onChanged: () => void;
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
  const editable = props.canManage && !TERMINAL.has(c.state);

  async function move(
    move: "submit" | "begin_review" | "decide" | "close" | "withdraw",
  ): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await movePayerAppeal(client, c, {
      move,
      ...(payerReference.trim() ? { payerReference: payerReference.trim() } : {}),
      ...(reviewer.trim() ? { externalReviewerName: reviewer.trim() } : {}),
      ...(move === "decide"
        ? {
            outcome: outcome as "favorable" | "partial" | "unfavorable",
            ...(dispositionKind
              ? {
                  dispositionKind: dispositionKind as "decision" | "remand" | "dismissal" | "other",
                  ...(dispositionNote.trim() ? { dispositionNote: dispositionNote.trim() } : {}),
                }
              : {}),
          }
        : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      if (res.status === 409) props.onChanged();
      return;
    }
    setDeciding(false);
    props.onChanged();
  }

  async function saveNotice(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await recordPayerNotice(client, c, noticeDate);
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      if (res.status === 409) props.onChanged();
      return;
    }
    setNoticeDate("");
    props.onChanged();
  }

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
        <ButtonRow>
          <TextField
            label="Notice date (printed on the notice)"
            type="date"
            value={noticeDate}
            onChange={(e) => setNoticeDate(e.target.value)}
          />
          <Button
            size="sm"
            tone="secondary"
            disabled={busy || noticeDate === ""}
            onClick={() => void saveNotice()}
          >
            Save notice date
          </Button>
        </ButtonRow>
      ) : null}
      <RecordedDeadlines
        subject={{ kind: "payer_appeal", id: c.id }}
        deadlines={c.deadlines as never}
        allowNoticeDocument={false}
        editable={editable}
        onChanged={props.onChanged}
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
            <>
              <SelectField
                label="Outcome"
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
                  value={dispositionNote}
                  onChange={(e) => setDispositionNote(e.target.value)}
                  maxLength={500}
                />
              ) : null}
              <ButtonRow>
                <Button
                  size="sm"
                  disabled={
                    busy ||
                    outcome === "" ||
                    (dispositionKind === "other" && !dispositionNote.trim())
                  }
                  onClick={() => void move("decide")}
                >
                  Record decision
                </Button>
                <Button size="sm" tone="tertiary" onClick={() => setDeciding(false)}>
                  Cancel
                </Button>
              </ButtonRow>
            </>
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
  readonly onOpened: () => void;
}): JSX.Element {
  const { view } = props;
  const client = useApiClient();
  const levels = view.path?.levels ?? [];
  const [ordinal, setOrdinal] = useState(levels.length > 0 ? String(levels[0]?.ordinal ?? "") : "");
  const [levelLabel, setLevelLabel] = useState("");
  const [levelKind, setLevelKind] = useState("internal");
  const [noticeDate, setNoticeDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setBusy(false);
    if (!res.ok) setError(res.message);
    else props.onOpened();
  }

  return (
    <section aria-label="Open a payer appeal level">
      <h4 className="wx-action-title">Open a payer appeal level</h4>
      {named ? (
        <>
          <TextField
            label="Level (as the payer's notice names it)"
            value={levelLabel}
            onChange={(e) => setLevelLabel(e.target.value)}
            maxLength={120}
          />
          <SelectField
            label="Kind"
            value={levelKind}
            onChange={(e) => setLevelKind(e.target.value)}
            options={LEVEL_KINDS.map((k) => ({ value: k, label: humanize(k) }))}
          />
        </>
      ) : (
        <SelectField
          label="Level"
          value={ordinal}
          onChange={(e) => setOrdinal(e.target.value)}
          options={levels.map((l) => ({
            value: String(l.ordinal),
            label: `${l.ordinal}. ${l.levelLabel}`,
          }))}
        />
      )}
      <TextField
        label="Notice date (printed on the notice this level's clock runs from)"
        type="date"
        value={noticeDate}
        onChange={(e) => setNoticeDate(e.target.value)}
      />
      <Hint>Without a notice date, or a complete window on the path, no due date is computed.</Hint>
      <ErrorAlert message={error} />
      <ButtonRow>
        <Button
          size="sm"
          disabled={busy || (named ? levelLabel.trim() === "" : ordinal === "")}
          onClick={() => void open()}
        >
          {busy ? "Working…" : "Open level"}
        </Button>
      </ButtonRow>
    </section>
  );
}

export function PayerAppealPanel(props: PayerAppealPanelProps): JSX.Element | null {
  const client = useApiClient();
  const [view, setView] = useState<PayerAppealDenialView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    latest.current += 1;
    const seq = latest.current;
    const res = await loadPayerAppeals(client, props.denialId);
    if (seq !== latest.current) return;
    if (res.ok) {
      setView(res.value);
      setError(null);
    } else setError(res.message);
  }, [client, props.denialId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the explicit "read again" trigger
  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load, props.refreshKey]);

  const changed = (): void => {
    void load();
    props.onChanged?.();
  };

  if (!view) {
    return error ? (
      <ErrorAlert message={`Payer appeals unavailable: ${error}`} />
    ) : (
      <LoadingSpinner />
    );
  }
  // A Medicare, Medicaid or advice-less denial has no payer appeal; its own work is elsewhere on this rail.
  if (view.refusal !== null && view.cases.length === 0) return null;

  const inFlight = view.cases.some((c) => ["draft", "submitted", "under_review"].includes(c.state));
  const last = view.cases[view.cases.length - 1];
  return (
    <section aria-label="Payer appeal">
      <h3 className="wx-action-title">Payer appeal</h3>
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
      ) : view.pathPrompt ? (
        <WarningAlert>
          {view.pathPrompt}.{" "}
          {props.canManagePaths ? (
            <Link to="/remittance/payer-appeal-paths">Add a path</Link>
          ) : null}
        </WarningAlert>
      ) : null}
      {view.cases.map((c) => (
        <CaseCard key={c.id} c={c} canManage={props.canManage} onChanged={changed} />
      ))}
      {props.canManage && view.refusal === null && !inFlight ? (
        <OpenForm
          key={view.cases.length}
          view={view}
          denialId={props.denialId}
          priorId={
            last && (last.state === "decided" || last.state === "closed") ? last.id : undefined
          }
          onOpened={() => {
            setNotice("Payer appeal level opened.");
            changed();
          }}
        />
      ) : null}
    </section>
  );
}
