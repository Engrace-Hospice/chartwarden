// M36 WP 2.8 - a list of editable saved replies with an add form: used for "My saved replies" (personal) and, for a
// template manager, "Organization templates" (shared). The caller supplies the three writes, so this component never
// knows which scope it is editing and the server stays the only authority on who may.
import { Button, ConfirmDialog, EmptyState, InlineAlert, Panel } from "@wardenx/ui";
import { useState } from "react";
import type { JSX } from "react";
import { CATEGORY_LABEL, type ReplyDraft, type SavedReply } from "./saved-replies-types";
import { SavedReplyForm } from "./saved-reply-form";

export interface ReplyWrites {
  /** Each resolves to null on success or the text to show. */
  readonly create: (draft: ReplyDraft, idempotencyKey: string) => Promise<string | null>;
  readonly update: (id: string, draft: ReplyDraft) => Promise<string | null>;
  readonly remove: (id: string) => Promise<string | null>;
}

export interface SavedReplySectionProps {
  readonly title: string;
  readonly description: string;
  readonly emptyText: string;
  readonly items: readonly SavedReply[];
  readonly writes: ReplyWrites;
}

export function SavedReplySection({
  title,
  description,
  emptyText,
  items,
  writes,
}: SavedReplySectionProps): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SavedReply | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function confirmDelete(): Promise<void> {
    if (!deleting) return;
    setDeletePending(true);
    let failure: string | null;
    try {
      failure = await writes.remove(deleting.id);
    } catch {
      failure = "Could not delete this reply. Check your connection and try again.";
    } finally {
      setDeletePending(false);
    }
    if (failure) setDeleteError(failure);
    else {
      setDeleting(null);
      setDeleteError(null);
    }
  }

  return (
    <Panel title={title} description={description} icon="scroll">
      {items.length === 0 ? (
        <EmptyState title="Nothing here yet" description={emptyText} />
      ) : (
        <ul className="wx-saved-reply-list">
          {items.map((item) =>
            editing === item.id ? (
              <li key={item.id}>
                <SavedReplyForm
                  heading={`Edit ${item.title}`}
                  submitLabel="Save changes"
                  initial={{ title: item.title, body: item.body, category: item.category }}
                  onSubmit={async (draft) => {
                    const failure = await writes.update(item.id, draft);
                    if (!failure) setEditing(null);
                    return failure;
                  }}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <li key={item.id} className="wx-saved-reply-row">
                <strong>{item.title}</strong>
                <small>{CATEGORY_LABEL[item.category]}</small>
                <p>{item.body}</p>
                <div className="wx-saved-reply-actions">
                  <Button
                    type="button"
                    tone="secondary"
                    aria-label={`Edit ${item.title}`}
                    onClick={() => setEditing(item.id)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    tone="danger"
                    aria-label={`Delete ${item.title}`}
                    onClick={() => {
                      setDeleteError(null);
                      setDeleting(item);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      <SavedReplyForm
        heading={`Add to ${title}`}
        submitLabel="Add reply"
        onSubmit={writes.create}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this reply?"
        description={
          <>
            <span>
              &ldquo;{deleting?.title}&rdquo; will no longer appear in anyone&rsquo;s saved replies.
              Messages already sent are not changed.
            </span>
            {deleteError ? <InlineAlert tone="error">{deleteError}</InlineAlert> : null}
          </>
        }
        confirmLabel="Delete"
        tone="danger"
        pending={deletePending}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </Panel>
  );
}
