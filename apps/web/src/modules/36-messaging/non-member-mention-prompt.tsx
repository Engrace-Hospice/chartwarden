// WP 2.3: what the composer shows after the sender picks someone who is not in the conversation.
//
// WORDING IS PROVISIONAL pending clinical-lead sign-off (docs/messaging-hub/03-phases-0-to-3.md, WP 2.3 note).
// A sender who may add members is asked once; everyone else only learns the person is not in the conversation.
// Nothing here sends thread content anywhere: adding is the existing member-management route, which is also the
// authority, so a stale `canAdd` can at worst produce a refused request (reported below), never access.
import { Button } from "@wardenx/ui";
import type { JSX } from "react";
import type { NonMemberOption } from "./messaging-types";

interface NonMemberMentionPromptProps {
  readonly person: NonMemberOption;
  readonly canAdd: boolean;
  /** The add is in flight (owned by the composer, so a remount cannot send a second one). */
  readonly adding: boolean;
  readonly failed: boolean;
  /** The add landed but the `@name` it was picked from is gone from the draft. */
  readonly added: boolean;
  readonly onAdd: () => void;
  readonly onDismiss: () => void;
}

export function NonMemberMentionPrompt({
  person,
  canAdd,
  adding,
  failed,
  added,
  onAdd,
  onDismiss,
}: NonMemberMentionPromptProps): JSX.Element {
  return (
    <section
      className="wx-mention-menu wx-mention-add"
      aria-label="Mention outside this conversation"
      // biome-ignore lint/a11y/useSemanticElements: <output> allows phrasing content only; the prompt holds buttons.
      role="status"
    >
      {added ? (
        <>
          <span className="wx-mention-state">
            {person.displayName} was added to this conversation. Type @ again to mention them.
          </span>
          <div className="wx-mention-add-actions">
            <Button type="button" tone="tertiary" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        </>
      ) : canAdd ? (
        <>
          <span className="wx-mention-state">Add {person.displayName} to this conversation?</span>
          <span className="wx-mention-state">They will be able to read its earlier messages.</span>
          {failed ? (
            <span className="wx-mention-state" role="alert">
              Could not add {person.displayName}. Check your access and try again.
            </span>
          ) : null}
          <div className="wx-mention-add-actions">
            <Button type="button" size="sm" onClick={onAdd} loading={adding} disabled={adding}>
              Add to conversation
            </Button>
            <Button type="button" tone="tertiary" size="sm" onClick={onDismiss} disabled={adding}>
              Not now
            </Button>
          </div>
        </>
      ) : (
        <>
          <span className="wx-mention-state">{person.displayName} is not in this conversation</span>
          <div className="wx-mention-add-actions">
            <Button type="button" tone="tertiary" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
