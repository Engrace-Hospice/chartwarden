// M36 WP 6.6 (ADR-0096 D19, D21) - the partner's reading view, PRESENTATIONAL. The partner page renders it with live messages and the staff invitation
// preview (partners.tsx) renders the SAME component with synthetic ones, so what staff preview is what the partner gets, by construction. Message text
// is rendered as plain text (React escapes it; nothing is parsed as markup or turned into a link), and nothing here writes to the title, storage,
// console or URL.
import type { PartnerMessageDto } from "@chartwarden/types";
import { Button, t } from "@chartwarden/ui";
import type { CSSProperties, JSX } from "react";

export interface PartnerConversationViewProps {
  readonly partnerName: string;
  readonly messages: readonly PartnerMessageDto[];
  /** Pre-formatted end of access; the view never formats a date it was not given. */
  readonly accessEndsText: string;
  /** Staff preview: labels the whole view as an example and renders no Refresh. */
  readonly example?: boolean;
  readonly onRefresh?: () => void;
  readonly refreshing?: boolean;
  readonly refreshFailed?: boolean;
}

const timeText = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
};

export function PartnerConversationView({
  partnerName,
  messages,
  accessEndsText,
  example = false,
  onRefresh,
  refreshing = false,
  refreshFailed = false,
}: PartnerConversationViewProps): JSX.Element {
  const Heading = example ? "h3" : "h1";
  return (
    <section aria-labelledby="partner-heading" style={wrap}>
      <Heading id="partner-heading" style={title}>
        {example ? "Example: " : ""}Shared conversation for {partnerName}
      </Heading>
      <p style={muted}>
        You can read new messages in this one conversation until {accessEndsText}. This page is
        read-only: you cannot reply, attach files or see who else is in the conversation. Some
        messages are never shown here.
      </p>
      {refreshFailed ? (
        <p role="alert" style={muted}>
          We could not refresh just now. The messages below may be out of date.
        </p>
      ) : null}
      {/* aria-live="polite": a new message is announced when the screen reader is idle, never interrupting. */}
      <div role="log" aria-live="polite" aria-label="Messages" style={{ minWidth: 0 }}>
        {messages.length === 0 ? (
          <p style={muted}>There are no messages to show yet.</p>
        ) : (
          <ol style={list}>
            {messages.map((m) => (
              <li key={m.messageId} style={item}>
                <div style={meta}>
                  <strong>{m.authorName ?? "Staff member"}</strong>
                  <time dateTime={m.createdAt}>{timeText(m.createdAt)}</time>
                  {m.edited ? <span>(edited)</span> : null}
                </div>
                <p style={bodyText}>{m.body}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
      {onRefresh && !example ? (
        <Button
          type="button"
          size="lg"
          tone="secondary"
          loading={refreshing}
          onClick={onRefresh}
          style={{ minHeight: "2.75rem", alignSelf: "flex-start" }}
        >
          Refresh
        </Button>
      ) : null}
    </section>
  );
}

const wrap: CSSProperties = { display: "flex", flexDirection: "column", gap: t.space3 };
const title: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.25rem",
  color: t.onSurface,
};
const muted: CSSProperties = { margin: 0, color: t.onSurfaceVariant, fontSize: "0.875rem" };
const list: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: t.space3,
};
const item: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.25rem" };
const meta: CSSProperties = {
  display: "flex",
  gap: t.space2,
  flexWrap: "wrap",
  color: t.onSurfaceVariant,
  fontSize: "0.8125rem",
};
const bodyText: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};
