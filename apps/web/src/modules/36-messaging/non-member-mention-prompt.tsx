// WP 2.3: what the composer shows after the sender picks someone who is not in the conversation.
//
// WORDING IS PROVISIONAL pending clinical-lead sign-off (docs/messaging-hub/03-phases-0-to-3.md, WP 2.3 note).
// A sender who may add members is asked once; everyone else only learns the person is not in the conversation.
// Nothing here sends thread content anywhere: adding is the existing member-management route, which is also the
// authority, so a stale `canAdd` can at worst produce a refused request (reported below), never access.
import { Button } from "@wardenx/ui";
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { NonMemberOption } from "./messaging-types";

interface NonMemberMentionPromptProps {
  /** The person picked from outside the conversation, or null when no prompt is showing (the region stays mounted). */
  readonly person: NonMemberOption | null;
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
  // The Add button is the first child of the actions row (the shared Button takes no ref under React 18).
  const addActions = useRef<HTMLDivElement>(null);
  // A failed add disables-then-enables the Add button, which drops focus: put it back on Add.
  useEffect(() => {
    if (failed) (addActions.current?.firstElementChild as HTMLElement | null)?.focus();
  }, [failed]);
  // The live region is always in the page, so its text is announced when it fills in (a region inserted with its text is not).
  return (
    // biome-ignore lint/a11y/useSemanticElements: <output> allows phrasing content only; the prompt holds buttons.
    <div
      role="status"
      aria-label="Mention outside this conversation"
      style={{ display: "contents" }}
    >
      {person ? promptBody() : null}
    </div>
  );

  function promptBody(): JSX.Element {
    const who = person as NonMemberOption;
    return (
      <section
        className="wx-mention-menu wx-mention-add"
        aria-label="Add to conversation"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || adding) return;
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }}
      >
        {added ? (
          <>
            <span className="wx-mention-state">
              {who.displayName} was added to this conversation. Type @ again to mention them.
            </span>
            <div className="wx-mention-add-actions">
              <Button type="button" tone="tertiary" size="sm" onClick={onDismiss}>
                Dismiss
              </Button>
            </div>
          </>
        ) : canAdd ? (
          <>
            <span className="wx-mention-state">Add {who.displayName} to this conversation?</span>
            <span className="wx-mention-state">
              They will be able to read its earlier messages.
            </span>
            {failed ? (
              <span className="wx-mention-state" role="alert">
                Could not add {who.displayName}. Check your access and try again.
              </span>
            ) : null}
            <div ref={addActions} className="wx-mention-add-actions">
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
            <span className="wx-mention-state">{who.displayName} is not in this conversation</span>
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
}
