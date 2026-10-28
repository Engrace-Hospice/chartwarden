import type { AckQueueItemDto, AckQueueStatus } from "@chartwarden/types";
// apps/web/src/modules/36-messaging - WP 4.9 (ADR-0076): the supervisor's unacknowledged queue.
// Spec: plan row 4.9 ("Supervisor sees every pending/overdue item in their scope; none hidden by filters"). Read-only.
// Every request still waiting for a human, oldest deadline first, in a flat list: a state pill (words, never colour alone), how
// overdue it is, who it is assigned to, and a link into the conversation. A request the viewer cannot open is still listed with
// no patient and no message. The two filters only narrow and the total of everything waiting is always stated; a polite status
// line says what changed. The screen never acknowledges, reassigns or resolves anything and shows no message text.
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
} from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, MouseEvent } from "react";
import { Link } from "react-router-dom";
import { AckReassignDialog } from "./ack-reassign-dialog";
import { localTime } from "./ack-request-card";
import { addressedRoleText } from "./ack-wording";
import {
  OVERDUE_FILTER_LABEL,
  QUEUE_BREADCRUMB,
  QUEUE_CLASS_TEXT,
  QUEUE_DENIED,
  QUEUE_EMPTY_DESCRIPTION,
  QUEUE_EMPTY_TITLE,
  QUEUE_FILTER_EMPTY_TITLE,
  QUEUE_FILTER_NOTE,
  QUEUE_LOAD_FAILED,
  QUEUE_MORE_FAILED,
  QUEUE_MORE_LABEL,
  QUEUE_NOTE_TEXT,
  QUEUE_NOTICE,
  QUEUE_OPEN_LABEL,
  QUEUE_REASSIGN_LABEL,
  QUEUE_RESTRICTED_TEXT,
  QUEUE_RETRY_LABEL,
  QUEUE_SHOW_ALL_LABEL,
  QUEUE_SIGN_IN,
  QUEUE_SPAN_CAPPED,
  QUEUE_STALE,
  QUEUE_STATUS_TEXT,
  QUEUE_TITLE,
  QUEUE_UNASSIGNED_NAME,
  QUEUE_UNREACHABLE_TEXT,
  STATUS_FILTERS,
  dueText,
  overdueText,
  queueReassignName,
  queueSenderText,
  summaryText,
} from "./unacknowledged-wording";
import type { ReassignRun } from "./use-ack-reassign";
import { type QueueFilter, useUnacknowledgedQueue } from "./use-unacknowledged-queue";
import "./unacknowledged.css";

const STATUS_TONE: Readonly<Record<AckQueueStatus, StatusTone>> = {
  pending: "neutral",
  escalated: "warning",
  failed_unreachable: "error",
};

const ALL: QueueFilter = { status: "all", overdueOnly: false };

/** The thread route for a visible row; both ids are server-supplied uuids, encoded anyway. */
export const threadLink = (item: AckQueueItemDto): string | null =>
  !item.restricted && item.channel_id && item.message_id
    ? `/messaging?channelId=${encodeURIComponent(item.channel_id)}&messageId=${encodeURIComponent(item.message_id)}`
    : null;

/** Overdue is derived from the deadline and the screen's clock, so a row turns overdue between polls (the server's count lags until the next read). */
const overdueSecondsAt = (item: AckQueueItemDto, now: number): number =>
  Math.max(0, Math.floor((now - Date.parse(item.deadline_at)) / 1000));

