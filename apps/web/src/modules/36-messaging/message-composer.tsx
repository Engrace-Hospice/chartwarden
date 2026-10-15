// The composer area of ConversationThread: the read-only notice, or the draft sync notice plus the message form (moved
// out of it unchanged in WP 2.11 to keep that file under the line ceiling). State and effects stay in the thread; this
// only renders what it is given.
import type { RichBody, SbarIssue } from "@wardenx/types";
import { Button, Glyph } from "@wardenx/ui";
import { useEffect, useRef } from "react";
import type { FormEvent, JSX, KeyboardEvent, RefObject } from "react";
import { AttachButton, AttachmentChips } from "./attachment-composer";
import type { ClinicalLinkCandidateSource, DraftClinicalLink } from "./clinical-link-kinds";
import {
  ClinicalLinkPicker,
  ClinicalLinkTray,
  triggerIndex,
  useClinicalLinkPicker,
} from "./clinical-link-picker";
import { ComposerFooter } from "./composer-footer";
import { DraftSyncNotice } from "./draft-conflict-prompt";
import { MedicationQuestionButton } from "./medication-question-button";
import { MentionMenu, mentionOptionId } from "./mention-menu";
import { activeMentionQuery, reconcileReferences } from "./mention-utils";
import type { ChannelSummary, MessageReferenceInput } from "./messaging-types";
import { channelLabel } from "./messaging-utils";
import { NonMemberMentionPrompt } from "./non-member-mention-prompt";
import { PollCreateButton } from "./poll-create-button";
import { SbarFormDialog } from "./sbar-form-dialog";
import { sbarAllowedInChannel, sbarOfferedInChannel } from "./sbar-utils";
import { ScheduleSendButton } from "./schedule-send-button";
import { TemplatePicker } from "./template-picker";
import { UrgentMessageButton } from "./urgent-message-button";
import type { AttachmentUploads } from "./use-attachment-upload";
import type { useMentionPicker } from "./use-mention-picker";
import type { SbarCompose } from "./use-sbar-compose";
import { useSbarFlag, useSbarPolicy } from "./use-sbar-policy";
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
  /** WP 3.3: the SBAR form's state, the server's field errors for it, and how to send a finished SBAR body. */
  sbar: SbarCompose;
  sbarIssues: readonly SbarIssue[];
  onSendSbar: (body: RichBody) => void;
  /** WP 3.2: links chosen for this draft, and how to change them. */
  draftLinks: readonly DraftClinicalLink[];
  addDraftLink: (link: DraftClinicalLink) => void;
  removeDraftLink: (link: DraftClinicalLink) => void;
  /** Overrides the default candidate source (the owning modules' patient-scoped list routes). */
  linkCandidateSource?: ClinicalLinkCandidateSource;
  uploads: AttachmentUploads;
  sending: boolean;
  send: (event?: FormEvent) => Promise<void>;
  sendError: string | null;
  clearSendError: () => void;
  sendHint: string | null;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onInsertSavedReply: (text: string) => void;
  /** WP 2.10: a poll was posted; the thread reloads so it shows without waiting for the next poll. */
  onPollCreated: () => void;
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
  sbar,
  sbarIssues,
  onSendSbar,
  draftLinks,
  addDraftLink,
  removeDraftLink,
  linkCandidateSource,
  uploads,
  sending,
  send,
  sendError,
  clearSendError,
  sendHint,
  onKeyDown,
  onInsertSavedReply,
  onPollCreated,
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
  // WP 3.3: SBAR is offered when the flag is on, the channel kind allows it and the policy loads (the policy may also
  // require a care-team conversation). Anything else hides the item.
  const sbarFlag = useSbarFlag();
  const policyState = useSbarPolicy(sbarFlag && sbarAllowedInChannel(channel.kind));
  const sbarPolicy = policyState.status === "ready" ? policyState.policy : null;
  const sbarOffered =
    sbarPolicy !== null && sbarOfferedInChannel(channel.kind, sbarPolicy.requirePatientChannel);
  // "saved" is claimed only once the server confirmed exactly what the composer holds now.
  const sbarNote =
    serverDraft.saveFailed || serverDraft.saveGaveUp
      ? "SBAR draft (not saved)"
      : serverDraft.sbarSaved
        ? "SBAR draft saved"
        : "SBAR draft";
  const pickerToggleRef = useRef<HTMLButtonElement>(null);
  const closeSbar = (discard: boolean): void => {
    if (discard) sbar.finish();
    else sbar.hide();
    pickerToggleRef.current?.focus();
  };
  // Links need a patient scope: only a care-team conversation has one.
  const linkPicker = useClinicalLinkPicker(
    channel.kind === "care_team" ? channel.subjectId : null,
    linkCandidateSource,
  );
  // Where the `#`/`+` was typed, so closing the picker puts the caret back there instead of at the end.
  const triggerAtRef = useRef<number | null>(null);
  const pickerOpen = linkPicker.open;
  // The swallowed `#`/`+`, and whether a record was chosen: closing the picker without a choice gives the symbol back.
  const triggerCharRef = useRef<string | null>(null);
  const linkChosenRef = useRef(false);
  const pendingCaretRef = useRef<number | null>(null);
  const latestDraft = useRef({ draft, draftReferences });
  latestDraft.current = { draft, draftReferences };
  // A channel switch needs no reset here: ConversationThread is keyed by channel, so the picker remounts closed.
  useEffect(() => {
    if (pickerOpen) return;
    const at = triggerAtRef.current;
    const char = triggerCharRef.current;
    if (at !== null && char !== null && !linkChosenRef.current) {
      const { draft: current, draftReferences: refs } = latestDraft.current;
      const restored = current.slice(0, at) + char + current.slice(at);
      setDraftReferences(reconcileReferences(current, restored, refs));
      setDraft(restored);
      pendingCaretRef.current = at + char.length;
    }
    triggerAtRef.current = null;
    triggerCharRef.current = null;
    linkChosenRef.current = false;
  }, [pickerOpen, setDraft, setDraftReferences]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after the restored symbol lands in the textarea
  useEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === null) return;
    pendingCaretRef.current = null;
    textareaRef.current?.setSelectionRange(caret, caret);
  }, [draft]);
  function restoreComposerFocus(): void {
    const box = textareaRef.current;
    box?.focus();
    const at = triggerAtRef.current;
    if (box && at !== null) {
      const caret = Math.min(at, box.value.length);
      box.setSelectionRange(caret, caret);
    }
  }
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
            const typed = event.target.value;
            const cursorAt = event.target.selectionStart ?? typed.length;
            // `#` / `+` at the start of a word opens the link picker instead of landing in the text.
            // Not mid-composition (IME), and not a paste: only a typed character counts.
            const inputType = (event.nativeEvent as { inputType?: string }).inputType;
            const typedByHand =
              !composingRef.current && (inputType === undefined || inputType === "insertText");
            const trigger =
              linkPicker.enabled && typedByHand ? triggerIndex(draft, typed, cursorAt) : null;
            const next =
              trigger === null ? typed : typed.slice(0, trigger) + typed.slice(trigger + 1);
            if (trigger !== null) {
              triggerAtRef.current = trigger;
              triggerCharRef.current = typed.charAt(trigger);
              linkChosenRef.current = false;
              linkPicker.setOpen(true);
            }
            const nextReferences = reconcileReferences(draft, next, draftReferences);
            setDraftReferences(nextReferences);
            setDraft(next);
            const cursor = trigger === null ? cursorAt : trigger;
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
        <ClinicalLinkTray
          links={draftLinks}
          textEmpty={!draft.trim()}
          onRemove={(link) => {
            removeDraftLink(link);
            textareaRef.current?.focus();
          }}
        />
        <AttachmentChips uploads={uploads} disabled={sending} attachButtonRef={attachButtonRef} />
        <AttachButton uploads={uploads} disabled={sending} buttonRef={attachButtonRef} />
        <ClinicalLinkPicker
          picker={linkPicker}
          links={draftLinks}
          disabled={sending}
          onAdd={(link) => {
            linkChosenRef.current = true;
            addDraftLink(link);
          }}
          onClosed={restoreComposerFocus}
        />
        <TemplatePicker
          disabled={sending}
          onInsert={onInsertSavedReply}
          onClosed={() => textareaRef.current?.focus()}
          toggleRef={pickerToggleRef}
          onOpened={() => {
            if (policyState.status === "transient") policyState.reload();
          }}
          {...(sbarOffered
            ? {
                onChooseSbar: () => {
                  clearSendError();
                  sbar.show();
                },
              }
            : {})}
        />
        {sbarOffered && sbarPolicy && !sbar.open && sbar.draft !== null ? (
          <span className="wx-sbar-draft-note">
            <Glyph name="file-text" size={14} />
            <output aria-label={sbarNote}>{sbarNote}</output>
            <Button
              type="button"
              tone="secondary"
              disabled={sending}
              aria-label="Open SBAR draft"
              onClick={() => {
                clearSendError();
                sbar.show();
              }}
            >
              Open
            </Button>
          </span>
        ) : null}
        <PollCreateButton
          channelId={channel.channelId}
          kind={channel.kind}
          disabled={sending}
          onCreated={onPollCreated}
        />
        <MedicationQuestionButton
          channelId={channel.channelId}
          kind={channel.kind}
          disabled={sending}
          onSent={onPollCreated}
        />
        <UrgentMessageButton
          channelId={channel.channelId}
          kind={channel.kind}
          disabled={sending}
          onThreadChanged={onPollCreated}
          statusResetKey={draft}
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
      {sbarOffered && sbarPolicy && sbar.open ? (
        <SbarFormDialog
          policy={sbarPolicy}
          values={sbar.values}
          onChange={sbar.setValues}
          sending={sending}
          serverIssues={sbarIssues}
          onEdit={clearSendError}
          sendError={sendError}
          onSubmit={onSendSbar}
          onCancel={() => closeSbar(false)}
          onDiscard={() => closeSbar(true)}
        />
      ) : null}
    </>
  );
}
