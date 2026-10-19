// M36 WP 4.2 - the acknowledgment-request card under a message in a patient care-team conversation: status as words AND an icon
// (never colour alone), the deadline in local time, and two explicit buttons offered only by the server's `viewer_actions`.
// The fixed notice is shown ONCE per thread and wired to every button with aria-describedby. Results are announced in a
// persistent polite live region and focus moves to the card's status line after a saved action. Rendering, focusing or
// scrolling to the card sends nothing.
import type { AckRequestDto } from "@wardenx/types";
import { Button, Glyph } from "@wardenx/ui";
import {
  type JSX,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ACK_CLOSE_LABEL,
  ACK_FORBIDDEN_LOAD_TEXT,
  ACK_LOAD_FAILED_TEXT,
  ACK_NOTE_TEXT,
  ACK_NOTICE,
  ACK_RETRY_LABEL,
  ACK_SIGN_IN_LOAD_TEXT,
  ACK_STALE_TEXT,
  ACK_STATUS_TEXT,
  ACK_TAKE_LABEL,
  ACK_UNREACHABLE_TEXT,
  ACK_WAIT_LOAD_TEXT,
  ACK_WORKING_TEXT,
  closeName,
  escalatedWaitingFor,
  takeName,
  waitingFor,
} from "./ack-wording";
import { type AckAction, type AckListStatus, useAckRequests } from "./use-ack-requests";
import "./ack.css";

const isSameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();

