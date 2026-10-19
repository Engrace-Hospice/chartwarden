import type { AckQueueItemDto, AckQueueStatus } from "@wardenx/types";
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
} from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
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
  QUEUE_RESTRICTED_TEXT,
  QUEUE_RETRY_LABEL,
  QUEUE_SHOW_ALL_LABEL,
  QUEUE_SIGN_IN,
  QUEUE_STALE,
  QUEUE_STATUS_TEXT,
  QUEUE_TITLE,
  QUEUE_UNASSIGNED_NAME,
  QUEUE_UNREACHABLE_TEXT,
  STATUS_FILTERS,
  dueText,
  overdueText,
  summaryText,
} from "./unacknowledged-wording";
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

function QueueRow({ item, now }: { item: AckQueueItemDto; now: number }): JSX.Element {
  const link = threadLink(item);
  const overdueSeconds = overdueSecondsAt(item, now);
  const overdue = Number.isNaN(Date.parse(item.deadline_at))
    ? item.overdue
    : overdueSeconds > 0 || Date.parse(item.deadline_at) <= now;
  const who = item.assigned_display_name ?? QUEUE_UNASSIGNED_NAME;
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
      <p className="wx-queue-line">{`Assigned to ${who}.`}</p>
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
    </li>
  );
}

export function UnacknowledgedQueue(): JSX.Element {
  const [filter, setFilter] = useState<QueueFilter>(ALL);
  const { view, retry, showMore, busyMore } = useUnacknowledgedQueue(filter);
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Where focus goes when the control that had it (Show more, Retry) leaves the page: the first row it appended, else the section.
  const focusAfter = useRef<{ readonly row: number } | "section" | null>(null);
  const rowCount = view.status === "ready" ? view.items.length : -1;

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list grows or the view settles
  useEffect(() => {
    const target = focusAfter.current;
    if (target === null || view.status === "loading" || busyMore) return;
    focusAfter.current = null;
    const row = target === "section" ? undefined : listRef.current?.children[target.row];
    ((row as HTMLElement | undefined) ?? sectionRef.current)?.focus();
  }, [view, rowCount, busyMore]);
  const retryWithFocus = (): void => {
    focusAfter.current = "section";
    retry();
  };
  const moreWithFocus = (): void => {
    focusAfter.current = { row: rowCount };
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
        <ul className="wx-queue-rows" aria-label={QUEUE_TITLE} ref={listRef}>
          {view.items.map((item, index) => (
            // A restricted row has no id: its position and deadline are its key within this ordered, append-only page.
            <QueueRow
              key={item.id ?? `r-${item.requested_at}-${item.deadline_at}-${index}`}
              item={item}
              now={now}
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
    <WorkQueueLayout
      header={
        <PageHeader title={QUEUE_TITLE} breadcrumb={QUEUE_BREADCRUMB}>
          <p className="wx-queue-note">{QUEUE_NOTICE}</p>
          <output className="wx-queue-summary" aria-live="polite">
            {summary}
          </output>
        </PageHeader>
      }
      filters={filters}
      table={
        <section className="wx-queue" aria-label={QUEUE_TITLE} ref={sectionRef} tabIndex={-1}>
          {body}
        </section>
      }
    />
  );
}
