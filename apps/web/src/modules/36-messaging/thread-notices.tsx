import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useLiveAnnouncement } from "./use-live-announcement";

/**
 * The latched "history may have a hole" warning. It stays mounted so it can finish the job: the parent clears `active` only
 * on a replace load (or a channel switch). When that follows this Reload click, the button that held focus is gone, so focus
 * moves to the timeline and "Messages reloaded" is announced.
 */
function CatchUpGapNotice({
  active,
  onReload,
  focusTarget,
}: {
  readonly active: boolean;
  readonly onReload: () => void;
  readonly focusTarget: RefObject<HTMLElement>;
}) {
  const { region, announce } = useLiveAnnouncement();
  const reloadClicked = useRef(false);
  useEffect(() => {
    if (active || !reloadClicked.current) return;
    reloadClicked.current = false;
    focusTarget.current?.focus();
    announce("Messages reloaded");
  }, [active, focusTarget, announce]);
  return (
    <>
      {active ? (
        <output className="wx-thread-refresh-warning">
          Some messages may be missing.{" "}
          <button
            type="button"
            onClick={() => {
              reloadClicked.current = true;
              onReload();
            }}
          >
            Reload
          </button>
        </output>
      ) : null}
      {region}
    </>
  );
}

function RefreshErrorNotice({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <output className="wx-thread-refresh-warning">
      Connection interrupted.{" "}
      <button type="button" onClick={onRetry}>
        Retry now
      </button>
    </output>
  );
}

/** The thread's banner row between the timeline and the composer: what is new, where you are, and what may be wrong. */
export function ThreadNotices({
  newMessageCount,
  onShowLatest,
  browsingHistory,
  onBackToLatest,
  anchorMissing,
  catchUpGap,
  timelineRef,
  refreshError,
  onRetry,
}: {
  readonly newMessageCount: number;
  readonly onShowLatest: () => void;
  readonly browsingHistory: boolean;
  readonly onBackToLatest: () => void;
  readonly anchorMissing: boolean;
  readonly catchUpGap: boolean;
  readonly timelineRef: RefObject<HTMLElement>;
  readonly refreshError: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <>
      {newMessageCount > 0 ? (
        <button type="button" className="wx-new-messages" onClick={onShowLatest}>
          {newMessageCount} new {newMessageCount === 1 ? "message" : "messages"}
        </button>
      ) : null}
      {browsingHistory ? (
        <button type="button" className="wx-new-messages" onClick={onBackToLatest}>
          Back to latest messages
        </button>
      ) : null}
      {anchorMissing ? (
        <output className="wx-thread-refresh-warning">That message is no longer available.</output>
      ) : null}
      <CatchUpGapNotice active={catchUpGap} onReload={onBackToLatest} focusTarget={timelineRef} />
      {refreshError ? <RefreshErrorNotice onRetry={onRetry} /> : null}
    </>
  );
}
