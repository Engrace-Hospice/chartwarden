import { Button, SelectField, StatusPill, TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — one beneficiary-filed appeal in the right rail (milestone 13a). ChartWarden records it;
// it computes no deadline and files nothing. Dates are typed from notices (the recorded-deadline list below); the outcome is
// a label that is never acted on. A stale or refused save keeps what was typed, reloads the record and says so. Closing the
// record or recording that the beneficiary withdrew asks for a confirmation first: neither can be undone.
import { useId, useState } from "react";
import type { FormEvent, JSX } from "react";
import {
  BlockedReason,
  ButtonRow,
  ErrorAlert,
  Facts,
  Hint,
  PhiNotice,
  WarningAlert,
} from "./action-ui";
import {
  type BeneficiaryAppeal,
  OUTCOME_LABELS,
  attachBeneficiaryDocument,
  detachBeneficiaryDocument,
  moveBeneficiaryAppeal,
  patchBeneficiaryAppeal,
} from "./beneficiary-api";
import {
  CHANGED_CUE,
  NO_APPOINTMENT,
  RECORDS_NOT_FILES,
  VALIDITY_PASSED,
} from "./beneficiary-copy";
import { RecordedDeadlines } from "./recorded-deadlines";
import { type WriteResult, isUuid } from "./remittance-api";
import {
  BENEFICIARY_STATE_TONE,
  REPRESENTATIVE_STATUS_TONE,
  formatDay,
  humanize,
  toneOf,
} from "./remittance-status";

const TERMINAL = new Set(["closed", "withdrawn"]);
type Irreversible = "close" | "withdraw";
const CONFIRM_TEXT: Record<Irreversible, string> = {
  close:
    "Close this record? A closed record can no longer be edited and its deadlines stop alerting.",
  withdraw:
    "Record that the beneficiary withdrew this appeal? A withdrawn record can no longer be edited and its deadlines stop alerting.",
};

export function BeneficiaryDetail(props: {
  readonly appeal: BeneficiaryAppeal;
  readonly canManage: boolean;
  readonly onChanged: () => void;
}): JSX.Element {
  const { appeal: a } = props;
  const client = useApiClient();
  const baseId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changedCue, setChangedCue] = useState(false);
  const [sourceNote, setSourceNote] = useState(a.sourceNote);
  const [reference, setReference] = useState(a.externalReference ?? "");
  const [filedOn, setFiledOn] = useState(a.filedOn ?? "");
  const [deciding, setDeciding] = useState(false);
  const [confirming, setConfirming] = useState<Irreversible | null>(null);
  const [outcome, setOutcome] = useState("");
  const [outcomeNote, setOutcomeNote] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [documentVersionId, setDocumentVersionId] = useState("");
  const editable = props.canManage && !TERMINAL.has(a.state);

  async function run<T>(act: () => Promise<WriteResult<T>>): Promise<boolean> {
    setBusy(true);
    setError(null);
    setChangedCue(false);
    const res = await act();
    setBusy(false);
    if (res.ok) {
      props.onChanged();
      return true;
    }
    setError(res.message);
    if (res.status === 409) {
      setChangedCue(true);
      props.onChanged(); // reload; typed values stay
    }
    return false;
  }
  const submit = (fn: () => void) => (e: FormEvent) => {
    e.preventDefault();
    fn();
  };
  const id = (suffix: string) => `${baseId}-${suffix}`;

  const saveWhy = sourceNote.trim() === "" ? "Say how the hospice learned of this appeal." : null;
  const docIdBad = documentId.trim() !== "" && !isUuid(documentId);
  const docVersionBad = documentVersionId.trim() !== "" && !isUuid(documentVersionId);
  const docWhy = !isUuid(documentId)
    ? "Enter the document's ID (a UUID)."
    : !isUuid(documentVersionId)
      ? "Enter the version ID of the uploaded copy (a UUID)."
      : null;
  const decideWhy =
    outcome === ""
      ? "Choose the outcome the notice states."
      : outcome === "other" && outcomeNote.trim() === ""
        ? "Describe the outcome when it is 'other'."
        : null;

  return (
    <>
      <ErrorAlert message={error} />
      {changedCue ? <WarningAlert>{CHANGED_CUE}</WarningAlert> : null}
      <h3 className="wx-action-title">
        Beneficiary appeal - {humanize(a.tierLabel)}{" "}
        <StatusPill label={humanize(a.state)} tone={toneOf(BENEFICIARY_STATE_TONE, a.state)} />
      </h3>
      <Hint>{RECORDS_NOT_FILES}</Hint>
      <Facts
        items={[
          ["Filed by", humanize(a.filerKind)],
          ["Filed on", a.filedOn ? formatDay(a.filedOn) : "Not recorded"],
          ["Reference", a.externalReference ?? "—"],
          ["How we learned of it", a.sourceNote],
          ["Outcome (label)", a.outcomeLabel ? humanize(a.outcomeLabel) : "—"],
        ]}
      />
      {a.filerKind === "representative" ? (
        a.representativeStatus === "none_on_file" || !a.appointment ? (
          <output className="wx-action-hint is-alert">{NO_APPOINTMENT}</output>
        ) : (
          <p className="wx-action-hint">
            <strong>Representative:</strong>{" "}
            <StatusPill
              label={humanize(a.representativeStatus)}
              tone={toneOf(REPRESENTATIVE_STATUS_TONE, a.representativeStatus ?? "")}
            />{" "}
            {a.representativeStatus === "validity_end_passed_as_recorded" ? VALIDITY_PASSED : null}
          </p>
        )
      ) : null}
      {/* RecordedDeadlines below states "No due date recorded - enter it from the notice" when there is none. */}
      <RecordedDeadlines
        subject={{ kind: "beneficiary_appeal", id: a.id }}
        deadlines={a.deadlines}
        allowNoticeDocument={false}
        editable={editable}
        onChanged={props.onChanged}
      />

      <section aria-labelledby={id("docs-h")}>
        <h4 className="wx-action-title" id={id("docs-h")}>
          Documents
        </h4>
        {a.documents.length === 0 ? <Hint>No documents attached.</Hint> : null}
        <ul className="wx-action-hint wx-action-list">
          {a.documents.map((d, n) => (
            <li key={d.id}>
              Attached document {n + 1} (id {d.documentId.slice(0, 8)}…, version pinned, attached{" "}
              {formatDay(d.attachedAt)}){" "}
              {editable ? (
                <Button
                  size="sm"
                  tone="tertiary"
                  aria-label={`Detach attached document ${n + 1}`}
                  disabled={busy}
                  onClick={() => void run(() => detachBeneficiaryDocument(client, a, d.documentId))}
                >
                  Detach
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {editable ? (
          <form
            aria-label="Attach a document"
            onSubmit={submit(() => {
              if (docWhy !== null || busy) return;
              void run(() =>
                attachBeneficiaryDocument(client, a, {
                  documentId: documentId.trim(),
                  documentVersionId: documentVersionId.trim(),
                }),
              ).then((okay) => {
                if (okay) {
                  setDocumentId("");
                  setDocumentVersionId("");
                }
              });
            })}
          >
            <TextField
              label="Document ID"
              value={documentId}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDocumentId(e.target.value)}
              error={docIdBad ? "Enter the document's UUID." : undefined}
            />
            <TextField
              label="Version ID of the uploaded copy"
              value={documentVersionId}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDocumentVersionId(e.target.value)}
              error={docVersionBad ? "Enter the version's UUID." : undefined}
            />
            {docWhy ? <BlockedReason id={id("doc")}>{docWhy}</BlockedReason> : null}
            <ButtonRow>
              <Button
                size="sm"
                tone="secondary"
                type="submit"
                disabled={busy || docWhy !== null}
                aria-describedby={docWhy ? id("doc") : undefined}
              >
                Attach document
              </Button>
            </ButtonRow>
          </form>
        ) : null}
      </section>

      {editable ? (
        <>
          <form
            aria-labelledby={id("edit-h")}
            onSubmit={submit(() => {
              if (saveWhy !== null || busy) return;
              void run(() =>
                patchBeneficiaryAppeal(client, a, {
                  sourceNote: sourceNote.trim(),
                  filedOn: filedOn || null,
                  externalReference: reference.trim() || null,
                }),
              );
            })}
          >
            <h4 className="wx-action-title" id={id("edit-h")}>
              Edit the record
            </h4>
            <TextField
              label="Filed on (if known)"
              type="date"
              value={filedOn}
              onChange={(e) => setFiledOn(e.target.value)}
            />
            <TextField
              label="Reference (as printed)"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={200}
            />
            <TextField
              label="How the hospice learned of it"
              value={sourceNote}
              onChange={(e) => setSourceNote(e.target.value)}
              maxLength={1000}
            />
            <PhiNotice />
            {saveWhy ? <BlockedReason id={id("save")}>{saveWhy}</BlockedReason> : null}
            <ButtonRow>
              <Button
                size="sm"
                type="submit"
                disabled={busy || saveWhy !== null}
                aria-describedby={saveWhy ? id("save") : undefined}
              >
                Save changes
              </Button>
            </ButtonRow>
          </form>

          {deciding ? (
            <form
              aria-labelledby={id("decide-h")}
              onSubmit={submit(() => {
                if (decideWhy !== null || busy) return;
                void run(() =>
                  moveBeneficiaryAppeal(client, a, {
                    move: "decide",
                    outcomeLabel: outcome as (typeof OUTCOME_LABELS)[number],
                    ...(outcomeNote.trim() ? { outcomeNote: outcomeNote.trim() } : {}),
                  }),
                ).then((okay) => {
                  if (okay) setDeciding(false);
                });
              })}
            >
              <h4 className="wx-action-title" id={id("decide-h")}>
                Record the outcome
              </h4>
              <SelectField
                label="Outcome the notice states (a label only)"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
                options={[
                  { value: "", label: "Choose..." },
                  ...OUTCOME_LABELS.map((o) => ({ value: o, label: humanize(o) })),
                ]}
              />
              <TextField
                label="Outcome note"
                value={outcomeNote}
                onChange={(e) => setOutcomeNote(e.target.value)}
                maxLength={1000}
              />
              {decideWhy ? <BlockedReason id={id("decide")}>{decideWhy}</BlockedReason> : null}
              <ButtonRow>
                <Button
                  size="sm"
                  type="submit"
                  disabled={busy || decideWhy !== null}
                  aria-describedby={decideWhy ? id("decide") : undefined}
                >
                  Record outcome
                </Button>
                <Button size="sm" tone="tertiary" onClick={() => setDeciding(false)}>
                  Cancel
                </Button>
              </ButtonRow>
            </form>
          ) : confirming ? (
            <section
              role="alertdialog"
              aria-labelledby={id("confirm-h")}
              aria-describedby={id("confirm-t")}
            >
              <h4 className="wx-action-title" id={id("confirm-h")}>
                Please confirm
              </h4>
              <p className="wx-action-hint" id={id("confirm-t")}>
                {CONFIRM_TEXT[confirming]}
              </p>
              <ButtonRow>
                <Button
                  size="sm"
                  tone="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(() => moveBeneficiaryAppeal(client, a, { move: confirming })).then(
                      () => setConfirming(null),
                    )
                  }
                >
                  {confirming === "close" ? "Yes, close the record" : "Yes, record the withdrawal"}
                </Button>
                <Button size="sm" tone="tertiary" onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
              </ButtonRow>
            </section>
          ) : (
            <ButtonRow>
              {a.state === "recorded" ? (
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(() => moveBeneficiaryAppeal(client, a, { move: "support" }))
                  }
                >
                  Mark as supporting
                </Button>
              ) : null}
              {a.state !== "decided" ? (
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={busy}
                  onClick={() => setDeciding(true)}
                >
                  Record outcome
                </Button>
              ) : (
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={busy}
                  onClick={() => setConfirming("close")}
                >
                  Close record
                </Button>
              )}
              {a.state !== "decided" ? (
                <Button
                  size="sm"
                  tone="tertiary"
                  disabled={busy}
                  onClick={() => setConfirming("withdraw")}
                >
                  Withdrawn by the beneficiary
                </Button>
              ) : null}
            </ButtonRow>
          )}
        </>
      ) : null}
    </>
  );
}
