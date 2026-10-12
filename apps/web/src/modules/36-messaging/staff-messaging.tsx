import { BACKGROUND_REQUEST_HEADERS, EmptyState, PageHeader, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation } from "react-router-dom";
import { useSession } from "../../shell";
import { ConversationInbox } from "./conversation-inbox";
import { ConversationThread } from "./conversation-thread";
import type { ChannelSummary, ConversationFilter } from "./messaging-types";
import { channelKindLabel, channelLabel } from "./messaging-utils";
import { NewConversationDialog } from "./new-conversation-dialog";
import { useMessagingRealtime } from "./use-messaging-realtime";
import "./staff-messaging.css";

const CHANNEL_POLL_INTERVAL_MS = 15_000;
const MAX_CHANNEL_POLL_INTERVAL_MS = 60_000;
const REALTIME_CHANNEL_POLL_INTERVAL_MS = 120_000;

function useNarrowMessagingLayout(): boolean {
  const query = "(max-width: 760px)";
  const [narrow, setNarrow] = useState(() =>
    typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
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
      requestedChannelId={requestedChannelId}
      requestedMessageId={requestedMessageId}
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
  requestedChannelId,
  requestedMessageId,
}: {
  organizationId: string;
  organizationName: string;
  userId: string;
  userDisplayName: string;
  requestedChannelId: string | null;
  requestedMessageId: string | null;
}): JSX.Element {
  const client = useApiClient();
  const narrow = useNarrowMessagingLayout();
  const [channels, setChannels] = useState<ChannelSummary[] | null>(null);
  const channelsRef = useRef<ChannelSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
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
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const refreshFromHint = useCallback(async (): Promise<void> => {
    const generation = generationRef.current;
    if (channelLoadInFlight.current) await channelLoadInFlight.current;
    // Unmounted (or the org/user changed) while waiting: the cleanup bumped the generation, so do not read.
    if (generation !== generationRef.current) return;
    await loadChannels(true);
  }, [loadChannels]);
  const realtimeConnected = useMessagingRealtime(
    useCallback(
      (hint) => {
        void refreshFromHint();
        if (hint.ids.channelId === activeIdRef.current) setLiveToken((n) => n + 1);
      },
      [refreshFromHint],
    ),
    useCallback(() => {
      void refreshFromHint();
      setLiveToken((n) => n + 1);
    }, [refreshFromHint]),
  );

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
      return true;
    },
    [loadChannels],
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

      <main className={`wx-messaging-layout ${activeChannel ? "has-active-thread" : ""}`}>
        <ConversationInbox
          channels={channels}
          visibleChannels={visibleChannels}
          activeId={activeId}
          query={query}
          filter={filter}
          error={error}
          onQueryChange={setQuery}
          onFilterChange={setFilter}
          onSelect={setActiveId}
          onRetry={() => void loadChannels()}
          onNewConversation={() => setNewConversationOpen(true)}
        />
        <div className="wx-messaging-active-pane">
          {activeChannel ? (
            <ConversationThread
              key={`${organizationId}:${activeChannel.channelId}`}
              channel={activeChannel}
              meId={userId}
              meDisplayName={userDisplayName}
              onBack={() => setActiveId(null)}
              onReadConfirmed={onReadConfirmed}
              onMessageSent={() => void loadChannels(true)}
              onAccessRevoked={onAccessRevoked}
              liveToken={liveToken}
              realtimeConnected={realtimeConnected}
              anchorMessageId={
                activeChannel.channelId === requestedChannelId ? requestedMessageId : null
              }
            />
          ) : (
            <div className="wx-messaging-no-selection">
              <EmptyState
                title="Select a conversation"
                description="Choose a secure conversation from the inbox to view its messages."
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
