// apps/web/src/modules/36-messaging — WP 4.8 (ADR-0075): the landing for `{origin}/n/{opaque delivery id}`, the link every push,
// SMS and email alert carries.
//
// It is a CHROMED route, so the shell's guard sends a signed-out visitor to sign-in and renders nothing of this screen first (the
// shell remembers only the opaque id and brings the visitor back after sign-in). Once signed in, one read asks the server where the
// id leads; the server answers only for the signed-in recipient's own delivery in their organisation and while they can still see
// the channel. The screen never shows, stores or logs the id, a channel, a message or a patient: while resolving it says only
// "Opening your notification", and every failure (unknown, someone else's, deleted, access lost, server error) is the SAME
// "This notification is no longer available" page. On success it replaces itself with the thread (`/messaging?channelId=&messageId=`),
// which scrolls to the message and, for an acknowledgment request, focuses its card. Nothing here acknowledges anything.
import { CenteredStatusLayout, Glyph, useApiClient } from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { notificationIdFromPath } from "../../shell/pending-deep-link";

export const LANDING_OPENING_TEXT = "Opening your notification";
export const LANDING_GONE_HEADLINE = "This notification is no longer available";
export const LANDING_GONE_EXPLANATION =
  "It may have been removed, or you may no longer have access. Your messages are still in WardenX.";
export const LANDING_GONE_ACTION = "Go to messages";

interface Target {
  readonly channelId: string;
  readonly messageId: string;
}
type State =
  | { readonly kind: "resolving" }
  | { readonly kind: "gone" }
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

  useEffect(() => {
    if (id === null) {
      setState({ kind: "gone" });
      return;
    }
    let cancelled = false;
    setState({ kind: "resolving" });
    client
      .GET("/api/v1/messaging/deliveries/{id}/target", { params: { path: { id } } })
      .then(({ data }) => {
        if (cancelled) return;
        setState(
          data
            ? { kind: "found", channelId: data.channel_id, messageId: data.message_id }
            : { kind: "gone" },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "gone" });
      });
    return () => {
      cancelled = true;
    };
  }, [client, id]);

  if (state.kind === "found") return <Navigate to={threadPathFor(state)} replace />;
  if (state.kind === "gone") {
    return (
      <CenteredStatusLayout
        icon={<Glyph name="info" size={24} />}
        headline={LANDING_GONE_HEADLINE}
        explanation={LANDING_GONE_EXPLANATION}
        actions={<Link to="/messaging">{LANDING_GONE_ACTION}</Link>}
      />
    );
  }
  return <output aria-live="polite">{LANDING_OPENING_TEXT}</output>;
}