function QueueRow({
  item,
  now,
  onReassign,
}: {
  item: AckQueueItemDto;
  now: number;
  onReassign: (requestRef: string, trigger: HTMLElement) => void;
}): JSX.Element {
  const link = threadLink(item);
  // The server's verdict can only be added to, never undone: a client clock running behind cannot hide an overdue row.
  const overdueSeconds = Math.max(item.overdue_seconds, overdueSecondsAt(item, now));
  const overdue = item.overdue || Date.parse(item.deadline_at) <= now;
  const who = item.assigned_display_name ?? QUEUE_UNASSIGNED_NAME;
  const roleText = addressedRoleText(item.addressed_role);
  return (
    <li className="wx-queue-row" tabIndex={-1}>
      <div className="wx-queue-badges">
        <StatusPill
          label={QUEUE_STATUS_TEXT[item.status]}
          tone={STATUS_TONE[item.status]}
          glyph={item.status === "failed_unreachable" ? "alert" : undefined}
        />
        <StatusPill
          label={overdue ? overdueText(overdueSeconds) : dueText(item.deadline_at, now)}
          tone={overdue ? "error" : "neutral"}
        />
        <span className="wx-queue-tag">{QUEUE_CLASS_TEXT[item.ack_class]}</span>
        {item.current_tier > 0 ? (
          <span className="wx-queue-tag">{`Tier ${item.current_tier + 1}`}</span>
        ) : null}
      </div>
      {roleText ? <p className="wx-queue-line">{`${roleText}.`}</p> : null}
      <p className="wx-queue-line">{`Assigned to ${who}.`}</p>
      <p className="wx-queue-line">{queueSenderText(item.requester_display_name)}</p>
      {item.delivery_failed ? <p className="wx-queue-line">{QUEUE_UNREACHABLE_TEXT}</p> : null}
      {item.escalation_note ? (
        <p className="wx-queue-line">{QUEUE_NOTE_TEXT[item.escalation_note]}</p>
      ) : null}
      {link ? (
        <Link
          className="wx-queue-link"
          to={link}
          aria-label={`${QUEUE_OPEN_LABEL}, assigned to ${who}`}
        >
          {QUEUE_OPEN_LABEL}
        </Link>
      ) : (
        <p className="wx-queue-line wx-queue-restricted">{QUEUE_RESTRICTED_TEXT}</p>
      )}
      <Button
        type="button"
        tone="secondary"
        size="sm"
        style={{ justifySelf: "start" }}
        aria-haspopup="dialog"
        aria-label={queueReassignName(
          who,
          item.requester_display_name,
          // A fixed clock time, not "in 5 min": the name must not change on every tick of the screen's clock.
          `due ${localTime(item.deadline_at)}`,
        )}
        onClick={(event) => onReassign(item.request_ref, event.currentTarget)}
      >
        {QUEUE_REASSIGN_LABEL}
      </Button>
    </li>
  );
}

/**
 * Focus is handed on after a click unless the person has already moved to another control. A mouse click does not focus a button in
 * Safari and Firefox, so "focus is on nothing (the page)" counts as still here, as does focus on the clicked control itself.
 */
const personStillHere = (control: HTMLElement): boolean => {
  const active = document.activeElement;
  return active === control || active === null || active === document.body;
};

