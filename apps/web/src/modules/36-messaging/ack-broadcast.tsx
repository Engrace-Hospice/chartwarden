// apps/web/src/modules/36-messaging - WP 6.8 (ADR-0097): announcements that require acknowledgment. Two flat sections on one screen: the
// caller's own waiting list (each with an explicit Acknowledge button; opening never acknowledges) and, for a holder of messaging.announce,
// a rail of the announcements they oversee with a detail panel listing EVERY non-acknowledger, apart from people who are no longer active.
import {
  ACK_BROADCAST_FILTERS,
  type AckBroadcastFilter,
  type AckBroadcastMine,
  type AckBroadcastPerson,
  type AckBroadcastState,
  type AckBroadcastSummary,
} from "@chartwarden/types";
import { Button, EmptyState, LoadingSpinner, Modal, PageHeader, StatusPill } from "@chartwarden/ui";
import { type JSX, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ACK_FAILED,
  ACK_LABEL,
  ACK_REFRESH_FAILED,
  ACKNOWLEDGED_ANNOUNCEMENT,
  LOAD_MORE_FAILED,
  BROADCAST_BREADCRUMB,
  BROADCAST_DENIED,
  BROADCAST_LOAD_FAILED,
  BROADCAST_NOTICE,
  BROADCAST_OFF_TEXT,
  BROADCAST_OFF_TITLE,
  BROADCAST_RETRY,
  BROADCAST_TITLE,
  DETAIL_LOAD_FAILED,
  DONE_HEADING,
  FILTER_LABELS,
  LOAD_MORE,
  MINE_EMPTY_TEXT,
  MINE_EMPTY_TITLE,
  MINE_HEADING,
  OPEN_LABEL,
  OUTSIDE_NOTE,
  PAST_DEADLINE_MARK,
  STATE_LABELS,
  SUPERVISE_EMPTY,
  SUPERVISE_HEADING,
  WITHDRAWN_MARK,
  WITHDRAWN_NOTE,
  WITHDRAWN_NOTICE,
  WITHDRAW_CANCEL,
  WITHDRAW_CONFIRM,
  WITHDRAW_FAILED,
  WITHDRAW_LABEL,
  WITHDRAW_TEXT,
  WITHDRAW_TITLE,
  deadlineLabel,
  progressLabel,
  sentLabel,
} from "./ack-broadcast-wording";
import { type MineView, type OverseeView, useAckBroadcast, useBroadcastDetail } from "./use-ack-broadcast";
import "./ack-broadcast.css";

const channelPath = (channelId: string): string => `/messaging?${new URLSearchParams({ channelId })}`;
const when = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

function Problem({ text, retry }: { readonly text: string; readonly retry?: () => void }): JSX.Element {
  return (
    <div className="wx-bc-problem" role="alert">
      <p>{text}</p>
      {retry ? (
        <Button type="button" tone="secondary" size="lg" onClick={retry}>
          {BROADCAST_RETRY}
        </Button>
      ) : null}
    </div>
  );
}

function MineRow({
  item,
  position,
  total,
  busy,
  onAck,
}: {
  readonly item: AckBroadcastMine;
  readonly position: number;
  readonly total: number;
  readonly busy: boolean;
  readonly onAck: () => void;
}): JSX.Element {
  const describedBy = useId();
  // The API sends no author or channel name, so the sent time (to the minute) and the place in the list are all that tell rows apart.
  return (
    <li className="wx-bc-row">
      <div className="wx-bc-main">
        <p className="wx-bc-title">{sentLabel(item.createdAt)}</p>
        {item.acknowledgedAt ? <p className="wx-bc-sub">Acknowledged {when(item.acknowledgedAt)}</p> : null}
        {item.deadlineAt && !item.acknowledgedAt ? <p className="wx-bc-sub">{deadlineLabel(item.deadlineAt)}</p> : null}
        <span id={describedBy} className="sr-only">
          {sentLabel(item.createdAt)}, {position} of {total}
        </span>
      </div>
      <Link className="wx-bc-link" to={channelPath(item.channelId)} aria-describedby={describedBy}>
        {OPEN_LABEL}
      </Link>
      {item.acknowledgedAt ? null : (
        <Button type="button" size="lg" disabled={busy} aria-describedby={describedBy} onClick={onAck}>
          {ACK_LABEL}
        </Button>
      )}
    </li>
  );
}

