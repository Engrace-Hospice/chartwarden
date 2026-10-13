// The three non-list states of the message timeline (error with retry, loading, empty), moved out of
// conversation-thread.tsx unchanged in WP 2.7a to keep that file under the line ceiling.
import { Button, EmptyState, Glyph } from "@wardenx/ui";
import type { JSX } from "react";
import { SkeletonRows } from "./skeleton-rows";

interface TimelineStateProps {
  readonly loadError: string | null;
  /** Quoted next to the failure so support can find the request. */
  readonly correlationId: string | null;
  /** The list has not been read yet. */
  readonly loading: boolean;
  /** The list was read and holds nothing. */
  readonly empty: boolean;
  readonly onRetry: () => void;
}

/** The state to show instead of the message list, or null when the list itself should render. */
export function TimelineState({
  loadError,
  correlationId,
  loading,
  empty,
  onRetry,
}: TimelineStateProps): JSX.Element | null {
  if (loadError) {
    return (
      <div className="wx-message-state" role="alert">
        <Glyph name="shield" size={24} />
        <strong>Conversation unavailable</strong>
        <span>{loadError}</span>
        {correlationId ? <small>Reference {correlationId}</small> : null}
        <Button size="sm" tone="secondary" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (loading) {
    return <SkeletonRows label="Loading messages" className="wx-message-state" />;
  }
  if (empty) {
    return (
      <div className="wx-message-state">
        <EmptyState title="No messages yet" description="Send the first secure message below." />
      </div>
    );
  }
  return null;
}
