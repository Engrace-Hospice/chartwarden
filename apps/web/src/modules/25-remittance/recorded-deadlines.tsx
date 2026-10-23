import { Button, StatusPill, TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — recorded deadlines (milestone 7a-1), shared by the later-tier panel and the
// audit detail. A recorded deadline is a date the user typed from a notice, with the source note that says which
// notice. The app computes nothing and applies no default: no deadline recorded reads as exactly that, loudly.
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ActionModal, ButtonRow, ErrorAlert, FormButtons, Hint } from "./action-ui";
import {
  type DeadlineSubject,
  type RecordedDeadlineView,
  addRecordedDeadline,
  editRecordedDeadline,
  satisfyRecordedDeadline,
} from "./audit-api";
import { isUuid } from "./remittance-api";
import { RECORDED_DEADLINE_TONE, humanize, toneOf } from "./remittance-status";

export const NOT_COMPUTED = "From your notice, not a computed CMS date.";
export const NO_DUE_DATE = "No due date recorded - enter it from the notice";

export function NoDueDateAlert(): JSX.Element {
  return (
    <output
      className="wx-action-hint"
      style={{ display: "block", color: "var(--color-error)", fontWeight: 600 }}
    >
      {NO_DUE_DATE}
    </output>
  );
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

  async function satisfy(d: RecordedDeadlineView): Promise<void> {
    setError(null);
    const res = await satisfyRecordedDeadline(client, props.subject, d);
    if (!res.ok) setError(res.message);
    else props.onChanged();
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
              <th />
            </tr>
          </thead>
          <tbody>
            {props.deadlines.map((d) => (
              <tr key={d.id}>
                <td>{d.label}</td>
                <td>{d.dueOn}</td>
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
                        onClick={() => setEditing({ deadline: d })}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        tone="secondary"
                        aria-label={`Mark ${d.label} satisfied`}
                        onClick={() => void satisfy(d)}
                      >
                        Mark satisfied
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
          deadline={editing.deadline}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            props.onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

function DeadlineModal(
  props: RecordedDeadlinesProps & {
    readonly deadline: RecordedDeadlineView | null;
    readonly onClose: () => void;
    readonly onDone: () => void;
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
  const blocked = label.trim() === "" || dueOn === "" || sourceNote.trim() === "" || noticeBad;

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
    if (!res.ok) setError(res.message);
    else props.onDone();
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
      <Hint>{NOT_COMPUTED}</Hint>
      <ErrorAlert message={error} />
      <FormButtons
        submitLabel={deadline ? "Save deadline" : "Record deadline"}
        busy={busy}
        blocked={blocked}
        onSubmit={() => void submit()}
        onCancel={props.onClose}
      />
    </ActionModal>
  );
}
