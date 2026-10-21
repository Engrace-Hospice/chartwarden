// apps/web/src/modules/36-messaging — WP 4.8 (ADR-0075): the landing for `{origin}/n/{opaque delivery id}`, the link every push,
// SMS and email alert carries.
//
// It is a CHROMED route, so the shell's guard sends a signed-out visitor to sign-in and renders nothing of this screen first (the
// shell remembers only the opaque id and brings the visitor back after sign-in). Once signed in, one read asks the server where the
// id leads; the server answers only for the signed-in recipient's own delivery in their organisation and while they can still see
// the channel. The screen never shows, stores or logs the id, a channel, a message or a patient: while resolving it says only
// "Opening your notification", and every answer that says "no" (404, 403, any other 4xx, a malformed id) is the SAME
// "This notification is no longer available" page. A server or network failure is NOT "gone": it gets its own generic
// "Couldn't open this notification" page with a Retry button (still no id-derived content). The headline takes focus when a page
// replaces the resolving line, so a screen reader announces the change. On success it replaces itself with the thread (`/messaging?channelId=&messageId=`),
// which scrolls to the message and, for an acknowledgment request, focuses its card. Nothing here acknowledges anything.
import { CenteredStatusLayout, Glyph, useApiClient } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { notificationIdFromPath } from "../../shell/pending-deep-link";

export const LANDING_OPENING_TEXT = "Opening your notification";
export const LANDING_GONE_HEADLINE = "This notification is no longer available";
export const LANDING_GONE_EXPLANATION =
  "It may have been removed, or you may no longer have access. Your messages are still in ChartWarden.";
export const LANDING_GONE_ACTION = "Go to messages";
export const LANDING_FAILED_HEADLINE = "Couldn't open this notification";
export const LANDING_FAILED_EXPLANATION =
  "Something went wrong on our side or with your connection. Try again in a moment.";
export const LANDING_FAILED_ACTION = "Retry";

interface Target {
  readonly channelId: string;
  readonly messageId: string;
}
type State =
  | { readonly kind: "resolving" }
  | { readonly kind: "gone" }
  | { readonly kind: "failed" }
  | (Target & { readonly kind: "found" });

/** The thread route for a resolved target; both ids are server-supplied uuids, encoded anyway. */
export function threadPathFor(target: Target): string {
  return `/messaging?channelId=${encodeURIComponent(target.channelId)}&messageId=${encodeURIComponent(target.messageId)}`;
}

export function NotificationLanding(): JSX.Element {
  const client = useApiClient();
  const { id: rawId = "" } = useParams();
  // The same shape the link is minted with; anything else never reaches the server.
  const id = notificationIdFromPath(`/n/${rawId}`);
  const [state, setState] = useState<State>({ kind: "resolving" });
  const [attempt, setAttempt] = useState(0);
  const headlineRef = useRef<HTMLSpanElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the Retry trigger; the effect must re-run when it changes.
  useEffect(() => {
    if (id === null) {
      setState({ kind: "gone" });
      return;
    }
    let cancelled = false;
    setState({ kind: "resolving" });
    client
      .GET("/api/v1/messaging/deliveries/{id}/target", { params: { path: { id } } })
      .then(({ data, response }) => {
        if (cancelled) return;
        if (data) {
          setState({ kind: "found", channelId: data.channel_id, messageId: data.message_id });
          return;
        }
        // A 4xx is the server saying "no" (uniform 404/403); a timeout, rate limit or 5xx is transient and retryable.
        const transient =
          !response || response.status === 408 || response.status === 429 || response.status >= 500;
        setState({ kind: transient ? "failed" : "gone" });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [client, id, attempt]);

  const settled = state.kind === "gone" || state.kind === "failed";
  useEffect(() => {
    if (settled) headlineRef.current?.focus();
  }, [settled]);

  if (state.kind === "found") return <Navigate to={threadPathFor(state)} replace />;
  if (settled) {
    const failed = state.kind === "failed";
    return (
      <CenteredStatusLayout
        icon={<Glyph name="info" size={24} />}
        headline={
          <span ref={headlineRef} tabIndex={-1}>
            {failed ? LANDING_FAILED_HEADLINE : LANDING_GONE_HEADLINE}
          </span>
        }
        explanation={failed ? LANDING_FAILED_EXPLANATION : LANDING_GONE_EXPLANATION}
        actions={
          failed ? (
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              {LANDING_FAILED_ACTION}
            </button>
          ) : (
            <Link to="/messaging">{LANDING_GONE_ACTION}</Link>
          )
        }
      />
    );
  }
  return <output aria-live="polite">{LANDING_OPENING_TEXT}</output>;
}