function MineSection({
  headingBase,
  view,
  busy,
  ackError,
  onAck,
  retry,
}: {
  readonly headingBase: string;
  readonly view: MineView;
  readonly busy: string | null;
  readonly ackError: boolean;
  readonly onAck: (id: string) => void;
  readonly retry: () => void;
}): JSX.Element {
  if (view.status === "loading") return <LoadingSpinner />;
  if (view.status === "off") return <EmptyState title={BROADCAST_OFF_TITLE} description={BROADCAST_OFF_TEXT} />;
  if (view.status === "denied") return <Problem text={BROADCAST_DENIED} />;
  if (view.status === "error") return <Problem text={BROADCAST_LOAD_FAILED} retry={retry} />;
  const waitingId = `${headingBase}-waiting`;
  const doneId = `${headingBase}-done`;
  const waiting = view.items.filter((i) => !i.acknowledgedAt);
  const done = view.items.filter((i) => i.acknowledgedAt);
  return (
    <>
      {ackError ? <Problem text={ACK_FAILED} /> : null}
      <section className="wx-bc-group" aria-labelledby={waitingId}>
        <h2 id={waitingId} className="wx-bc-heading">
          {MINE_HEADING} <span>{waiting.length}</span>
        </h2>
        {waiting.length === 0 ? (
          <EmptyState title={MINE_EMPTY_TITLE} description={MINE_EMPTY_TEXT} />
        ) : (
          <ul className="wx-bc-rows">
            {waiting.map((item, i) => (
              <MineRow
                key={item.messageId}
                item={item}
                position={i + 1}
                total={waiting.length}
                busy={busy === item.messageId}
                onAck={() => onAck(item.messageId)}
              />
            ))}
          </ul>
        )}
      </section>
      {done.length > 0 ? (
        <section className="wx-bc-group" aria-labelledby={doneId}>
          <h2 id={doneId} className="wx-bc-heading">
            {DONE_HEADING} <span>{done.length}</span>
          </h2>
          <ul className="wx-bc-rows">
            {done.map((item, i) => (
              <MineRow key={item.messageId} item={item} position={i + 1} total={done.length} busy={false} onAck={() => undefined} />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

const TONE: Record<AckBroadcastState, "success" | "warning" | "neutral"> = {
  acknowledged: "success",
  opened: "warning",
  not_opened: "warning",
  ineligible: "neutral",
};

function PersonRow({ person }: { readonly person: AckBroadcastPerson }): JSX.Element {
  return (
    <tr>
      <th scope="row">{person.displayName}</th>
      <td>
        <StatusPill tone={TONE[person.state]} label={STATE_LABELS[person.state]} />
      </td>
      <td>{when(person.acknowledgedAt ?? person.openedAt)}</td>
    </tr>
  );
}

function WithdrawDialog({
  busy,
  failed,
  onCancel,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly failed: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  // A confirmation holds nothing typed, so a scrim click may cancel it; while the request runs nothing can close it.
  return (
    <Modal open role="alertdialog" ariaLabel={WITHDRAW_TITLE} onClose={busy ? undefined : onCancel} width="30rem">
      <div className="wx-bc-dialog">
        <h2>{WITHDRAW_TITLE}</h2>
        <p>{WITHDRAW_TEXT}</p>
        {failed ? (
          <p role="alert" className="wx-bc-dialog-problem">
            {WITHDRAW_FAILED}
          </p>
        ) : null}
        <div className="wx-bc-dialog-actions">
          <Button type="button" tone="secondary" size="lg" disabled={busy} onClick={onCancel}>
            {WITHDRAW_CANCEL}
          </Button>
          <Button type="button" size="lg" disabled={busy} onClick={onConfirm}>
            {WITHDRAW_CONFIRM}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface WithdrawControls {
  readonly withdraw: (messageId: string) => Promise<boolean>;
  readonly state: "idle" | "busy" | "failed";
  readonly clearError: () => void;
}

function BroadcastMarks({ b }: { readonly b: AckBroadcastSummary }): JSX.Element | null {
  if (!b.withdrawnAt && !b.pastDeadline && !b.deadlineAt) return null;
  return (
    <span className="wx-bc-marks">
      {b.withdrawnAt ? <StatusPill tone="neutral" label={WITHDRAWN_MARK} /> : null}
      {b.pastDeadline ? <StatusPill tone="warning" label={PAST_DEADLINE_MARK} /> : null}
      {b.deadlineAt && !b.withdrawnAt && !b.pastDeadline ? <span className="wx-bc-sub">{deadlineLabel(b.deadlineAt)}</span> : null}
    </span>
  );
}

function DetailPanel({
  broadcast,
  controls,
}: {
  readonly broadcast: AckBroadcastSummary;
  readonly controls: WithdrawControls;
}): JSX.Element {
  const [filter, setFilter] = useState<AckBroadcastFilter>("pending");
  const [confirming, setConfirming] = useState(false);
  const { view, more, moreState, reload } = useBroadcastDetail(broadcast.messageId, filter);
  const headingId = useId();
  const c = broadcast.counts;
  return (
    <section className="wx-bc-detail" aria-labelledby={headingId}>
      <h3 id={headingId} className="wx-bc-heading">{sentLabel(broadcast.createdAt)}</h3>
      <BroadcastMarks b={broadcast} />
      {broadcast.deadlineAt && (broadcast.withdrawnAt || broadcast.pastDeadline) ? (
        <p className="wx-bc-sub">{deadlineLabel(broadcast.deadlineAt)}</p>
      ) : null}
      {broadcast.withdrawnAt ? (
        <p className="wx-bc-sub">{WITHDRAWN_NOTE}</p>
      ) : (
        <div className="wx-bc-withdraw">
          <Button type="button" tone="secondary" size="lg" onClick={() => setConfirming(true)}>
            {WITHDRAW_LABEL}
          </Button>
        </div>
      )}
      {confirming && !broadcast.withdrawnAt ? (
        <WithdrawDialog
          busy={controls.state === "busy"}
          failed={controls.state === "failed"}
          onCancel={() => {
            controls.clearError();
            setConfirming(false);
          }}
          onConfirm={() => {
            void controls.withdraw(broadcast.messageId).then((ok) => {
              if (ok) setConfirming(false);
            });
          }}
        />
      ) : null}
      <p className="wx-bc-sub" aria-live="polite">
        {progressLabel(c.acknowledged, c.audience)}. {c.pending} still to acknowledge ({c.notOpened} not opened).
        {c.ineligible > 0 ? ` ${c.ineligible} no longer active.` : ""}
      </p>
      {c.outsideAudience > 0 ? <p className="wx-bc-sub">{OUTSIDE_NOTE(c.outsideAudience)}</p> : null}
      <div className="wx-bc-filters" role="group" aria-label="Show">
        {ACK_BROADCAST_FILTERS.map((f) => (
          <Button key={f} type="button" size="lg" tone={f === filter ? "primary" : "secondary"} aria-pressed={f === filter} onClick={() => setFilter(f)}>
            {FILTER_LABELS[f]}
          </Button>
        ))}
      </div>
      {view.status === "loading" ? <LoadingSpinner /> : null}
      {view.status === "error" ? <Problem text={DETAIL_LOAD_FAILED} retry={reload} /> : null}
      {view.status === "ready" ? (
        <>
          {view.detail.people.length === 0 ? (
            <p className="wx-bc-sub">Nobody in this view.</p>
          ) : (
            <table className="wx-bc-table">
              <caption className="sr-only">{FILTER_LABELS[filter]}</caption>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Status</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {view.detail.people.map((p) => (
                  <PersonRow key={p.userId} person={p} />
                ))}
              </tbody>
            </table>
          )}
          {view.detail.hasMore ? (
            <div className="wx-bc-more">
              {moreState === "failed" ? <Problem text={LOAD_MORE_FAILED} /> : null}
              <Button type="button" tone="secondary" size="lg" disabled={moreState === "busy"} onClick={() => void more()}>
                {moreState === "failed" ? BROADCAST_RETRY : LOAD_MORE}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function OverseeSection({
  view,
  retry,
  controls,
}: {
  readonly view: OverseeView;
  readonly retry: () => void;
  readonly controls: WithdrawControls;
}): JSX.Element | null {
  const [selected, setSelected] = useState<string | null>(null);
  const headingId = useId();
  if (view.status === "hidden") return null;
  if (view.status === "loading") return <LoadingSpinner />;
  if (view.status === "error") return <Problem text={BROADCAST_LOAD_FAILED} retry={retry} />;
  const chosen = view.broadcasts.find((b) => b.messageId === selected) ?? view.broadcasts[0];
  return (
    <section className="wx-bc-group" aria-labelledby={headingId}>
      <h2 id={headingId} className="wx-bc-heading">
        {SUPERVISE_HEADING} <span>{view.broadcasts.length}</span>
      </h2>
      {!chosen ? (
        <p className="wx-bc-sub">{SUPERVISE_EMPTY}</p>
      ) : (
        <div className="wx-bc-split">
          <ul className="wx-bc-rail">
            {view.broadcasts.map((b) => (
              <li key={b.messageId}>
                <button
                  type="button"
                  className="wx-bc-rail-item"
                  aria-current={b.messageId === chosen.messageId ? "true" : undefined}
                  onClick={() => setSelected(b.messageId)}
                >
                  <span>{sentLabel(b.createdAt)}</span>
                  <span className="wx-bc-sub">{progressLabel(b.counts.acknowledged, b.counts.audience)}</span>
                  <BroadcastMarks b={b} />
                </button>
              </li>
            ))}
          </ul>
          <DetailPanel key={chosen.messageId} broadcast={chosen} controls={controls} />
        </div>
      )}
    </section>
  );
}

export function AckBroadcast(): JSX.Element {
  const { mine, oversee, ackError, refreshFailed, busy, acknowledge, reload, withdraw, withdrawState, clearWithdrawError } =
    useAckBroadcast();
  const headingBase = useId();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [notice, setNotice] = useState({ n: 0, text: "" });
  // After Acknowledge (or a withdrawal) the control that had focus leaves the page: move focus to the status line, which says what happened.
  useEffect(() => {
    if (notice.n > 0) statusRef.current?.focus();
  }, [notice.n]);
  const say = (text: string): void => setNotice((prev) => ({ n: prev.n + 1, text }));
  const onAck = (id: string): void => {
    void acknowledge(id).then((record) => {
      if (record) say(ACKNOWLEDGED_ANNOUNCEMENT);
    });
  };
  const controls: WithdrawControls = {
    withdraw: async (id) => {
      const ok = await withdraw(id);
      if (ok) say(WITHDRAWN_NOTICE);
      return ok;
    },
    state: withdrawState,
    clearError: clearWithdrawError,
  };
  return (
    <>
      <PageHeader title={BROADCAST_TITLE} breadcrumb={BROADCAST_BREADCRUMB}>
        {mine.status === "off" ? null : <p className="wx-bc-sub">{BROADCAST_NOTICE}</p>}
      </PageHeader>
      <div className="wx-bc">
        <p key={notice.n} ref={statusRef} role="status" tabIndex={-1} className="wx-bc-status">
          {notice.text}
        </p>
        {refreshFailed ? <Problem text={ACK_REFRESH_FAILED} retry={() => void reload()} /> : null}
        <MineSection headingBase={headingBase} view={mine} busy={busy} ackError={ackError} onAck={onAck} retry={() => void reload()} />
        {mine.status === "off" ? null : <OverseeSection view={oversee} retry={() => void reload()} controls={controls} />}
      </div>
    </>
  );
}
