import { Button, EmptyState, Glyph, LoadingSpinner } from "@wardenx/ui";
import type { JSX, KeyboardEvent } from "react";
import type { ChannelSummary, ConversationFilter } from "./messaging-types";
import { channelKindLabel, channelLabel, initialsOf, relativeTime } from "./messaging-utils";

const FILTERS: readonly { value: ConversationFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "mentions", label: "Mentions" },
  { value: "dm", label: "Direct" },
  { value: "care_team", label: "Care Teams" },
  { value: "archived", label: "Archived" },
];

export interface ConversationInboxProps {
  channels: ChannelSummary[] | null;
  visibleChannels: ChannelSummary[];
  activeId: string | null;
  query: string;
  filter: ConversationFilter;
  error: string | null;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: ConversationFilter) => void;
  onSelect: (channelId: string) => void;
  onRetry: () => void;
  onNewConversation: () => void;
}

export function ConversationInbox({
  channels,
  visibleChannels,
  activeId,
  query,
  filter,
  error,
  onQueryChange,
  onFilterChange,
  onSelect,
  onRetry,
  onNewConversation,
}: ConversationInboxProps): JSX.Element {
  function moveFocus(event: KeyboardEvent<HTMLUListElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-channel-id]"),
    ];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0 || items.length === 0) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    items[(current + delta + items.length) % items.length]?.focus();
  }

  return (
    <aside className="wx-messaging-inbox" aria-label="Conversations">
      <header className="wx-messaging-inbox-header">
        <div>
          <h2>Conversations</h2>
          <span>{channels?.length ?? 0}</span>
        </div>
        <Button size="sm" onClick={onNewConversation} aria-label="New conversation">
          <Glyph name="plus" size={15} /> New
        </Button>
      </header>

      <div className="wx-messaging-inbox-tools">
        <label className="wx-messaging-search">
          <Glyph name="search" size={16} />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
          />
        </label>
        <div className="wx-messaging-filters" role="tablist" aria-label="Conversation filters">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={filter === item.value}
              onClick={() => onFilterChange(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error && channels === null ? (
        <div className="wx-messaging-list-state" role="alert">
          <Glyph name="alert-circle" size={22} />
          <strong>Conversations could not be loaded</strong>
          <span>{error}</span>
          <Button size="sm" tone="secondary" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : channels === null ? (
        <output className="wx-messaging-list-state">
          <LoadingSpinner label="Loading conversations" />
        </output>
      ) : visibleChannels.length === 0 ? (
        <div className="wx-messaging-list-state">
          <EmptyState
            title={channels.length === 0 ? "No conversations yet" : "No matching conversations"}
            description={
              channels.length === 0
                ? "Start a direct message or open a patient care-team conversation."
                : "Try another search or filter."
            }
            action={
              channels.length === 0 ? (
                <Button size="sm" onClick={onNewConversation}>
                  Start a conversation
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <ul className="wx-messaging-conversation-list" onKeyDown={moveFocus}>
          {visibleChannels.map((channel) => {
            const active = channel.channelId === activeId;
            const label = channelLabel(channel);
            const preview = channel.lastMessage
              ? `${channel.lastMessage.authorDisplayName ? `${channel.lastMessage.authorDisplayName}: ` : ""}${channel.lastMessage.preview}`
              : channel.participantRoles.join(" · ") || channelKindLabel(channel.kind);
            return (
              <li key={channel.channelId}>
                <button
                  type="button"
                  data-channel-id={channel.channelId}
                  className={active ? "is-active" : undefined}
                  aria-current={active ? "true" : undefined}
                  aria-label={`${label}${channel.unreadCount > 0 ? `, ${channel.unreadCount} unread` : ""}`}
                  onClick={() => onSelect(channel.channelId)}
                >
                  <span
                    className={`wx-messaging-avatar wx-kind-${channel.kind}`}
                    aria-hidden="true"
                  >
                    {channel.kind === "care_team" ? (
                      <Glyph name="users" size={17} />
                    ) : (
                      initialsOf(label)
                    )}
                  </span>
                  <span className="wx-messaging-row-copy">
                    <span className="wx-messaging-row-title">
                      <strong>{label}</strong>
                      <time dateTime={channel.lastActivityAt} title={channel.lastActivityAt}>
                        {relativeTime(channel.lastActivityAt)}
                      </time>
                    </span>
                    <span className="wx-messaging-row-preview">{preview}</span>
                    {channel.archivedAt ? <small>Archived · Read only</small> : null}
                  </span>
                  {channel.unreadCount > 0 ? (
                    <span className="wx-messaging-unread" aria-hidden="true">
                      {channel.unreadCount > 99 ? "99+" : channel.unreadCount}
                    </span>
                  ) : null}
                  {channel.mentionCount > 0 ? (
                    <span className="sr-only">
                      {channel.mentionCount} unread{" "}
                      {channel.mentionCount === 1 ? "mention" : "mentions"}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && channels !== null ? (
        <output className="wx-messaging-refresh-warning">
          Refresh paused ·{" "}
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </output>
      ) : null}
    </aside>
  );
}