/** Local time, with the date when it is not today. */
export const localTime = (iso: string, now: Date = new Date()): string => {
  const at = new Date(iso);
  const withDate = !isSameDay(at, now);
  return new Intl.DateTimeFormat(undefined, {
    ...(withDate ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
};

interface CardProps {
  readonly request: AckRequestDto;
  /** True while ANY action in this channel is in flight: every button is then inert. */
  readonly anyBusy: boolean;
  /** True when THIS request's action is the one in flight. */
  readonly busy: boolean;
  readonly noticeId?: string;
  readonly authorName?: string;
  readonly sentAt?: string;
  readonly focusRequested?: boolean;
  readonly onFocused?: () => void;
  readonly onAct: (requestId: string, action: AckAction) => void;
}

export function AckRequestCard({
  request,
  anyBusy,
  busy,
  noticeId,
  authorName,
  sentAt,
  focusRequested = false,
  onFocused,
  onAct,
}: CardProps): JSX.Element {
  const statusId = useId();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const cardRef = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (!focusRequested) return;
    // Never steal focus from somewhere the person moved to meanwhile (the composer, another message): the clicked button
    // has just left the page (so focus is on the body) or is still inside this card.
    const active = document.activeElement;
    if (!active || active === document.body || cardRef.current?.contains(active)) {
      statusRef.current?.focus();
    }
    onFocused?.();
  }, [focusRequested, onFocused]);

  const actions = request.viewer_actions;
  const waiting = request.status === "pending" || request.status === "escalated";
  const overdue = waiting && new Date(request.deadline_at) < new Date();
  const icon =
    request.status === "resolved" || request.status === "acknowledged" ? "check" : "clock";
  const unreachable = request.status === "failed_unreachable";
  const sent = localTime(sentAt ?? request.requested_at);
  // The accessible name starts with the VISIBLE text (WCAG 2.5.3), then says which message it is about.
  const nameOf = (label: string, make: typeof takeName): string =>
    busy ? make(authorName, sent).replace(label, ACK_WORKING_TEXT) : make(authorName, sent);
  const guard = (action: AckAction) => () => {
    if (!anyBusy) onAct(request.id, action);
  };
  const buttonProps = {
    size: "sm",
    tone: "secondary",
    "aria-disabled": anyBusy || undefined,
  } as const;
  const inertStyle = anyBusy ? { cursor: "not-allowed", opacity: 0.72 } : undefined;
  return (
    <fieldset
      ref={cardRef}
      className="wx-ack-card"
      aria-labelledby={statusId}
      data-status={request.status}
    >
      <p id={statusId} ref={statusRef} tabIndex={-1} className="wx-ack-status">
        <Glyph name={unreachable ? "alert" : icon} size={14} />
        <span>{ACK_STATUS_TEXT[request.status]}</span>
      </p>
      {waiting ? (
        <p className="wx-ack-detail">
          {(request.status === "escalated" ? escalatedWaitingFor : waitingFor)(
            actions.can_acknowledge,
          )}
          .{" "}
          <time dateTime={request.deadline_at}>
            {overdue ? "Overdue: was due" : "Respond by"} {localTime(request.deadline_at)}
          </time>
        </p>
      ) : null}
      {waiting && request.escalation_note ? (
        <p className="wx-ack-detail">{ACK_NOTE_TEXT[request.escalation_note]}</p>
      ) : null}
      {unreachable ? <p className="wx-ack-detail">{ACK_UNREACHABLE_TEXT}</p> : null}
      {request.status === "acknowledged" && request.acknowledged_at ? (
        <p className="wx-ack-detail">
          Taken {actions.can_resolve ? "by you" : "by the person it was sent to"} at{" "}
          <time dateTime={request.acknowledged_at}>{localTime(request.acknowledged_at)}</time>
        </p>
      ) : null}
      {actions.can_acknowledge || actions.can_resolve ? (
        <div className="wx-ack-buttons">
          {actions.can_acknowledge ? (
            <Button
              {...buttonProps}
              style={inertStyle}
              aria-label={nameOf(ACK_TAKE_LABEL, takeName)}
              aria-describedby={noticeId}
              onClick={guard("acknowledge")}
            >
              {busy ? ACK_WORKING_TEXT : ACK_TAKE_LABEL}
            </Button>
          ) : null}
          {actions.can_resolve ? (
            <Button
              {...buttonProps}
              style={inertStyle}
              aria-label={nameOf(ACK_CLOSE_LABEL, closeName)}
              aria-describedby={noticeId}
              onClick={guard("resolve")}
            >
              {busy ? ACK_WORKING_TEXT : ACK_CLOSE_LABEL}
            </Button>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

interface Slot {
  readonly byMessage: ReadonlyMap<string, AckRequestDto>;
  readonly busyId: string | null;
  readonly noticeId: string;
  readonly focusRequestId: string | null;
  readonly clearFocus: () => void;
  readonly act: (requestId: string, action: AckAction) => Promise<void>;
}
const SlotContext = createContext<Slot | null>(null);

const LOAD_PROBLEM_TEXT: Readonly<Partial<Record<AckListStatus, string>>> = {
  signin: ACK_SIGN_IN_LOAD_TEXT,
  forbidden: ACK_FORBIDDEN_LOAD_TEXT,
  throttled: ACK_WAIT_LOAD_TEXT,
};

/**
 * Loads the channel's requests once and offers them to the rows below; renders the load problem, the fixed notice and the
 * persistent live region once. `refreshKey` is the newest message id: a change re-reads the list.
 */
export function AckRequestsProvider({
  channelId,
  enabled,
  refreshKey,
  landOnMessageId = null,
  children,
}: {
  channelId: string;
  enabled: boolean;
  refreshKey?: string | null;
  /** WP 4.8: the message a notification link opened. Its request card takes focus ONCE when it loads (reading only, nothing is sent). */
  landOnMessageId?: string | null;
  children: ReactNode;
}): JSX.Element {
  const state = useAckRequests(channelId, enabled, refreshKey);
  const noticeId = useId();
  const [landedId, setLandedId] = useState<string | null>(null);
  const landingId = landOnMessageId
    ? (state.requests.find((r) => r.message_id === landOnMessageId)?.id ?? null)
    : null;
  const focusRequestId = state.focusRequestId ?? (landingId !== landedId ? landingId : null);
  const clearFocus = useCallback(() => {
    setLandedId(landingId);
    state.clearFocus();
  }, [landingId, state.clearFocus]);
  const slot = useMemo<Slot>(
    () => ({
      byMessage: new Map(state.requests.map((r) => [r.message_id, r])),
      busyId: state.busyId,
      noticeId,
      focusRequestId,
      clearFocus,
      act: state.act,
    }),
    [state.requests, state.busyId, focusRequestId, clearFocus, state.act, noticeId],
  );
  const hasActions = state.requests.some(
    (r) => r.viewer_actions.can_acknowledge || r.viewer_actions.can_resolve,
  );
  const stale = state.status === "transient" || state.status === "throttled";
  const problem =
    LOAD_PROBLEM_TEXT[state.status] ??
    (stale ? (state.requests.length > 0 ? ACK_STALE_TEXT : ACK_LOAD_FAILED_TEXT) : null);
  return (
    <SlotContext.Provider value={enabled ? slot : null}>
      {enabled ? (
        <>
          {/* Always mounted so a screen reader hears the result of an action: success politely, a failure assertively. */}
          <output aria-live="polite" aria-atomic="true" className="wx-ack-live">
            {state.noticeIsFailure ? null : state.notice}
          </output>
          <div role="alert" className="wx-ack-live wx-ack-alert">
            {state.noticeIsFailure ? state.notice : null}
          </div>
          {problem ? (
            <output className="wx-ack-banner">
              {problem}
              {stale ? " " : null}
              {stale ? (
                <Button size="sm" tone="tertiary" onClick={() => void state.reload()}>
                  {ACK_RETRY_LABEL}
                </Button>
              ) : null}
            </output>
          ) : null}
          {hasActions ? (
            <p id={noticeId} className="wx-ack-notice">
              {ACK_NOTICE}
            </p>
          ) : null}
        </>
      ) : null}
      {children}
    </SlotContext.Provider>
  );
}

/** The card for one message, or nothing when it has no request (or there is no provider). */
export function AckForMessage({
  messageId,
  authorName,
  sentAt,
}: { messageId: string; authorName?: string; sentAt?: string }): JSX.Element | null {
  const slot = useContext(SlotContext);
  const request = slot?.byMessage.get(messageId);
  if (!slot || !request) return null;
  return (
    <AckRequestCard
      request={request}
      anyBusy={slot.busyId !== null}
      busy={slot.busyId === request.id}
      noticeId={slot.noticeId}
      authorName={authorName}
      sentAt={sentAt}
      focusRequested={slot.focusRequestId === request.id}
      onFocused={slot.clearFocus}
      onAct={(id, action) => void slot.act(id, action)}
    />
  );
}
