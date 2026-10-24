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
import { Button, EmptyState, LoadingSpinner, PageHeader, StatusPill } from "@chartwarden/ui";
import { type JSX, useState } from "react";
import { Link } from "react-router-dom";
import {
  ACK_FAILED,
  ACK_LABEL,
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
  STATE_LABELS,
  SUPERVISE_EMPTY,
  SUPERVISE_HEADING,
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
        <Button type="button" tone="secondary" size="sm" onClick={retry}>
          {BROADCAST_RETRY}
        </Button>
      ) : null}
    </div>
  );
}

function MineRow({
  item,
  busy,
  onAck,
}: { readonly item: AckBroadcastMine; readonly busy: boolean; readonly onAck: () => void }): JSX.Element {
  return (
    <li className="wx-bc-row">
      <div className="wx-bc-main">
        <p className="wx-bc-title">{sentLabel(item.createdAt)}</p>
        {item.acknowledgedAt ? <p className="wx-bc-sub">Acknowledged {when(item.acknowledgedAt)}</p> : null}
      </div>
      <Link className="wx-bc-link" to={channelPath(item.channelId)}>
        {OPEN_LABEL}
        <span className="sr-only"> {sentLabel(item.createdAt)}</span>
      </Link>
      {item.acknowledgedAt ? null : (
        <Button type="button" size="sm" disabled={busy} onClick={onAck}>
          {ACK_LABEL}
          <span className="sr-only"> {sentLabel(item.createdAt)}</span>
        </Button>
      )}
    </li>
  );
}

function MineSection({
  view,
  busy,
  ackError,
  onAck,
  retry,
}: {
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
  const waiting = view.items.filter((i) => !i.acknowledgedAt);
  const done = view.items.filter((i) => i.acknowledgedAt);
  return (
    <>
      {ackError ? <Problem text={ACK_FAILED} /> : null}
      <section className="wx-bc-group" aria-label={MINE_HEADING}>
        <h2 className="wx-bc-heading">
          {MINE_HEADING} <span>{waiting.length}</span>
        </h2>
        {waiting.length === 0 ? (
          <EmptyState title={MINE_EMPTY_TITLE} description={MINE_EMPTY_TEXT} />
        ) : (
          <ul className="wx-bc-rows">
            {waiting.map((item) => (
              <MineRow key={item.messageId} item={item} busy={busy === item.messageId} onAck={() => onAck(item.messageId)} />
            ))}
          </ul>
        )}
      </section>
      {done.length > 0 ? (
        <section className="wx-bc-group" aria-label={DONE_HEADING}>
          <h2 className="wx-bc-heading">
            {DONE_HEADING} <span>{done.length}</span>
          </h2>
          <ul className="wx-bc-rows">
            {done.map((item) => (
              <MineRow key={item.messageId} item={item} busy={false} onAck={() => undefined} />
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

function DetailPanel({ broadcast }: { readonly broadcast: AckBroadcastSummary }): JSX.Element {
  const [filter, setFilter] = useState<AckBroadcastFilter>("pending");
  const { view, more } = useBroadcastDetail(broadcast.messageId, filter);
  const c = broadcast.counts;
  return (
    <section className="wx-bc-detail" aria-label={sentLabel(broadcast.createdAt)}>
      <h3 className="wx-bc-heading">{sentLabel(broadcast.createdAt)}</h3>
      <p className="wx-bc-sub" aria-live="polite">
        {progressLabel(c.acknowledged, c.audience)}. {c.pending} still to acknowledge ({c.notOpened} not opened).
        {c.ineligible > 0 ? ` ${c.ineligible} no longer active.` : ""}
      </p>
      {c.outsideAudience > 0 ? <p className="wx-bc-sub">{OUTSIDE_NOTE(c.outsideAudience)}</p> : null}
      <div className="wx-bc-filters" role="group" aria-label="Show">
        {ACK_BROADCAST_FILTERS.map((f) => (
          <Button key={f} type="button" size="sm" tone={f === filter ? "primary" : "secondary"} aria-pressed={f === filter} onClick={() => setFilter(f)}>
            {FILTER_LABELS[f]}
          </Button>
        ))}
      </div>
      {view.status === "loading" ? <LoadingSpinner /> : null}
      {view.status === "error" ? <Problem text={DETAIL_LOAD_FAILED} /> : null}
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
            <Button type="button" tone="secondary" size="sm" onClick={() => void more()}>
              {LOAD_MORE}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function OverseeSection({ view }: { readonly view: OverseeView }): JSX.Element | null {
  const [selected, setSelected] = useState<string | null>(null);
  if (view.status === "hidden") return null;
  if (view.status === "loading") return <LoadingSpinner />;
  if (view.status === "error") return <Problem text={BROADCAST_LOAD_FAILED} />;
  const chosen = view.broadcasts.find((b) => b.messageId === selected) ?? view.broadcasts[0];
  return (
    <section className="wx-bc-group" aria-label={SUPERVISE_HEADING}>
      <h2 className="wx-bc-heading">
        {SUPERVISE_HEADING} <span>{view.broadcasts.length}</span>
      </h2>
      {!chosen ? (
        <p className="wx-bc-sub">{SUPERVISE_EMPTY}</p>
      ) : (
        <div className="wx-bc-split">
          <ul className="wx-bc-rail" aria-label={SUPERVISE_HEADING}>
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
                </button>
              </li>
            ))}
          </ul>
          <DetailPanel key={chosen.messageId} broadcast={chosen} />
        </div>
      )}
    </section>
  );
}

export function AckBroadcast(): JSX.Element {
  const { mine, oversee, ackError, busy, acknowledge, reload } = useAckBroadcast();
  return (
    <>
      <PageHeader title={BROADCAST_TITLE} breadcrumb={BROADCAST_BREADCRUMB}>
        <p className="wx-bc-sub">{BROADCAST_NOTICE}</p>
      </PageHeader>
      <div className="wx-bc" aria-label={BROADCAST_TITLE}>
        <MineSection view={mine} busy={busy} ackError={ackError} onAck={(id) => void acknowledge(id)} retry={() => void reload()} />
        {mine.status === "off" ? null : <OverseeSection view={oversee} />}
      </div>
    </>
  );
}
