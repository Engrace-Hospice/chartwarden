// WP 3.6 - "IDG discussions" in the patient-context aside: the care-team channel's root messages linked to an IDG
// meeting. A pure read view; opening one opens its thread. It never changes the meeting or the plan of care.
import type { JSX } from "react";
import { IDG_WORDING as W } from "./idg-wording";
import type { Message } from "./messaging-types";
import { relativeTime } from "./messaging-utils";
import { useIdgDiscussions } from "./use-idg-discussions";

const EXCERPT_CHARS = 120;

function excerpt(message: Message): string {
  const text = message.body.replace(/\s+/g, " ").trim();
  if (!text) return W.noText;
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text;
}

export interface IdgDiscussionsSectionProps {
  readonly channelId: string;
  /** Opens the discussion's thread in the conversation (the thread panel's openThread). */
  readonly onOpenThread: (rootId: string, opener: HTMLElement) => void;
}

export function IdgDiscussionsSection({
  channelId,
  onOpenThread,
}: IdgDiscussionsSectionProps): JSX.Element | null {
  const state = useIdgDiscussions(channelId);
  // Render nothing while loading: a tenant with IDG discussions off would otherwise flash the heading.
  if (state.kind === "disabled" || state.kind === "loading") return null;
  return (
    <section className="wx-messaging-idg" aria-label={W.title}>
      <h3>{W.title}</h3>
      {state.kind === "error" ? <p role="alert">{W.error}</p> : null}
      {state.kind === "ready" ? (
        <>
          <p>{W.notice}</p>
          {state.discussions.length === 0 ? <output>{W.empty}</output> : null}
          <ul>
            {state.discussions.map((message) => {
              const author = message.authorDisplayName ?? W.unknownAuthor;
              return (
                <li key={message.messageId}>
                  <strong>{author}</strong>{" "}
                  <time dateTime={message.createdAt}>{relativeTime(message.createdAt)}</time>
                  <p>{excerpt(message)}</p>
                  <small>{W.reply(message.replyCount ?? 0)}</small>{" "}
                  <button
                    type="button"
                    aria-label={W.openLabel(author)}
                    onClick={(event) => onOpenThread(message.messageId, event.currentTarget)}
                  >
                    {W.open}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
