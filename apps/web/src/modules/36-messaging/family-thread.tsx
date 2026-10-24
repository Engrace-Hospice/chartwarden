// M36 WP 6.7 (ADR-0099 D5, D6, D14) - the flat right-hand drawer of the Family lane: one contact's thread (oldest first), the reply composer and, for a holder of
// messaging.family.manage, the revoke / close / block actions. The composer ALWAYS carries the line that the contact can read the reply and that it is not a
// chart note, and the not-an-emergency notice stands wherever the contact is addressed. Message text is rendered as text only.
import {
  FAMILY_NOT_EMERGENCY_TEXT,
  type FamilyContactSummaryDto,
  type FamilyStaffMessageDto,
} from "@chartwarden/types";
import { Button } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { formatTime } from "./export-common";
import { FamilyGate, useFamilyFailureText } from "./family-failure";
import { FamilyManageActions } from "./family-manage-actions";
import { consentLabel, linkLabel } from "./family-row";
import { ft } from "./family-text";
import { MessagePromotionButton } from "./message-promotion-button";
import { useOnlineStatus } from "./offline-banner";
import { useFamilyActions, useFamilyThread } from "./use-family";

const REPLY_MAX_CHARS = 2000;

function Message({
  message,
  channelId,
}: { readonly message: FamilyStaffMessageDto; readonly channelId: string | null }): JSX.Element {
  const fromContact = message.from === "contact";
  const author = fromContact
    ? ft("family.thread.fromContact")
    : (message.authorName ?? ft("family.thread.fromStaffUnknown"));
  return (
    <li className="wx-family-msg" data-from={message.from}>
      <div className="wx-export-detail">
        <strong>{author}</strong>{" "}
        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
      </div>
      <p className="wx-family-msg-body">{message.body}</p>
      {channelId ? (
        <MessagePromotionButton
          channelId={channelId}
          messageId={message.messageId}
          authorName={author}
          patientLinked
        />
      ) : null}
    </li>
  );
}

function Composer({
  contact,
  canReply,
  onSent,
}: {
  readonly contact: FamilyContactSummaryDto;
  readonly canReply: boolean;
  readonly onSent: () => void;
}): JSX.Element {
  const actions = useFamilyActions();
  const failureText = useFamilyFailureText();
  const online = useOnlineStatus();
  const inFlight = useRef(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ readonly text: string; readonly error: boolean } | null>(
    null,
  );
  const blockedReason = contact.blocked
    ? ft("family.composer.blocked")
    : contact.closed
      ? ft("family.composer.closed")
      : null;

  const send = async (): Promise<void> => {
    if (inFlight.current || draft.trim() === "") return;
    inFlight.current = true;
    setBusy(true);
    setStatus(null);
    const result = await actions.reply(contact.contactId, draft);
    inFlight.current = false;
    setBusy(false);
    if (result.kind === "ok") {
      setDraft("");
      setStatus({ text: ft("family.composer.sent"), error: false });
      onSent();
      return;
    }
    const text = failureText(result, "reply");
    if (text) setStatus({ text, error: true });
  };

  return (
    <form
      className="wx-family-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <p className="wx-export-notice" role="note">
        {FAMILY_NOT_EMERGENCY_TEXT}
      </p>
      {blockedReason ? <p className="wx-export-detail">{blockedReason}</p> : null}
      {canReply ? null : <p className="wx-export-detail">{ft("family.composer.notOn")}</p>}
      {canReply && !blockedReason ? (
        <>
          <label htmlFor="family-reply" className="wx-export-title">
            {ft("family.composer.label", { name: contact.displayName })}
          </label>
          <textarea
            id="family-reply"
            rows={4}
            maxLength={REPLY_MAX_CHARS}
            value={draft}
            disabled={busy}
            aria-describedby="family-reply-persistent"
            onChange={(e) => setDraft(e.target.value)}
          />
        </>
      ) : null}
      {/* Persistent: rendered whatever the state of the composer, so it is never out of sight when a reply can be written. */}
      <p id="family-reply-persistent" className="wx-family-persistent">
        {ft("family.composer.persistent")}
      </p>
      <output
        className="wx-export-status"
        aria-live="polite"
        data-error={status?.error || undefined}
      >
        {status?.text}
      </output>
      {canReply && !blockedReason ? (
        <Button
          type="submit"
          tone="primary"
          size="lg"
          disabled={busy || !online || draft.trim() === ""}
        >
          {busy ? ft("family.composer.sending") : ft("family.composer.send")}
        </Button>
      ) : null}
    </form>
  );
}

export function FamilyThreadDrawer({
  contact,
  canManage,
  canReply,
  onClose,
  onChanged,
}: {
  readonly contact: FamilyContactSummaryDto;
  readonly canManage: boolean;
  /** False when the tenant flag is off: the backend would answer 404, so the composer says so instead of failing. */
  readonly canReply: boolean;
  readonly onClose: () => void;
  /** The list should be re-read (and say `text`) after a send or a manage action. */
  readonly onChanged: (text: string | null) => void;
}): JSX.Element {
  const { view, reload } = useFamilyThread(contact.contactId);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Opening a conversation moves focus to its heading, so a keyboard or screen-reader user lands in the drawer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus only when a different contact is opened
  useEffect(() => headingRef.current?.focus(), [contact.contactId]);
  return (
    <aside className="wx-family-drawer" aria-label={ft("family.thread.drawerLabel")}>
      <div className="wx-family-drawer-head">
        <h2 ref={headingRef} tabIndex={-1} className="wx-export-title">
          {contact.displayName} <span className="wx-export-detail">({contact.relationship})</span>
        </h2>
        <Button type="button" tone="secondary" size="lg" onClick={onClose}>
          {ft("family.thread.close")}
        </Button>
      </div>
      <p className="wx-export-detail">
        {ft("family.row.for", { patient: contact.patientName })} ·{" "}
        {ft("family.row.consent", { state: consentLabel(contact) })} ·{" "}
        {ft("family.row.link", { state: linkLabel(contact) })}
      </p>
      <p className="wx-export-detail">
        {contact.language
          ? ft("family.thread.language", { language: contact.language })
          : ft("family.row.languageUnknown")}
      </p>
      {canManage ? (
        <FamilyManageActions
          contact={contact}
          onChanged={(text) => {
            reload();
            onChanged(text);
          }}
        />
      ) : null}
      <FamilyGate
        view={view}
        retry={reload}
        failedText={ft("family.thread.loadFailed")}
        deniedText={ft("family.lane.denied")}
      >
        {(thread) =>
          thread.messages.length === 0 ? (
            <p className="wx-export-detail">{ft("family.thread.noMessages")}</p>
          ) : (
            <ol className="wx-family-msgs" aria-label={ft("family.thread.log")}>
              {thread.messages.map((m) => (
                <Message key={m.messageId} message={m} channelId={thread.contact.channelId} />
              ))}
            </ol>
          )
        }
      </FamilyGate>
      <Composer
        contact={contact}
        canReply={canReply}
        onSent={() => {
          reload();
          onChanged(null);
        }}
      />
    </aside>
  );
}
