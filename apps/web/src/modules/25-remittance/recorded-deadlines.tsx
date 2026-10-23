import { Button, StatusPill, TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — recorded deadlines (milestone 7a-1), shared by the later-tier panel and the
// audit detail. A recorded deadline is a date the user typed from a notice, with the source note that says which
// notice. The app computes nothing and applies no default: no deadline recorded reads as exactly that, loudly.
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ActionModal, ButtonRow, ErrorAlert, FormButtons, Hint, PhiNotice } from "./action-ui";
import {
  type DeadlineSubject,
  type RecordedDeadlineView,
  addRecordedDeadline,
  editRecordedDeadline,
  isConflict,
  satisfyRecordedDeadline,
} from "./audit-api";
import { isUuid } from "./remittance-api";
import { RECORDED_DEADLINE_TONE, formatDay, humanize, toneOf } from "./remittance-status";

export const NOT_COMPUTED = "From your notice, not a computed CMS date.";
export const NO_DUE_DATE = "No due date recorded - enter it from the notice";

export function NoDueDateAlert(): JSX.Element {
  return <output className="wx-action-hint is-alert">{NO_DUE_DATE}</output>;
}

export interface RecordedDeadlinesProps {
  readonly subject: DeadlineSubject;
  readonly deadlines: readonly RecordedDeadlineView[];
  /** Only appeals accept a notice document id (an audit request refuses one). */
  readonly allowNoticeDocument: boolean;
  /** False for a terminal case: the list stays readable but nothing can be added or changed. */
  readonly editable: boolean;
  readonly onChanged: () => void;
}

type Editing = { readonly deadline: RecordedDeadlineView | null } | null;

