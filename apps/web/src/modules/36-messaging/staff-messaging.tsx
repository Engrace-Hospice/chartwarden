import { BACKGROUND_REQUEST_HEADERS, EmptyState, PageHeader, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation } from "react-router-dom";
import { useSession } from "../../shell";
import { AccessEndedNotice } from "./access-ended-notice";
import { ConversationInbox } from "./conversation-inbox";
import { ConversationThread } from "./conversation-thread";
import { DepartmentChannelDialog } from "./department-channel-dialog";
import { GlobalSearch } from "./global-search";
import type { ChannelSummary, ConversationFilter } from "./messaging-types";
import {
  NARROW_MESSAGING_QUERY,
  channelKindLabel,
  channelLabel,
  correlationIdOf,
} from "./messaging-utils";
import { NewConversationDialog } from "./new-conversation-dialog";
import { OfflineBanner } from "./offline-banner";
import { RealtimeBanner, useRealtimeDegraded } from "./realtime-banner";
import { ScheduledMessagesDialog } from "./scheduled-messages-dialog";
import { useFocusThreadAfterPick } from "./use-focus-thread-after-pick";
import { useMessagingRealtime } from "./use-messaging-realtime";
import { useOutbox } from "./use-outbox";
import { type LiveHint, POLL_INTERVAL_MS, pushLiveHint } from "./use-thread";
import "./messaging-layout.css";
import "./inbox.css";
import "./thread.css";
import "./message-list.css";
import "./patient-context.css";
import "./composer.css";
import "./new-conversation.css";
import "./messaging-responsive.css";
import "./composer-attachments.css";

const CHANNEL_POLL_INTERVAL_MS = 15_000;
const MAX_CHANNEL_POLL_INTERVAL_MS = 60_000;
const REALTIME_CHANNEL_POLL_INTERVAL_MS = 120_000;

