// WP 2.3: what the composer shows after the sender picks someone who is not in the conversation.
//
// WORDING IS PROVISIONAL pending clinical-lead sign-off (docs/messaging-hub/03-phases-0-to-3.md, WP 2.3 note).
// A sender who may add members is asked once; everyone else only learns the person is not in the conversation.
// Nothing here sends thread content anywhere: adding is the existing member-management route, which is also the
// authority, so a stale `canAdd` can at worst produce a refused request (reported below), never access.
import { Button, useApiClient } from "@wardenx/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { NonMemberOption } from "./messaging-types";

interface NonMemberMentionPromptProps {
  readonly channelId: string;
  readonly person: NonMemberOption;
  readonly canAdd: boolean;
  /** The person is now a member: the composer turns the pending `@name` into a real mention. */
  readonly onAdded: (person: NonMemberOption) => void;
  readonly onDismiss: () => void;
}

export function NonMemberMentionPrompt({
  channelId,
  person,
  canAdd,
  onAdded,
  onDismiss,
}: NonMemberMentionPromptProps): JSX.Element {
  const client = useApiClient();
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState(false);

  async function add(): Promise<void> {
    setAdding(true);
    setFailed(false);
    try {
      const { error } = await client.POST("/api/v1/messaging/channels/{id}/members", {
        params: { path: { id: channelId } },
        body: { userId: person.entityId },
      });
      if (error) {
        setFailed(true);
        return;
      }
      onAdded(person);
    } catch {
      setFailed(true);
    } finally {
      setAdding(false);
    }
  }

  return (
    <section
      className="wx-mention-menu wx-mention-add"
      aria-label="Mention outside this conversation"
    >
      {canAdd ? (
        <>
          <span className="wx-mention-state">Add {person.displayName} to this conversation?</span>
          <span className="wx-mention-state">They will be able to read its earlier messages.</span>
          {failed ? (
            <span className="wx-mention-state" role="alert">
              Could not add {person.displayName}. Check your access and try again.
            </span>
          ) : null}
          <div className="wx-mention-add-actions">
            <Button
              type="button"
              size="sm"
              onClick={() => void add()}
              loading={adding}
              disabled={adding}
            >
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
