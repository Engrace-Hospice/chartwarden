// M36 WP 4.2 - the acknowledgment-request card under a message in a patient care-team conversation: status as words AND an icon
// (never colour alone), the deadline in local time, and two explicit buttons offered only by the server's `viewer_actions`.
// The fixed notice is wired to the buttons with aria-describedby. Rendering, focusing or scrolling to the card sends nothing.
import type { AckRequestDto } from "@wardenx/types";
import { Glyph } from "@wardenx/ui";
import { type JSX, type ReactNode, createContext, useContext, useId, useMemo } from "react";
import {
  ACK_CLOSE_LABEL,
  ACK_LOAD_FAILED_TEXT,
  ACK_NOTICE,
  ACK_RETRY_LABEL,
  ACK_STATUS_TEXT,
  ACK_TAKE_LABEL,
  ACK_WORKING_TEXT,
  waitingFor,
} from "./ack-wording";
import { type AckAction, useAckRequests } from "./use-ack-requests";
import "./ack.css";

const localTime = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));

interface CardProps {
  readonly request: AckRequestDto;
  readonly busy: boolean;
  readonly onAct: (requestId: string, action: AckAction) => void;
}

export function AckRequestCard({ request, busy, onAct }: CardProps): JSX.Element {
  const noticeId = useId();
  const actions = request.viewer_actions;
  const waiting = request.status === "pending" || request.status === "escalated";
  const icon =
    request.status === "resolved" || request.status === "acknowledged" ? "check" : "clock";
  return (
    <section className="wx-ack-card" aria-label="Response request" data-status={request.status}>
      <p className="wx-ack-status">
        <Glyph name={request.status === "failed_unreachable" ? "alert" : icon} size={14} />
        <span>{ACK_STATUS_TEXT[request.status]}</span>
      </p>
      {waiting ? (
        <p className="wx-ack-detail">
          {waitingFor(actions.can_acknowledge)}.{" "}
          <time dateTime={request.deadline_at}>Respond by {localTime(request.deadline_at)}</time>
        </p>
      ) : null}
      {actions.can_acknowledge || actions.can_resolve ? (
        <>
          <p id={noticeId} className="wx-ack-notice">
            {ACK_NOTICE}
          </p>
          <div className="wx-ack-buttons">
            {actions.can_acknowledge ? (
              <button
                type="button"
                disabled={busy}
                aria-describedby={noticeId}
                onClick={() => onAct(request.id, "acknowledge")}
              >
                {busy ? ACK_WORKING_TEXT : ACK_TAKE_LABEL}
              </button>
            ) : null}
            {actions.can_resolve ? (
              <button
                type="button"
                disabled={busy}
                aria-describedby={noticeId}
                onClick={() => onAct(request.id, "resolve")}
              >
                {busy ? ACK_WORKING_TEXT : ACK_CLOSE_LABEL}
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

interface Slot {
  readonly byMessage: ReadonlyMap<string, AckRequestDto>;
  readonly busyId: string | null;
  readonly act: (requestId: string, action: AckAction) => Promise<void>;
}
const SlotContext = createContext<Slot | null>(null);

/** Loads the channel's requests once and offers them to the rows below; renders the load failure and action notice once. */
export function AckRequestsProvider({
  channelId,
  enabled,
  children,
}: { channelId: string; enabled: boolean; children: ReactNode }): JSX.Element {
  const state = useAckRequests(channelId, enabled);
  const slot = useMemo<Slot>(
    () => ({
      byMessage: new Map(state.requests.map((r) => [r.message_id, r])),
      busyId: state.busyId,
      act: state.act,
    }),
    [state.requests, state.busyId, state.act],
  );
  return (
    <SlotContext.Provider value={enabled ? slot : null}>
      {enabled && state.status === "transient" ? (
        <output className="wx-ack-banner">
          {ACK_LOAD_FAILED_TEXT}{" "}
          <button type="button" onClick={() => void state.reload()}>
            {ACK_RETRY_LABEL}
          </button>
        </output>
      ) : null}
      {enabled && state.notice ? <output className="wx-ack-banner">{state.notice}</output> : null}
      {children}
    </SlotContext.Provider>
  );
}

/** The card for one message, or nothing when it has no request (or there is no provider). */
export function AckForMessage({ messageId }: { messageId: string }): JSX.Element | null {
  const slot = useContext(SlotContext);
  const request = slot?.byMessage.get(messageId);
  if (!slot || !request) return null;
  return (
    <AckRequestCard
      request={request}
      busy={slot.busyId === request.id}
      onAct={(id, action) => void slot.act(id, action)}
    />
  );
}