function useNarrowMessagingLayout(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia(NARROW_MESSAGING_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(NARROW_MESSAGING_QUERY);
    const update = (): void => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

function normalizeChannel(
  channel: Partial<ChannelSummary> & Pick<ChannelSummary, "channelId" | "kind">,
): ChannelSummary {
  const lastMessage = channel.lastMessage ?? null;
  return {
    channelId: channel.channelId,
    kind: channel.kind,
    title: channel.title ?? null,
    subjectId: channel.subjectId ?? null,
    archivedAt: channel.archivedAt ?? null,
    unreadCount: channel.unreadCount ?? 0,
    mentionCount: channel.mentionCount ?? 0,
    participantRoles: channel.participantRoles ?? [],
    lastActivityAt:
      channel.lastActivityAt ??
      lastMessage?.createdAt ??
      channel.archivedAt ??
      "1970-01-01T00:00:00.000Z",
    lastMessage,
  };
}

export function StaffMessaging(): JSX.Element {
  const session = useSession();
  const location = useLocation();
  const organizationId = session?.organizationId ?? "";
  const userId = session?.userId ?? "";
  const requestedChannelId =
    location.state &&
    typeof location.state === "object" &&
    "messagingChannelId" in location.state &&
    typeof location.state.messagingChannelId === "string"
      ? location.state.messagingChannelId
      : new URLSearchParams(location.search).get("channelId");
  const requestedMessageId = new URLSearchParams(location.search).get("messageId");
  return (
    <OrganizationStaffMessaging
      key={`${organizationId}:${userId}`}
      organizationId={organizationId}
      organizationName={session?.organizationName ?? "Active organization"}
      userId={userId}
      userDisplayName={session?.displayName ?? "You"}
      canAnnounce={session?.permissions?.includes("messaging.announce") ?? false}
      canManageMembers={session?.permissions?.includes("messaging.manage_members") ?? false}
      requestedChannelId={requestedChannelId}
      requestedMessageId={requestedMessageId}
      requestedScheduled={new URLSearchParams(location.search).get("scheduled") === "1"}
    />
  );
}

/** The organization/actor key is the synchronous tenant-leak boundary. React destroys every
 * PHI-bearing channel, message, patient, draft, dialog, request guard, and polling state before the
 * next organization can render. */
function OrganizationStaffMessaging({
  organizationId,
  organizationName,
  userId,
  userDisplayName,
  canAnnounce,
  canManageMembers,
  requestedChannelId,
  requestedMessageId,
  requestedScheduled,
}: {
  organizationId: string;
  organizationName: string;
  userId: string;
  userDisplayName: string;
  canAnnounce: boolean;
  canManageMembers: boolean;
  requestedChannelId: string | null;
  requestedMessageId: string | null;
  /** WP 2.6: `?scheduled=1` (the "not sent" notification's link) opens the Scheduled list. */
  requestedScheduled: boolean;
}): JSX.Element {
  const client = useApiClient();
  // Above the per-channel thread (keyed below, so it unmounts on every switch): the queue must outlive it.
  const outbox = useOutbox();
  const narrow = useNarrowMessagingLayout();
  const [channels, setChannels] = useState<ChannelSummary[] | null>(null);
  const channelsRef = useRef<ChannelSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCorrelationId, setErrorCorrelationId] = useState<string | null>(null);
  // WP 2.11: set when the open conversation was revoked, so the pane says so (never the title); cleared on the next pick.
  const [accessEnded, setAccessEnded] = useState(false);
  // Leaving the access-ended notice or a thread (Back) hands focus to the inbox heading once the inbox is shown again.
  const inboxHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusInboxAfterNotice = useRef(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => {
    if (accessEnded || activeId !== null || !focusInboxAfterNotice.current) return;
    focusInboxAfterNotice.current = false;
    inboxHeadingRef.current?.focus();
  }, [accessEnded, activeId]);
  const threadHeadingRef = useRef<HTMLHeadingElement>(null);
  const pickConversation = useFocusThreadAfterPick({
    activeId,
    narrow,
    headingRef: threadHeadingRef,
    setActiveId,
  });
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [departmentOpen, setDepartmentOpen] = useState(false);
  // WP 2.7b: the message a global-search hit asked the thread to open at (wins over the route's own anchor).
  const [searchAnchor, setSearchAnchor] = useState<{ channelId: string; messageId: string } | null>(
    null,
  );
  const [scheduledOpen, setScheduledOpen] = useState(requestedScheduled);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const generationRef = useRef(0);
  const channelLoadInFlight = useRef<Promise<boolean> | null>(null);

  const loadChannels = useCallback(
    (background = false): Promise<boolean> => {
      if (channelLoadInFlight.current) return channelLoadInFlight.current;
      const generation = generationRef.current;
      const response = background
        ? client.GET("/api/v1/messaging/channels", { headers: BACKGROUND_REQUEST_HEADERS })
        : client.GET("/api/v1/messaging/channels");
      const request = response
        .then(({ data, error: loadError }) => {
          if (generation !== generationRef.current) return false;
          if (loadError) {
            setError(
              "Secure Messaging could not refresh. Your existing view has not been replaced.",
            );
            setErrorCorrelationId(correlationIdOf(loadError));
            if (!background && channelsRef.current === null) setChannels(null);
            return false;
          }
          const list = ((data?.channels ?? []) as ChannelSummary[])
            .map(normalizeChannel)
            .sort(
              (a, b) =>
                b.lastActivityAt.localeCompare(a.lastActivityAt) ||
                a.channelId.localeCompare(b.channelId),
            );
          channelsRef.current = list;
          setChannels(list);
          setError(null);
          setErrorCorrelationId(null);
          setActiveId((current) => {
            if (current && list.some((channel) => channel.channelId === current)) return current;
            if (
              requestedChannelId &&
              list.some((channel) => channel.channelId === requestedChannelId)
            ) {
              return requestedChannelId;
            }
            return narrow ? null : (list[0]?.channelId ?? null);
          });
          return true;
        })
        .catch(() => {
          if (generation === generationRef.current) {
            setError("Secure Messaging is temporarily unavailable. Please retry.");
          }
          return false;
        })
        .finally(() => {
          if (channelLoadInFlight.current === request) channelLoadInFlight.current = null;
        });
      channelLoadInFlight.current = request;
      return request;
    },
    [client, narrow, requestedChannelId],
  );

  useEffect(() => {
    generationRef.current += 1;
    void loadChannels();
    return () => {
      generationRef.current += 1;
      channelLoadInFlight.current = null;
    };
  }, [loadChannels]);

  // ADR-0054 hints: a hint (or a reconnect) refreshes the list at once and nudges the open thread. If a load is
  // already in flight it may predate the change, so wait for it and read again.
  const [liveToken, setLiveToken] = useState(0);
  // WP 2.2: which message the last hint named (and its parent), so an open thread panel reads only when concerned.
  const [liveHint, setLiveHint] = useState<LiveHint | null>(null);
  const activeIdRef = useRef<string | null>(null);
  // Any way of landing on a conversation (pick, new conversation, deep link, auto-select) ends the notice.
  useEffect(() => {
    if (activeId !== null) setAccessEnded(false);
  }, [activeId]);
  activeIdRef.current = activeId;
  const refreshFromHint = useCallback(async (): Promise<void> => {
    const generation = generationRef.current;
    if (channelLoadInFlight.current) await channelLoadInFlight.current;
    // Unmounted (or the org/user changed) while waiting: the cleanup bumped the generation, so do not read.
    if (generation !== generationRef.current) return;
    await loadChannels(true);
  }, [loadChannels]);
  // An in-flight poll may predate the archive POST, so wait it out and read again rather than coalescing onto it.
  const refreshAfterChange = useCallback(async (): Promise<boolean> => {
    if (channelLoadInFlight.current) await channelLoadInFlight.current;
    return loadChannels(true);
  }, [loadChannels]);
  const realtimeConnected = useMessagingRealtime(
    useCallback(
      (hint) => {
        void refreshFromHint();
        if (hint.ids.channelId === activeIdRef.current) {
          setLiveToken((n) => n + 1);
          setLiveHint((previous) =>
            pushLiveHint(previous, hint.ids.messageId, hint.ids.parentMessageId ?? null),
          );
        }
      },
      [refreshFromHint],
    ),
    useCallback(() => {
      void refreshFromHint();
      setLiveToken((n) => n + 1);
      setLiveHint((previous) => pushLiveHint(previous, null, null));
    }, [refreshFromHint]),
  );
  const realtimeDegraded = useRealtimeDegraded(realtimeConnected);

  useEffect(() => {
    let timer: number | undefined;
    let failures = 0;
    let stopped = false;
    const base = realtimeConnected ? REALTIME_CHANNEL_POLL_INTERVAL_MS : CHANNEL_POLL_INTERVAL_MS;
    const schedule = (): void => {
      timer = window.setTimeout(
        tick,
        Math.min(base * 2 ** failures, Math.max(MAX_CHANNEL_POLL_INTERVAL_MS, base)),
      );
    };
    const tick = async (): Promise<void> => {
      if (stopped) return;
      if (document.hidden) {
        schedule();
        return;
      }
      failures = (await loadChannels(true)) ? 0 : Math.min(failures + 1, 2);
      schedule();
    };
    const refreshWhenVisible = (): void => {
      if (!document.hidden) void loadChannels(true);
    };
    schedule();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [loadChannels, realtimeConnected]);

  const openConversation = useCallback(
    async (channelId: string): Promise<boolean> => {
      if (
        !(await loadChannels()) ||
        !channelsRef.current?.some((item) => item.channelId === channelId)
      ) {
        return false;
      }
      setActiveId(channelId);
      setNewConversationOpen(false);
      setDepartmentOpen(false);
      return true;
    },
    [loadChannels],
  );

  const openSearchHit = useCallback(
    async (channelId: string, messageId: string): Promise<boolean> => {
      const opened = await openConversation(channelId);
      if (opened) setSearchAnchor({ channelId, messageId });
      return opened;
    },
    [openConversation],
  );

  const onReadConfirmed = useCallback((channelId: string): void => {
    setChannels((current) => {
      const next =
        current?.map((channel) =>
          channel.channelId === channelId
            ? { ...channel, unreadCount: 0, mentionCount: 0 }
            : channel,
        ) ?? null;
      channelsRef.current = next;
      return next;
    });
  }, []);

  const onAccessRevoked = useCallback((channelId: string): void => {
    setChannels((current) => {
      const next = current?.filter((channel) => channel.channelId !== channelId) ?? null;
      channelsRef.current = next;
      return next;
    });
    if (activeIdRef.current === channelId) setAccessEnded(true);
    setActiveId((current) => (current === channelId ? null : current));
  }, []);

  const visibleChannels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (channels ?? []).filter((channel) => {
      const matchesFilter =
        filter === "all" ||
        (filter === "unread" && channel.unreadCount > 0) ||
        (filter === "mentions" && channel.mentionCount > 0) ||
        (filter === "dm" && channel.kind === "dm" && channel.archivedAt === null) ||
        (filter === "care_team" && channel.kind === "care_team" && channel.archivedAt === null) ||
        (filter === "archived" && channel.archivedAt !== null);
      if (!matchesFilter) return false;
      if (!needle) return true;
      return (
        channelLabel(channel).toLowerCase().includes(needle) ||
        channelKindLabel(channel.kind).toLowerCase().includes(needle) ||
        channel.participantRoles.some((role) => role.toLowerCase().includes(needle))
      );
    });
  }, [channels, filter, query]);

  const activeChannel = channels?.find((channel) => channel.channelId === activeId) ?? null;

  return (
    <div className="wx-messaging-page">
      <PageHeader title="Messaging" breadcrumb="General / Messaging">
        <p className="wx-messaging-page-subtitle">
          Secure conversations in <strong>{organizationName}</strong>
        </p>
      </PageHeader>

      <NewConversationDialog
        key={`${organizationId}:${newConversationOpen ? "open" : "closed"}`}
        open={newConversationOpen}
        organizationId={organizationId}
        organizationName={organizationName}
        currentUserId={userId}
        onClose={() => setNewConversationOpen(false)}
        onCreated={openConversation}
      />

      <ScheduledMessagesDialog
        open={scheduledOpen}
        onClose={() => setScheduledOpen(false)}
        channelName={(channelId) => {
          const known = channels?.find((channel) => channel.channelId === channelId);
          return known ? channelLabel(known) : "A conversation you can no longer open";
        }}
      />

      {canAnnounce ? (
        <DepartmentChannelDialog
          key={departmentOpen ? "open" : "closed"}
          open={departmentOpen}
          onClose={() => setDepartmentOpen(false)}
          onCreated={openConversation}
        />
      ) : null}

      <GlobalSearch
        channelName={(channelId) => {
          const known = channels?.find((channel) => channel.channelId === channelId);
          return known ? channelLabel(known) : null;
        }}
        onOpenHit={openSearchHit}
      />

      <RealtimeBanner degraded={realtimeDegraded} refreshSeconds={POLL_INTERVAL_MS / 1000} />
      <OfflineBanner />

      <section
        aria-label="Conversations and messages"
        className={`wx-messaging-layout ${activeChannel ? "has-active-thread" : ""} ${accessEnded && !activeChannel ? "access-ended" : ""}`}
      >
        <ConversationInbox
          channels={channels}
          visibleChannels={visibleChannels}
          activeId={activeId}
          headingRef={inboxHeadingRef}
          query={query}
          filter={filter}
          error={error}
          errorCorrelationId={errorCorrelationId}
          onQueryChange={setQuery}
          onFilterChange={setFilter}
          onSelect={pickConversation}
          onRetry={() => void loadChannels()}
          onNewConversation={() => setNewConversationOpen(true)}
          onNewDepartment={canAnnounce ? () => setDepartmentOpen(true) : undefined}
          onShowScheduled={() => setScheduledOpen(true)}
        />
        <div className="wx-messaging-active-pane">
          {activeChannel ? (
            <ConversationThread
              key={`${organizationId}:${activeChannel.channelId}`}
              channel={activeChannel}
              outbox={outbox}
              headingRef={threadHeadingRef}
              meId={userId}
              meDisplayName={userDisplayName}
              onBack={() => {
                focusInboxAfterNotice.current = true;
                setActiveId(null);
              }}
              onReadConfirmed={onReadConfirmed}
              onMessageSent={() => void loadChannels(true)}
              onAccessRevoked={onAccessRevoked}
              liveToken={liveToken}
              liveHint={liveHint}
              realtimeConnected={realtimeConnected}
              canAnnounce={canAnnounce}
              canManageMembers={canManageMembers}
              onChannelChanged={refreshAfterChange}
              anchorMessageId={
                searchAnchor?.channelId === activeChannel.channelId
                  ? searchAnchor.messageId
                  : activeChannel.channelId === requestedChannelId
                    ? requestedMessageId
                    : null
              }
            />
          ) : (
            <div className="wx-messaging-no-selection">
              {accessEnded ? (
                <AccessEndedNotice
                  onBack={() => {
                    focusInboxAfterNotice.current = true;
                    setAccessEnded(false);
                  }}
                />
              ) : (
                <EmptyState
                  title="Select a conversation"
                  description="Choose a secure conversation from the inbox to view its messages."
                />
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
