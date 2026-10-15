// M36 WP 3.8 - the Review tab of Notifications & Tasks: open tasks of patients who were discharged, died or transferred,
// waiting for a supervisor to reassign or close them. Row buttons come only from each item's allowed_actions; a restricted
// row shows no patient and no actions; a row changes only when the server's answer replaces the list.
import type { ReviewAction, ReviewItemDto } from "@wardenx/types";
import { Button, EmptyState, LoadingSpinner, StatusPill } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ReviewResolveDialog } from "./review-resolve-dialog";
import {
  CLOSED_TEXT,
  NEEDS_OWNER_LABEL,
  NO_TASK_TEXT,
  REASSIGNED_TEXT,
  RESTRICTED_PATIENT_LABEL,
  RESTRICTED_ROW_TEXT,
  REVIEW_ACTION_LABELS,
  REVIEW_CAUSE_LABELS,
  REVIEW_EMPTY,
  REVIEW_HEADING,
  REVIEW_LOAD_FAILED,
  REVIEW_NOTICE,
  REVIEW_REASON_LABELS,
  REVIEW_RESOLUTION_LABELS,
} from "./review-wording";
import { type ReviewSource, type ReviewStateFilter, useReviewItems } from "./use-review-items";
import "./tasks.css";
import "./review.css";

type Dialog = { readonly item: ReviewItemDto; readonly mode: ReviewAction };

const STATES: readonly { value: ReviewStateFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
];

const ACTION_ORDER: readonly ReviewAction[] = ["reassign", "close"];

function ageText(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function taskLine(item: ReviewItemDto): string {
  const task = item.task;
  if (!task) return NO_TASK_TEXT;
  const parts = [
    `For ${task.assignee_display_name ?? "a colleague"}, from ${task.created_by_display_name ?? "a colleague"}`,
  ];
  if (task.due_at) parts.push(`Due ${new Date(task.due_at).toLocaleDateString()}`);
  return parts.join(". ");
}

function resolutionLine(item: ReviewItemDto): string {
  const parts = [item.resolution ? REVIEW_RESOLUTION_LABELS[item.resolution] : ""];
  if (item.reassigned_to_display_name) parts.push(`to ${item.reassigned_to_display_name}`);
  if (item.resolution_reason) parts.push(REVIEW_REASON_LABELS[item.resolution_reason]);
  if (item.resolved_by_display_name) parts.push(`by ${item.resolved_by_display_name}`);
  return parts.filter(Boolean).join(", ");
}

function ReviewRow({
  item,
  busy,
  onAction,
}: {
  item: ReviewItemDto;
  busy: boolean;
  onAction: (item: ReviewItemDto, mode: ReviewAction) => void;
}): JSX.Element {
  const actions = item.restricted
    ? []
    : ACTION_ORDER.filter(
        (action) => item.allowed_actions.includes(action) && (action !== "reassign" || item.task),
      );
  return (
    <li className="wx-task-row">
      <div className="wx-task-badges">
        <strong>
          {item.restricted
            ? RESTRICTED_PATIENT_LABEL
            : (item.patient_display_name ?? RESTRICTED_PATIENT_LABEL)}
        </strong>
        {!item.restricted && item.mrn_suffix ? (
          <span className="wx-task-tag">{`MRN ...${item.mrn_suffix}`}</span>
        ) : null}
        {item.cause ? <StatusPill label={REVIEW_CAUSE_LABELS[item.cause]} tone="neutral" /> : null}
        {item.task?.needs_owner ? (
          <StatusPill label={NEEDS_OWNER_LABEL} tone="warning" glyph="alert" />
        ) : null}
      </div>
      <p className="wx-task-people-line">
        {item.restricted ? RESTRICTED_ROW_TEXT : taskLine(item)}
        {` Waiting ${ageText(item.created_at)}.`}
      </p>
      {item.state === "resolved" && !item.restricted ? (
        <p className="wx-task-people-line">{resolutionLine(item)}</p>
      ) : null}
      {actions.length > 0 ? (
        <div className="wx-task-row-actions">
          {actions.map((action) => (
            <Button
              key={action}
              type="button"
              tone="secondary"
              size="sm"
              disabled={busy}
              onClick={() => onAction(item, action)}
            >
              {REVIEW_ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export interface ReviewQueueListProps {
  readonly meId: string;
  /** The already-read open list (the inbox shares it with its tab badge), used for the Open view. */
  readonly shared: ReviewSource;
}

export function ReviewQueueList({ meId, shared }: ReviewQueueListProps): JSX.Element {
  const [filter, setFilter] = useState<ReviewStateFilter>("open");
  const borrowing = filter === "open";
  const own = useReviewItems(filter, borrowing);
  const { view, reload } = borrowing ? shared : own;
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [status, setStatus] = useState("");
  const statusRef = useRef<HTMLOutputElement>(null);
  // How many more times to land on the status line: a finished action or a stale refusal re-reads the list and may take the
  // row (and the button that had focus) with it. Once when the dialog closes, once when the re-read arrives.
  const refocus = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a dialog closes or the list changes
  useEffect(() => {
    if (refocus.current === 0 || dialog) return;
    refocus.current -= 1;
    statusRef.current?.focus();
  }, [dialog, view]);

  function onStale(): void {
    refocus.current = 1;
    reload();
  }

  function finished(mode: ReviewAction): void {
    setStatus(mode === "reassign" ? REASSIGNED_TEXT : CLOSED_TEXT);
    refocus.current = 2;
    setDialog(null);
    reload();
  }

  return (
    <section className="wx-tasks" aria-labelledby="wx-review-heading">
      <h2 id="wx-review-heading">{REVIEW_HEADING}</h2>
      <p className="wx-task-notice">{REVIEW_NOTICE}</p>
      <fieldset className="wx-task-toggle">
        <legend className="sr-only">Review state</legend>
        {STATES.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            onClick={() => {
              setStatus("");
              setFilter(option.value);
            }}
          >
            {option.label}
          </button>
        ))}
      </fieldset>
      <output className="wx-review-status" ref={statusRef} tabIndex={-1}>
        {status}
      </output>
      {view.status === "loading" ? (
        <LoadingSpinner />
      ) : view.status !== "ready" ? (
        <p className="wx-task-error" role="alert">
          {REVIEW_LOAD_FAILED}
        </p>
      ) : view.items.length === 0 ? (
        <EmptyState title={REVIEW_HEADING} description={REVIEW_EMPTY[filter]} />
      ) : (
        <ul className="wx-task-rows" key={filter}>
          {view.items.map((item) => (
            <ReviewRow
              key={item.id}
              item={item}
              busy={dialog !== null}
              onAction={(row, mode) => {
                setStatus("");
                setDialog({ item: row, mode });
              }}
            />
          ))}
        </ul>
      )}
      {dialog ? (
        <ReviewResolveDialog
          item={dialog.item}
          mode={dialog.mode}
          meId={meId}
          onClose={() => setDialog(null)}
          onStale={onStale}
          onDone={finished}
        />
      ) : null}
    </section>
  );
}