export function UnacknowledgedQueue(): JSX.Element {
  const [filter, setFilter] = useState<QueueFilter>(ALL);
  const { view, retry, refresh, showMore, busyMore } = useUnacknowledgedQueue(filter);
  // ADR-0078 (G-2): the open supervisor-reassign dialog (by request_ref) and the one-line result it leaves. The dialog lives up here,
  // not in a row, so a background refresh that re-renders the rows can never unmount it or move focus.
  const [reassignRef, setReassignRef] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ text: string; failure: boolean } | null>(null);
  // The view object at the moment a dialog closed: focus is re-checked on the NEXT view change, once the refresh has actually landed.
  const focusLostCheck = useRef<unknown>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const trigger = useRef<HTMLElement | null>(null);
  const closedRef = useRef(false);
  const openReassign = (requestRef: string, button: HTMLElement): void => {
    trigger.current = button;
    setReassignRef(requestRef);
  };
  const runReassign = useCallback<ReassignRun>(
    async (perform) => {
      setOutcome(null);
      const result = await perform();
      if (result.kind === "stay") return result;
      setOutcome({ text: result.text, failure: result.failure });
      refresh();
      return result;
    },
    [refresh],
  );
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Where focus goes when the control that had it (Show more, Retry) leaves the page: the first row it appended, else the section.
  // `control` is the button that was clicked: focus is re-checked against it when the request SETTLES, not only at click time.
  type Pending =
    | { readonly kind: "row"; readonly row: number; readonly control: HTMLElement }
    | { readonly kind: "section"; readonly control: HTMLElement };
  const focusAfter = useRef<Pending | null>(null);
  // A Retry clicked while Show more was in flight: keep Show more's row target, and once the queued refresh has cleared the stale
  // state, put focus on the section only if it has been lost to the page.
  const sectionFallback = useRef(false);
  const rowCount = view.status === "ready" ? view.items.length : -1;

  // A new filter makes any pending focus target meaningless.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the filter primitives
  useEffect(() => {
    focusAfter.current = null;
    sectionFallback.current = false;
  }, [filter.status, filter.overdueOnly]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list grows or the view settles
  useEffect(() => {
    if (view.status === "loading" || busyMore) return;
    const target = focusAfter.current;
    if (target !== null) {
      focusAfter.current = null;
      // The control that had focus is still there when the action failed (its alert and button stay): do not move focus then.
      const failed =
        view.status === "error" ||
        view.status === "denied" ||
        (view.status === "ready" && (view.moreFailed || (target.kind === "section" && view.stale)));
      if (!failed && personStillHere(target.control)) {
        const row = target.kind === "row" ? listRef.current?.children[target.row] : undefined;
        if (target.kind === "section" || row)
          ((row as HTMLElement | undefined) ?? sectionRef.current)?.focus();
      }
    }
    if (sectionFallback.current && view.status === "ready" && !view.stale) {
      sectionFallback.current = false;
      const active = document.activeElement;
      if (active === null || active === document.body) sectionRef.current?.focus();
    }
  }, [view, rowCount, busyMore]);
  // The dialog has closed: focus goes back to the button that opened it (a mouse click does not focus a button in Safari, so the
  // modal cannot be trusted to remember it). If that row has left the list, the check below hands focus to the list instead.
  useEffect(() => {
    if (reassignRef !== null || !closedRef.current) return;
    closedRef.current = false;
    if (trigger.current?.isConnected) trigger.current.focus();
    else sectionRef.current?.focus();
  }, [reassignRef]);
  // After a reassign closed: if the row's button left the page with the refresh, focus must not fall to the page - the list takes it.
  useEffect(() => {
    if (focusLostCheck.current === null || reassignRef !== null || view.status !== "ready") return;
    if (focusLostCheck.current === view) return;
    focusLostCheck.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body) sectionRef.current?.focus();
  }, [view, reassignRef]);
  const retryWithFocus = (event: MouseEvent<HTMLButtonElement>): void => {
    if (busyMore) sectionFallback.current = true;
    else
      focusAfter.current = personStillHere(event.currentTarget)
        ? { kind: "section", control: event.currentTarget }
        : null;
    retry();
  };
  const moreWithFocus = (event: MouseEvent<HTMLButtonElement>): void => {
    focusAfter.current = personStillHere(event.currentTarget)
      ? { kind: "row", row: rowCount, control: event.currentTarget }
      : null;
    void showMore();
  };
  // Minute-grained "due in" text re-renders itself; the data poll is the hook's.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const filtered = filter.status !== "all" || filter.overdueOnly;
  const summary =
    view.status === "ready" ? summaryText(view.counts, view.items.length, view.filtered) : "";

  const filters = (
    <div className="wx-queue-filters">
      <fieldset className="wx-queue-toggle">
        <legend className="sr-only">Show requests by state</legend>
        {STATUS_FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter.status === option.value}
            onClick={() =>
              setFilter((prev) =>
                prev.status === option.value ? prev : { ...prev, status: option.value },
              )
            }
          >
            {option.label}
          </button>
        ))}
      </fieldset>
      <button
        type="button"
        className="wx-queue-overdue"
        aria-pressed={filter.overdueOnly}
        onClick={() => setFilter((prev) => ({ ...prev, overdueOnly: !prev.overdueOnly }))}
      >
        {OVERDUE_FILTER_LABEL}
      </button>
      <p className="wx-queue-note">{QUEUE_FILTER_NOTE}</p>
    </div>
  );

  let body: JSX.Element;
  if (view.status === "loading") {
    body = <LoadingSpinner />;
  } else if (view.status === "denied") {
    body = (
      <p className="wx-queue-error" role="alert">
        {view.signedOut ? QUEUE_SIGN_IN : QUEUE_DENIED}
      </p>
    );
  } else if (view.status === "error") {
    body = (
      <div className="wx-queue-error" role="alert">
        <p>{QUEUE_LOAD_FAILED}</p>
        <Button type="button" tone="secondary" size="sm" onClick={retryWithFocus}>
          {QUEUE_RETRY_LABEL}
        </Button>
      </div>
    );
  } else if (view.items.length === 0) {
    body = filtered ? (
      <EmptyState
        title={QUEUE_FILTER_EMPTY_TITLE}
        description={`${view.counts.unfiltered} waiting in all.`}
        action={
          <Button type="button" tone="secondary" size="sm" onClick={() => setFilter(ALL)}>
            {QUEUE_SHOW_ALL_LABEL}
          </Button>
        }
      />
    ) : (
      <EmptyState title={QUEUE_EMPTY_TITLE} description={QUEUE_EMPTY_DESCRIPTION} />
    );
  } else {
    body = (
      <>
        {view.stale ? (
          <div className="wx-queue-error" role="alert">
            <p>{QUEUE_STALE}</p>
            <Button type="button" tone="secondary" size="sm" onClick={retryWithFocus}>
              {QUEUE_RETRY_LABEL}
            </Button>
          </div>
        ) : null}
        {view.spanCapped ? <p className="wx-queue-note">{QUEUE_SPAN_CAPPED}</p> : null}
        <ul className="wx-queue-rows" aria-label={QUEUE_TITLE} ref={listRef}>
          {view.items.map((item, index) => (
            // A restricted row has no id: its position and deadline are its key within this ordered, append-only page.
            <QueueRow
              key={item.id ?? `r-${item.requested_at}-${item.deadline_at}-${index}`}
              item={item}
              now={now}
              onReassign={openReassign}
            />
          ))}
        </ul>
        {view.nextCursor ? (
          <div className="wx-queue-more">
            {view.moreFailed ? (
              <p className="wx-queue-error" role="alert">
                {QUEUE_MORE_FAILED}
              </p>
            ) : null}
            <Button
              type="button"
              tone="secondary"
              size="sm"
              loading={busyMore}
              onClick={moreWithFocus}
            >
              {QUEUE_MORE_LABEL}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader title={QUEUE_TITLE}>
            <p className="wx-queue-note">{QUEUE_NOTICE}</p>
            <output className="wx-queue-summary" aria-live="polite">
              {summary}
            </output>
            <output className="wx-queue-note" aria-live="polite">
              {outcome && !outcome.failure ? outcome.text : ""}
            </output>
            {outcome?.failure ? (
              <p role="alert" className="wx-queue-note">
                {outcome.text}
              </p>
            ) : null}
          </PageHeader>
        }
        filters={filters}
        table={
          <section className="wx-queue" aria-label={QUEUE_TITLE} ref={sectionRef} tabIndex={-1}>
            {body}
          </section>
        }
      />
      {reassignRef !== null ? (
        <AckReassignDialog
          mode="supervisor"
          requestId={reassignRef}
          run={runReassign}
          onClose={() => {
            // The LATEST view, not the one this render closed over: a poll that landed during the POST must not disarm the check.
            focusLostCheck.current = viewRef.current;
            closedRef.current = true;
            setReassignRef(null);
          }}
        />
      ) : null}
    </>
  );
}
