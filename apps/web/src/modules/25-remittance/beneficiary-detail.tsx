import { Button, SelectField, StatusPill, TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — one beneficiary-filed appeal in the right rail (milestone 13a). ChartWarden records it;
// it computes no deadline and files nothing. Dates are typed from notices (the recorded-deadline list below); the outcome is
// a label that is never acted on. A stale or refused save keeps what was typed and reloads the record.
import { useId, useState } from "react";
import type { JSX } from "react";
import { BlockedReason, ButtonRow, ErrorAlert, Facts, Hint, PhiNotice } from "./action-ui";
import {
  type BeneficiaryAppeal,
  OUTCOME_LABELS,
  attachBeneficiaryDocument,
  detachBeneficiaryDocument,
  moveBeneficiaryAppeal,
  patchBeneficiaryAppeal,
} from "./beneficiary-api";
import { NO_APPOINTMENT, RECORDS_NOT_FILES, VALIDITY_PASSED } from "./beneficiary-copy";
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

export function BeneficiaryDetail(props: {
  readonly appeal: BeneficiaryAppeal;
  readonly canManage: boolean;
  readonly onChanged: () => void;
}): JSX.Element {
  const { appeal: a } = props;
  const client = useApiClient();
  const reasonId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceNote, setSourceNote] = useState(a.sourceNote);
  const [reference, setReference] = useState(a.externalReference ?? "");
  const [filedOn, setFiledOn] = useState(a.filedOn ?? "");
  const [deciding, setDeciding] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [outcomeNote, setOutcomeNote] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [documentVersionId, setDocumentVersionId] = useState("");
  const editable = props.canManage && !TERMINAL.has(a.state);

  async function run<T>(act: () => Promise<WriteResult<T>>): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await act();
    setBusy(false);
    if (res.ok) {
      props.onChanged();
      return;
    }
    setError(res.message);
    if (res.status === 409) props.onChanged(); // reload; typed values stay
  }

  const saveWhy = sourceNote.trim() === "" ? "Say how the hospice learned of this appeal." : null;
  const docWhy = !isUuid(documentId)
    ? "Enter the document's ID."
    : !isUuid(documentVersionId)
      ? "Enter the version ID of the uploaded copy."
      : null;
  const decideWhy =
    outcome === ""
      ? "Choose the outcome the notice states."
      : outcome === "other" && outcomeNote.trim() === ""
        ? "Describe the outcome when it is 'other'."
        : null;

  return (
    <>
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
        deadlines={a.deadlines as never}
        allowNoticeDocument={false}
        editable={editable}
        onChanged={props.onChanged}
      />

      <section aria-label="Documents">
        <h4 className="wx-action-title">Documents</h4>
        {a.documents.length === 0 ? <Hint>No documents attached.</Hint> : null}
        <ul className="wx-action-hint wx-action-list">
          {a.documents.map((d) => (
            <li key={d.id}>
              Document {d.documentId.slice(0, 8)}… (version pinned, attached{" "}
              {formatDay(d.attachedAt)}){" "}
              {editable ? (
                <Button
                  size="sm"
                  tone="tertiary"
                  aria-label={`Detach document ${d.documentId.slice(0, 8)}`}
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
          <>
            <TextField
              label="Document ID"
              value={documentId}
              onChange={(e) => setDocumentId(e.target.value)}
            />
            <TextField
              label="Version ID of the uploaded copy"
              value={documentVersionId}
              onChange={(e) => setDocumentVersionId(e.target.value)}
            />
            {docWhy ? <BlockedReason id={`${reasonId}-doc`}>{docWhy}</BlockedReason> : null}
            <ButtonRow>
              <Button
                size="sm"
                tone="secondary"
                disabled={busy || docWhy !== null}
                aria-describedby={docWhy ? `${reasonId}-doc` : undefined}
                onClick={() =>
                  void run(() =>
                    attachBeneficiaryDocument(client, a, {
                      documentId: documentId.trim(),
                      documentVersionId: documentVersionId.trim(),
                    }),
                  )
                }
              >
                Attach document
              </Button>
            </ButtonRow>
          </>
        ) : null}
      </section>

      {editable ? (
        <section aria-label="Edit the record">
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
          {saveWhy ? <BlockedReason id={`${reasonId}-save`}>{saveWhy}</BlockedReason> : null}
          <ButtonRow>
            <Button
              size="sm"
              disabled={busy || saveWhy !== null}
              aria-describedby={saveWhy ? `${reasonId}-save` : undefined}
              onClick={() =>
                void run(() =>
                  patchBeneficiaryAppeal(client, a, {
                    sourceNote: sourceNote.trim(),
                    filedOn: filedOn || null,
                    externalReference: reference.trim() || null,
                  }),
                )
              }
            >
              Save changes
            </Button>
          </ButtonRow>

          {deciding ? (
            <>
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
              {decideWhy ? (
                <BlockedReason id={`${reasonId}-decide`}>{decideWhy}</BlockedReason>
              ) : null}
              <ButtonRow>
                <Button
                  size="sm"
                  disabled={busy || decideWhy !== null}
                  aria-describedby={decideWhy ? `${reasonId}-decide` : undefined}
                  onClick={() =>
                    void run(() =>
                      moveBeneficiaryAppeal(client, a, {
                        move: "decide",
                        outcomeLabel: outcome as (typeof OUTCOME_LABELS)[number],
                        ...(outcomeNote.trim() ? { outcomeNote: outcomeNote.trim() } : {}),
                      }),
                    )
                  }
                >
                  Record outcome
                </Button>
                <Button size="sm" tone="tertiary" onClick={() => setDeciding(false)}>
                  Cancel
                </Button>
              </ButtonRow>
            </>
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
                  onClick={() =>
                    void run(() => moveBeneficiaryAppeal(client, a, { move: "close" }))
                  }
                >
                  Close record
                </Button>
              )}
              {a.state !== "decided" ? (
                <Button
                  size="sm"
                  tone="tertiary"
                  disabled={busy}
                  onClick={() =>
                    void run(() => moveBeneficiaryAppeal(client, a, { move: "withdraw" }))
                  }
                >
                  Withdrawn by the beneficiary
                </Button>
              ) : null}
            </ButtonRow>
          )}
        </section>
      ) : null}
      <ErrorAlert message={error} />
    </>
  );
}
