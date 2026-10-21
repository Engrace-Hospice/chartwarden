import { Button, EmptyState, Glyph } from "@chartwarden/ui";
import type { JSX, KeyboardEvent, RefObject } from "react";
import type { ChannelSummary, ConversationFilter } from "./messaging-types";
import { channelKindLabel, channelLabel, initialsOf, relativeTime } from "./messaging-utils";
import { SkeletonRows } from "./skeleton-rows";

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
  /** Correlation id of the failed channel-list call, quoted in the load-failed state. */
  errorCorrelationId: string | null;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: ConversationFilter) => void;
  onSelect: (channelId: string) => void;
  onRetry: () => void;
  onNewConversation: () => void;
  /** WP 2.9: offered only to someone who may create department channels. */
  onNewDepartment?: () => void;
  /** WP 2.6: opens the sender's Scheduled list. */
  onShowScheduled?: () => void;
  /** Lets the page hand focus to the inbox (e.g. after leaving the access-ended notice). */
  headingRef?: RefObject<HTMLHeadingElement>;
}

export function ConversationInbox({
  channels,
  visibleChannels,
  activeId,
  query,
  filter,
  error,
  errorCorrelationId,
  onQueryChange,
  onFilterChange,
  onSelect,
  onRetry,
  onNewConversation,
  onNewDepartment,
  onShowScheduled,
  headingRef,
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

  /** WAI-ARIA tabs: one Tab stop (the selected tab), arrows/Home/End move and select. */
  function moveFilter(event: KeyboardEvent<HTMLDivElement>): void {
    const last = FILTERS.length - 1;
    const at = FILTERS.findIndex((item) => item.value === filter);
    const next =
      event.key === "ArrowRight"
        ? (at + 1) % FILTERS.length
        : event.key === "ArrowLeft"
          ? (at + last) % FILTERS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    const target = FILTERS[next];
    if (!target) return;
    event.preventDefault();
    onFilterChange(target.value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  }

  return (
    <aside className="wx-messaging-inbox" aria-label="Conversations">
      <header className="wx-messaging-inbox-header">
        <div>
          <h2 ref={headingRef} tabIndex={-1}>
            Conversations
          </h2>
          <span>{channels?.length ?? 0}</span>
        </div>
        <div className="wx-messaging-inbox-actions">
          {onShowScheduled ? (
            <Button
              size="lg"
              tone="secondary"
              onClick={onShowScheduled}
              aria-label="Scheduled messages"
            >
              <Glyph name="clock" size={15} /> Scheduled
            </Button>
          ) : null}
          {onNewDepartment ? (
            <Button
              size="lg"
              tone="secondary"
              onClick={onNewDepartment}
              aria-label="New department channel"
            >
              <Glyph name="users" size={15} /> Department
            </Button>
          ) : null}
          <Button size="lg" onClick={onNewConversation} aria-label="New conversation">
            <Glyph name="plus" size={15} /> New
          </Button>
        </div>
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
        <div
          className="wx-messaging-filters"
          role="tablist"
          aria-label="Conversation filters"
          onKeyDown={moveFilter}
        >
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={filter === item.value}
              tabIndex={filter === item.value ? 0 : -1}
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
          {errorCorrelationId ? <small>Reference {errorCorrelationId}</small> : null}
          <Button size="sm" tone="secondary" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : channels === null ? (
        <SkeletonRows label="Loading conversations" className="wx-messaging-list-state" />
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
                    <span
                      className="wx-messaging-mention"
                      aria-label={`${channel.mentionCount} unread ${
                        channel.mentionCount === 1 ? "mention" : "mentions"
                      }`}
                    >
                      @{channel.mentionCount > 9 ? "9+" : channel.mentionCount}
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
