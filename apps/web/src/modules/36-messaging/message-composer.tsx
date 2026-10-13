// The composer area of ConversationThread: the read-only notice, or the draft sync notice plus the message form (moved
// out of it unchanged in WP 2.11 to keep that file under the line ceiling). State and effects stay in the thread; this
// only renders what it is given.
import { Button, Glyph } from "@wardenx/ui";
import type { FormEvent, JSX, KeyboardEvent, RefObject } from "react";
import { AttachButton, AttachmentChips } from "./attachment-composer";
import { ComposerFooter } from "./composer-footer";
import { DraftSyncNotice } from "./draft-conflict-prompt";
import { MentionMenu, mentionOptionId } from "./mention-menu";
import { activeMentionQuery, reconcileReferences } from "./mention-utils";
import type { ChannelSummary, MessageReferenceInput } from "./messaging-types";
import { channelLabel } from "./messaging-utils";
import { NonMemberMentionPrompt } from "./non-member-mention-prompt";
import { ScheduleSendButton } from "./schedule-send-button";
import { TemplatePicker } from "./template-picker";
import type { AttachmentUploads } from "./use-attachment-upload";
import type { useMentionPicker } from "./use-mention-picker";
import type { ServerDraftSync } from "./use-server-draft";

type MentionPicker = ReturnType<typeof useMentionPicker>;

export interface ThreadComposerProps {
  channel: ChannelSummary;
  composerHidden: boolean;
  loadError: string | null;
  serverDraft: ServerDraftSync;
  textareaRef: RefObject<HTMLTextAreaElement>;
  attachButtonRef: RefObject<HTMLButtonElement>;
  composingRef: { current: boolean };
  draft: string;
  setDraft: (draft: string) => void;
  draftReferences: MessageReferenceInput[];
  setDraftReferences: (references: MessageReferenceInput[]) => void;
  uploads: AttachmentUploads;
  sending: boolean;
  send: (event?: FormEvent) => Promise<void>;
  sendError: string | null;
  clearSendError: () => void;
  sendHint: string | null;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onInsertSavedReply: (text: string) => void;
  mentionQuery: MentionPicker["query"];
  setMentionQuery: MentionPicker["setQuery"];
  pendingAdd: MentionPicker["pendingAdd"];
  mentionAdding: MentionPicker["adding"];
  mentionAddFailed: MentionPicker["addFailed"];
  canAddMention: MentionPicker["canAdd"];
  mentionMenu: MentionPicker["menu"];
  addToConversation: MentionPicker["addToConversation"];
  dismissMentionAdd: MentionPicker["dismissMentionAdd"];
}

export function ThreadComposer({
  channel,
  composerHidden,
  loadError,
  serverDraft,
  textareaRef,
  attachButtonRef,
  composingRef,
  draft,
  setDraft,
  draftReferences,
  setDraftReferences,
  uploads,
  sending,
  send,
  sendError,
  clearSendError,
  sendHint,
  onKeyDown,
  onInsertSavedReply,
  mentionQuery,
  setMentionQuery,
  pendingAdd,
  mentionAdding,
  mentionAddFailed,
  canAddMention,
  mentionMenu,
  addToConversation,
  dismissMentionAdd,
}: ThreadComposerProps): JSX.Element {
  return composerHidden ? (
    <output className="wx-messaging-archived">
      <Glyph name="lock" size={16} />
      {channel.archivedAt
        ? "This conversation is archived. Message history remains read-only."
        : loadError
          ? "Messaging is unavailable until access can be verified."
          : "Only administrators can post announcements."}
    </output>
  ) : (
    <>
      <DraftSyncNotice sync={serverDraft} />
      <form className="wx-message-composer" onSubmit={(event) => void send(event)}>
        <label htmlFor="messaging-composer" className="sr-only">
          Message
        </label>
        <textarea
          ref={textareaRef}
          id="messaging-composer"
          aria-label="Message"
          rows={1}
          placeholder={`Message ${channelLabel(channel)}…`}
          value={draft}
          disabled={sending}
          aria-autocomplete="list"
          aria-controls={mentionQuery && !pendingAdd ? "messaging-mention-suggestions" : undefined}
          aria-activedescendant={
            mentionQuery &&
            !pendingAdd &&
            !mentionMenu.loading &&
            !mentionMenu.error &&
            mentionMenu.candidates.length > 0
              ? mentionOptionId(mentionMenu.activeIndex)
              : undefined
          }
          onChange={(event) => {
            const next = event.target.value;
            const nextReferences = reconcileReferences(draft, next, draftReferences);
            setDraftReferences(nextReferences);
            setDraft(next);
            const cursor = event.target.selectionStart ?? next.length;
            setMentionQuery(activeMentionQuery(next, cursor, nextReferences));
            dismissMentionAdd();
            if (sendError) clearSendError();
          }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
        />
        <AttachmentChips uploads={uploads} disabled={sending} attachButtonRef={attachButtonRef} />
        <AttachButton uploads={uploads} disabled={sending} buttonRef={attachButtonRef} />
        <TemplatePicker
          disabled={sending}
          onInsert={onInsertSavedReply}
          onClosed={() => textareaRef.current?.focus()}
        />
        <NonMemberMentionPrompt
          person={pendingAdd?.person ?? null}
          canAdd={canAddMention}
          adding={mentionAdding}
          failed={mentionAddFailed}
          added={pendingAdd?.stage === "added"}
          onAdd={() => void addToConversation()}
          onDismiss={() => {
            dismissMentionAdd();
            setMentionQuery(null);
            textareaRef.current?.focus();
          }}
        />
        {!pendingAdd && mentionQuery ? <MentionMenu {...mentionMenu} /> : null}
        <Button
          type="submit"
          size="lg"
          disabled={
            sending || (!draft.trim() && uploads.sendableIds.length === 0) || uploads.blocksSend
          }
          loading={sending}
          aria-label="Send"
          aria-describedby={sendHint ? "messaging-send-hint" : undefined}
        >
          <Glyph name="send" size={16} /> <span>Send</span>
        </Button>
        <ScheduleSendButton
          channelId={channel.channelId}
          text={draft}
          disabled={sending}
          hasMentions={draftReferences.length > 0}
          focusTargetId="messaging-composer"
          disabledReason={uploads.chips.length > 0 ? "Attachments cannot be scheduled." : undefined}
          onScheduled={() => {
            // The scheduled copy now owns the text; an empty draft also discards the server-side draft (WP 2.5).
            setDraft("");
            setDraftReferences([]);
          }}
        />
        <ComposerFooter sendHint={sendHint} sendError={sendError} sending={sending} />
      </form>
    </>
  );
}