export function RecordedDeadlines(props: RecordedDeadlinesProps): JSX.Element {
  const client = useApiClient();
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const [satisfyingId, setSatisfyingId] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function satisfy(d: RecordedDeadlineView): Promise<void> {
    if (satisfyingId) return;
    setError(null);
    setSatisfyingId(d.id);
    const res = await satisfyRecordedDeadline(client, props.subject, d);
    if (!mounted.current) return;
    setSatisfyingId(null);
    if (!res.ok) {
      setError(res.message);
      // The deadline moved under us: reload so the next attempt carries the new version.
      if (isConflict(res)) props.onChanged();
    } else props.onChanged();
  }

  return (
    <section aria-label="Recorded deadlines">
      <h3 className="wx-action-title">Recorded deadlines</h3>
      <Hint>{NOT_COMPUTED}</Hint>
      {props.deadlines.length === 0 ? <NoDueDateAlert /> : null}
      {props.deadlines.length > 0 ? (
        <table className="wx-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Due</th>
              <th>Status</th>
              <th>Source</th>
              <th>
                <span className="wx-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {props.deadlines.map((d) => (
              <tr key={d.id}>
                <td>{d.label}</td>
                <td>{formatDay(d.dueOn)}</td>
                <td>
                  <StatusPill
                    label={humanize(d.status)}
                    tone={toneOf(RECORDED_DEADLINE_TONE, d.status)}
                  />
                </td>
                <td>{d.sourceNote}</td>
                <td>
                  {props.editable && d.status !== "satisfied" ? (
                    <ButtonRow>
                      <Button
                        size="sm"
                        tone="tertiary"
                        aria-label={`Edit deadline ${d.label}`}
                        disabled={satisfyingId !== null}
                        onClick={() => setEditing({ deadline: d })}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        tone="secondary"
                        aria-label={`Mark ${d.label} satisfied`}
                        disabled={satisfyingId !== null}
                        onClick={() => void satisfy(d)}
                      >
                        {satisfyingId === d.id ? "Working…" : "Mark satisfied"}
                      </Button>
                    </ButtonRow>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <ErrorAlert message={error} />
      {props.editable ? (
        <ButtonRow>
          <Button size="sm" tone="secondary" onClick={() => setEditing({ deadline: null })}>
            Record a deadline
          </Button>
        </ButtonRow>
      ) : null}
      {editing ? (
        <DeadlineModal
          {...props}
          deadline={
            // The live row, so a reload after a version conflict hands the modal the new version.
            props.deadlines.find((d) => d.id === editing.deadline?.id) ?? editing.deadline
          }
          onClose={() => setEditing(null)}
          onReload={props.onChanged}
          onDone={() => {
            setEditing(null);
            props.onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

/** The first thing still missing before a deadline can be recorded, or null when the form is complete. */
function blockedReasonFor(
  label: string,
  dueOn: string,
  sourceNote: string,
  noticeBad: boolean,
): string | null {
  if (label.trim() === "") return "Enter what is due.";
  if (dueOn === "") return "Enter the due date from the notice.";
  if (sourceNote.trim() === "") return "Say which notice this date came from (source note).";
  if (noticeBad) return "The notice document ID must be a UUID.";
  return null;
}

function DeadlineModal(
  props: RecordedDeadlinesProps & {
    readonly deadline: RecordedDeadlineView | null;
    readonly onClose: () => void;
    readonly onDone: () => void;
    readonly onReload: () => void;
  },
): JSX.Element {
  const client = useApiClient();
  const { deadline } = props;
  const [label, setLabel] = useState(deadline?.label ?? "");
  const [dueOn, setDueOn] = useState(deadline?.dueOn ?? "");
  const [sourceNote, setSourceNote] = useState(deadline?.sourceNote ?? "");
  const [noticeDocumentId, setNoticeDocumentId] = useState(deadline?.noticeDocumentId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const noticeBad =
    props.allowNoticeDocument && noticeDocumentId.trim() !== "" && !isUuid(noticeDocumentId);
  // The source note is mandatory: a date without the notice it came from is not recorded.
  const blockedReason = blockedReasonFor(label, dueOn, sourceNote, noticeBad);
  const blocked = blockedReason !== null;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const notice =
      props.allowNoticeDocument && noticeDocumentId.trim() ? noticeDocumentId.trim() : null;
    const res = deadline
      ? await editRecordedDeadline(client, props.subject, deadline, {
          label: label.trim(),
          dueOn,
          sourceNote: sourceNote.trim(),
          ...(props.allowNoticeDocument ? { noticeDocumentId: notice } : {}),
        })
      : await addRecordedDeadline(client, props.subject, {
          label: label.trim(),
          dueOn,
          sourceNote: sourceNote.trim(),
          ...(notice ? { noticeDocumentId: notice } : {}),
        });
    if (!mounted.current) return;
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      // The deadline moved under us: reload (typed values stay) so the retry carries the new version.
      if (isConflict(res)) props.onReload();
    } else props.onDone();
  }

  return (
    <ActionModal
      ariaLabel={deadline ? "Edit recorded deadline" : "Record a deadline"}
      onClose={props.onClose}
    >
      <TextField
        label="What is due"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        maxLength={200}
      />
      <TextField
        label="Due date (from the notice)"
        type="date"
        value={dueOn}
        onChange={(e) => setDueOn(e.target.value)}
      />
      <TextField
        label="Source note (which notice, and where on it)"
        value={sourceNote}
        onChange={(e) => setSourceNote(e.target.value)}
        maxLength={500}
        error={
          sourceNote.trim() === "" ? "Required: say which notice this date came from." : undefined
        }
      />
      {props.allowNoticeDocument ? (
        <TextField
          label="Notice document ID (optional)"
          value={noticeDocumentId}
          onChange={(e) => setNoticeDocumentId(e.target.value)}
          error={noticeBad ? "Enter a document UUID." : undefined}
        />
      ) : null}
      <PhiNotice />
      <Hint>{NOT_COMPUTED}</Hint>
      <ErrorAlert message={error} />
      <FormButtons
        submitLabel={deadline ? "Save deadline" : "Record deadline"}
        busy={busy}
        blocked={blocked}
        blockedReason={blockedReason ?? undefined}
        onSubmit={() => void submit()}
        onCancel={props.onClose}
      />
    </ActionModal>
  );
}
