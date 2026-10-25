// M36 WP 6.7 (ADR-0099 D4, D5) - the family contact's conversation: the messages (oldest first), a Refresh button, and a plain-text send box. PRESENTATIONAL
// except for the draft. Message text is rendered as a React text node (nothing is parsed as markup, nothing becomes a link), with line breaks kept by CSS.
// Nothing here polls: the contact refreshes by pressing Refresh or by sending (D5: no real time, no typing indicator, no presence).
import {
  FAMILY_MESSAGE_MAX_CHARS,
  type FamilyContactMessageDto,
  type FamilyMode,
} from "@chartwarden/types";
import { Button, t } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { mutedStyle, tapStyle } from "./family-contact-frame";
import { ft } from "./family-text";

export type SendOutcome = "ok" | "closed" | "limited" | "failed";

const timeText = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
};

export interface FamilyConversationProps {
  readonly mode: FamilyMode;
  readonly closed: boolean;
  readonly messages: readonly FamilyContactMessageDto[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly refreshing: boolean;
  readonly refreshFailed: boolean;
  readonly onRefresh: () => void;
  readonly onMore: () => void;
  readonly onSend: (body: string) => Promise<SendOutcome>;
}

const SEND_NOTICE: Readonly<Record<Exclude<SendOutcome, "ok">, Parameters<typeof ft>[0]>> = {
  closed: "family.send.closed",
  limited: "family.send.limited",
  failed: "family.send.failed",
};

function Composer({
  closed,
  onSend,
}: Pick<FamilyConversationProps, "closed" | "onSend">): JSX.Element {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const inFlight = useRef(false);
  const over = draft.length > FAMILY_MESSAGE_MAX_CHARS;

  async function submit(): Promise<void> {
    if (inFlight.current) return;
    if (draft.trim() === "") {
      setProblem(ft("family.send.empty"));
      return;
    }
    if (over) {
      setProblem(ft("family.send.tooLong", { max: FAMILY_MESSAGE_MAX_CHARS }));
      return;
    }
    inFlight.current = true;
    setSending(true);
    setProblem(null);
    setNotice(null);
    const outcome = await onSend(draft);
    inFlight.current = false;
    setSending(false);
    if (outcome === "ok") {
      setDraft("");
      setNotice(ft("family.send.sent"));
    } else {
      setProblem(ft(SEND_NOTICE[outcome]));
    }
  }

  if (closed) return <p style={mutedStyle}>{ft("family.thread.closed")}</p>;
  return (
    <form
      style={formStyle}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="family-message" style={labelStyle}>
        {ft("family.send.label")}
      </label>
      <textarea
        id="family-message"
        rows={5}
        value={draft}
        readOnly={sending}
        aria-invalid={over || problem !== null || undefined}
        aria-describedby="family-counter family-send-status"
        onChange={(e) => {
          setProblem(null);
          setDraft(e.target.value);
        }}
        style={textareaStyle}
      />
      <div
        id="family-counter"
        style={{ ...mutedStyle, color: over ? t.error : t.onSurfaceVariant }}
      >
        {ft("family.send.counter", { n: draft.length, max: FAMILY_MESSAGE_MAX_CHARS })}
      </div>
      <output id="family-send-status" aria-live="polite" style={statusStyle}>
        {problem ?? notice}
      </output>
      <Button type="submit" size="lg" style={tapStyle} loading={sending} disabled={sending}>
        {sending ? ft("family.send.sending") : ft("family.send.button")}
      </Button>
    </form>
  );
}

export function FamilyConversation(props: FamilyConversationProps): JSX.Element {
  const { mode, messages, hasMore, loadingMore, refreshing, refreshFailed } = props;
  const bereaved = mode === "bereavement";
  return (
    <section aria-labelledby="family-thread-heading" style={wrap}>
      <h2 id="family-thread-heading" style={subtitleStyle}>
        {bereaved ? ft("family.bereavement.heading") : ft("family.thread.heading")}
      </h2>
      <p style={mutedStyle}>
        {bereaved ? ft("family.bereavement.intro") : ft("family.thread.intro")}
      </p>
      {refreshFailed ? (
        <p role="alert" style={mutedStyle}>
          {ft("family.thread.refreshFailed")}
        </p>
      ) : null}
      <div
        role="log"
        aria-live="polite"
        aria-label={ft("family.thread.log")}
        style={{ minWidth: 0 }}
      >
        {messages.length === 0 ? (
          <p style={mutedStyle}>
            {bereaved ? ft("family.bereavement.empty") : ft("family.thread.empty")}
          </p>
        ) : (
          <ol style={list}>
            {messages.map((m) => (
              <li key={m.messageId} style={m.from === "you" ? mineItem : theirItem}>
                <div style={meta}>
                  <strong>
                    {m.from === "you"
                      ? ft("family.message.you")
                      : bereaved
                        ? ft("family.bereavement.message.careTeam")
                        : ft("family.message.careTeam")}
                  </strong>
                  <time dateTime={m.createdAt}>{timeText(m.createdAt)}</time>
                </div>
                <p style={bodyText}>{m.body}</p>
                {m.from === "you" && m.receivedByCareTeam ? (
                  <span style={meta}>{ft("family.message.received")}</span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
      {hasMore ? (
        <Button
          type="button"
          size="lg"
          tone="secondary"
          style={tapStyle}
          disabled={loadingMore}
          onClick={props.onMore}
        >
          {loadingMore ? ft("family.thread.moreBusy") : ft("family.thread.more")}
        </Button>
      ) : null}
      <Button
        type="button"
        size="lg"
        tone="secondary"
        style={tapStyle}
        aria-busy={refreshing || undefined}
        disabled={refreshing}
        onClick={props.onRefresh}
      >
        {refreshing ? ft("family.refreshing") : ft("family.refresh")}
      </Button>
      <Composer closed={props.closed} onSend={props.onSend} />
    </section>
  );
}

const wrap: CSSProperties = { display: "flex", flexDirection: "column", gap: t.space3 };
const subtitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.125rem",
  color: t.onSurface,
};
const list: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: t.space3,
};
const baseItem: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  padding: t.space3,
  borderRadius: t.radiusMd,
  border: `1px solid ${t.outlineVariant}`,
};
const mineItem: CSSProperties = { ...baseItem, background: t.primaryTint };
const theirItem: CSSProperties = { ...baseItem, background: t.surfaceLowest };
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
const formStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: t.space2 };
const labelStyle: CSSProperties = { color: t.onSurface, fontWeight: 600 };
const textareaStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  minHeight: "7rem",
  padding: t.space3,
  font: "inherit",
  fontSize: "1rem",
  color: t.onSurface,
  background: t.surfaceLowest,
  border: `1px solid ${t.outline}`,
  borderRadius: t.radiusMd,
};
const statusStyle: CSSProperties = {
  display: "block",
  minHeight: "1.25rem",
  color: t.onSurface,
  fontSize: "0.9375rem",
};
