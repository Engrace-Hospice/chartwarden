import {
  Button,
  ConversationView,
  EmptyState,
  Glyph,
  LoadingSpinner,
  Modal,
  OffsetPagination,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/36-messaging — Internal Staff Secure Messaging (M36, Track A).
// Spec: docs/design/screens/core/WARDENX_UI_STAFF_MESSAGING.md — "Use Conversation View."
// Matched to the P0 Pencil frame (wardenx-P0-foundation.pen `A016Y`): a "Messages" conversation list
// (avatar + title + secondary + unread dot, active row indigo-tinted) | a thread of chat bubbles
// (mine right/indigo, others left/paper) under a header with a patient-scoped chip, over a rounded
// composer. Backed by GET /messaging/channels, GET/POST /messaging/channels/:id/messages. The list's
// last-message preview/time isn't exposed by the channels read yet, so the secondary line shows the
// channel's real scope (patient-scoped / kind) rather than a fabricated preview.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useSession } from "../../shell";

interface ChannelSummary {
  channelId: string;
  kind: string;
  title: string | null;
  subjectId: string | null;
  archivedAt: string | null;
  unreadCount: number;
}
interface Message {
  messageId: string;
  channelId: string;
  authorUserId: string | null;
  body: string;
  bodyKind: string;
  createdAt: string;
  parentMessageId: string | null;
}
interface DmStaffMember {
  userId: string;
  displayName: string;
  roles: string[];
}

const CHANNEL_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

const channelLabel = (c: ChannelSummary): string => c.title ?? c.kind.replace(/_/g, " ");
const channelScope = (c: ChannelSummary): string =>
  c.subjectId
    ? "Patient-scoped"
    : c.kind.replace(/_/g, " ").replace(/\b\w/g, (x) => x.toUpperCase());
function initialsOf(s: string): string {
  const w = s.split(/[\s,_]+/).filter(Boolean);
  return (
    w
      .slice(0, 2)
      .map((x) => x[0]?.toUpperCase() ?? "")
      .join("") || "M"
  ).slice(0, 2);
}
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export function StaffMessaging(): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const organizationId = session?.organizationId ?? "";
  const [channels, setChannels] = useState<ChannelSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<"all" | "patient" | "general">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "unread" | "archived">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const organizationGeneration = useRef(0);

  useEffect(() => {
    let active = true;
    organizationGeneration.current += 1;
    setChannels(null);
    setError(null);
    setActiveId(null);
    setSearchQuery("");
    setScopeFilter("all");
    setStatusFilter("all");
    setPage(1);
    setNewConversationOpen(false);
    if (!organizationId) return () => undefined;
    (async () => {
      const { data, error: err } = await client.GET("/api/v1/messaging/channels");
      if (!active) return;
      if (err) {
        setError("Could not load channels.");
        setChannels([]);
        return;
      }
      const list = (data?.channels ?? []) as ChannelSummary[];
      setChannels(list);
      setActiveId(list[0]?.channelId ?? null);
    })();
    return () => {
      active = false;
    };
  }, [client, organizationId]);

  const openConversation = useCallback(
    async (channelId: string): Promise<void> => {
      const generation = organizationGeneration.current;
      const { data, error: loadError } = await client.GET("/api/v1/messaging/channels");
      if (generation !== organizationGeneration.current) return;
      if (loadError) {
        setError("The conversation was created, but the channel list could not be refreshed.");
        return;
      }
      setChannels((data?.channels ?? []) as ChannelSummary[]);
      setActiveId(channelId);
      setNewConversationOpen(false);
    },
    [client],
  );

  const filteredChannels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return (channels ?? []).filter((channel) => {
      const matchesSearch =
        q.length === 0 ||
        channelLabel(channel).toLowerCase().includes(q) ||
        channel.kind.toLowerCase().includes(q) ||
        (channel.subjectId?.toLowerCase().includes(q) ?? false) ||
        channel.channelId.toLowerCase().includes(q);
      const matchesScope =
        scopeFilter === "all" ||
        (scopeFilter === "patient" && channel.subjectId !== null) ||
        (scopeFilter === "general" && channel.subjectId === null);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "unread" && channel.unreadCount > 0) ||
        (statusFilter === "archived" && channel.archivedAt !== null);
      return matchesSearch && matchesScope && matchesStatus;
    });
  }, [channels, scopeFilter, searchQuery, statusFilter]);

  const hasActiveFilters =
    searchQuery.trim() !== "" || scopeFilter !== "all" || statusFilter !== "all";
  const pageCount = Math.max(1, Math.ceil(filteredChannels.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedChannels = filteredChannels.slice((activePage - 1) * pageSize, activePage * pageSize);
  const activeChannel = channels?.find((c) => c.channelId === activeId) ?? null;

  const clearFilters = (): void => {
    setSearchQuery("");
    setScopeFilter("all");
    setStatusFilter("all");
    setPage(1);
  };

  return (
    <div style={pageShellStyle}>
      <PageHeader title="Messaging" breadcrumb="General / Messaging">
        <div style={headerActionsStyle}>
          <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Secure staff conversations and patient-scoped channels.
          </span>
          <Button type="button" onClick={() => setNewConversationOpen(true)}>
            New conversation
          </Button>
        </div>
      </PageHeader>

      <NewConversationDialog
        key={`${organizationId}:${newConversationOpen ? "open" : "closed"}`}
        open={newConversationOpen}
        organizationId={organizationId}
        organizationName={session?.organizationName ?? "Active organization"}
        currentUserId={session?.userId ?? ""}
        onClose={() => setNewConversationOpen(false)}
        onCreated={openConversation}
      />

      <div style={filterShellStyle}>
        {error ? (
          <div role="alert" style={errorBannerStyle}>
            <Glyph name="alert" size={16} />
            <span>{error}</span>
          </div>
        ) : null}
        <div className="wx-filter-panel">
          <label className="wx-search-field">
            <Glyph name="search" size={16} />
            <input
              type="search"
              placeholder="Search channel, scope, patient…"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
              aria-label="Search message channels"
            />
          </label>
          <label className="wx-filter-field">
            <span>Scope</span>
            <select
              className="wx-select"
              value={scopeFilter}
              onChange={(e) => {
                setScopeFilter(e.target.value as typeof scopeFilter);
                setPage(1);
              }}
              aria-label="Filter channels by scope"
            >
              <option value="all">All</option>
              <option value="patient">Patient-scoped</option>
              <option value="general">General</option>
            </select>
          </label>
          <label className="wx-filter-field">
            <span>Status</span>
            <select
              className="wx-select"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as typeof statusFilter);
                setPage(1);
              }}
              aria-label="Filter channels by status"
            >
              <option value="all">All</option>
              <option value="unread">Unread</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          {hasActiveFilters ? (
            <button type="button" className="wx-btn-secondary" onClick={clearFilters}>
              <Glyph name="filter" size={15} /> Clear
            </button>
          ) : null}
        </div>
      </div>

      {channels === null ? (
        <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
          <LoadingSpinner />
        </div>
      ) : (
        <div style={conversationWrapStyle}>
          <ConversationView
            list={
              <ChannelList
                channels={pagedChannels}
                total={filteredChannels.length}
                page={activePage}
                pageSize={pageSize}
                activeId={activeId}
                hasActiveFilters={hasActiveFilters}
                onSelect={setActiveId}
                onClearFilters={clearFilters}
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPageSize(nextPageSize);
                  setPage(1);
                }}
              />
            }
          >
            {activeChannel ? (
              <Thread
                key={`${organizationId}:${activeChannel.channelId}`}
                channel={activeChannel}
                meId={session?.userId ?? null}
              />
            ) : (
              <EmptyState
                title="No channel selected"
                description="Pick a channel to view its messages."
              />
            )}
          </ConversationView>
        </div>
      )}
    </div>
  );
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; error?: { message?: unknown } };
    if (typeof candidate.message === "string" && candidate.message) return candidate.message;
    if (typeof candidate.error?.message === "string" && candidate.error.message) {
      return candidate.error.message;
    }
  }
  return fallback;
}

function NewConversationDialog({
  open,
  organizationId,
  organizationName,
  currentUserId,
  onClose,
  onCreated,
}: {
  open: boolean;
  organizationId: string;
  organizationName: string;
  currentUserId: string;
  onClose: () => void;
  onCreated: (channelId: string) => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const [query, setQuery] = useState("");
  const [staff, setStaff] = useState<DmStaffMember[] | null>(null);
  const [selected, setSelected] = useState<DmStaffMember | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [retry, setRetry] = useState(0);
  const requestSequence = useRef(0);

  useEffect(
    () => () => {
      requestSequence.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!open || !organizationId) return;
    // The attempt token intentionally participates in this effect so Retry performs a fresh read.
    const searchAttempt = retry;
    const sequence = ++requestSequence.current;
    setStaff(null);
    setSearchError(null);
    const timer = window.setTimeout(() => {
      void client
        .GET("/api/v1/messaging/dm/staff", { params: { query: { q: query.trim() || undefined } } })
        .then(({ data, error }) => {
          if (sequence !== requestSequence.current || searchAttempt !== retry) return;
          if (error) {
            setStaff([]);
            setSearchError(apiErrorMessage(error, "Could not search staff in this organization."));
            return;
          }
          const eligible = ((data?.staff ?? []) as DmStaffMember[]).filter(
            (person) => person.userId !== currentUserId,
          );
          setStaff(eligible);
          setSelected((previous) =>
            previous && eligible.some((person) => person.userId === previous.userId)
              ? previous
              : null,
          );
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [client, currentUserId, open, organizationId, query, retry]);

  async function createConversation(): Promise<void> {
    if (!selected || creating) return;
    setCreating(true);
    setCreateError(null);
    const sequence = requestSequence.current;
    const { data, error } = await client.POST("/api/v1/messaging/dm", {
      body: { userId: selected.userId },
    });
    if (sequence !== requestSequence.current) return;
    setCreating(false);
    if (error || !data?.channelId) {
      setCreateError(
        apiErrorMessage(error, "Could not start this conversation. Please try again."),
      );
      return;
    }
    await onCreated(data.channelId);
  }

  return (
    <Modal
      open={open}
      onClose={creating ? undefined : onClose}
      ariaLabel="New conversation"
      width="36rem"
    >
      <div style={dialogStyle}>
        <div>
          <h2 style={dialogTitleStyle}>New conversation</h2>
          <p style={dialogSubtitleStyle}>
            Search active staff in <strong>{organizationName}</strong>.
          </p>
        </div>
        <label style={dialogSearchStyle}>
          <span>Staff member</span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(null);
            }}
            placeholder="Search by name or email…"
            aria-label="Search eligible staff"
          />
        </label>
        <div aria-live="polite" style={staffResultsStyle}>
          {staff === null ? (
            <div style={dialogStateStyle}>
              <LoadingSpinner />
            </div>
          ) : searchError ? (
            <div role="alert" style={dialogStateStyle}>
              <span>{searchError}</span>
              <Button size="sm" tone="secondary" onClick={() => setRetry((value) => value + 1)}>
                Retry
              </Button>
            </div>
          ) : staff.length === 0 ? (
            <EmptyState title="No eligible staff found" description="Try a different search." />
          ) : (
            <ul style={staffListStyle}>
              {staff.map((person) => (
                <li key={person.userId}>
                  <button
                    type="button"
                    style={{
                      ...staffOptionStyle,
                      background:
                        selected?.userId === person.userId ? t.primaryTint : t.surfaceLowest,
                    }}
                    aria-pressed={selected?.userId === person.userId}
                    onClick={() => setSelected(person)}
                  >
                    <span style={listAvatarStyle} aria-hidden>
                      {initialsOf(person.displayName)}
                    </span>
                    <span style={channelTextStyle}>
                      <span style={convTitleStyle}>{person.displayName}</span>
                      <span style={convPreviewStyle}>
                        {person.roles.join(" · ") || "Staff member"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {createError ? (
          <div role="alert" style={errorBannerStyle}>
            {createError}
          </div>
        ) : null}
        <div style={dialogActionsStyle}>
          <Button type="button" tone="secondary" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void createConversation()}
            disabled={!selected || creating}
          >
            {creating ? "Opening…" : "Open conversation"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ChannelList({
  channels,
  total,
  page,
  pageSize,
  activeId,
  hasActiveFilters,
  onSelect,
  onClearFilters,
  onPageChange,
  onPageSizeChange,
}: {
  channels: ChannelSummary[];
  total: number;
  page: number;
  pageSize: number;
  activeId: string | null;
  hasActiveFilters: boolean;
  onSelect: (id: string) => void;
  onClearFilters: () => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}): JSX.Element {
  return (
    <div style={listShellStyle}>
      <div style={listHeaderStyle}>
        <span style={listTitleStyle}>Channels</span>
        <span style={listCountStyle}>{total}</span>
      </div>
      {total === 0 ? (
        <div style={{ padding: "1.5rem 1rem" }}>
          <EmptyState
            title={hasActiveFilters ? "No matching channels" : "No channels"}
            description={
              hasActiveFilters
                ? "Try adjusting the channel filters."
                : "You are not a member of any channel yet."
            }
            action={
              hasActiveFilters ? (
                <Button size="sm" tone="secondary" onClick={onClearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <>
          <ul style={channelListStyle}>
            {channels.map((channel) => {
              const active = channel.channelId === activeId;
              return (
                <li key={channel.channelId}>
                  <button
                    type="button"
                    onClick={() => onSelect(channel.channelId)}
                    style={{ ...convRowStyle, background: active ? t.primaryTint : "transparent" }}
                  >
                    <span style={listAvatarStyle} aria-hidden>
                      {initialsOf(channelLabel(channel))}
                    </span>
                    <span style={channelTextStyle}>
                      <span style={convTitleStyle}>{channelLabel(channel)}</span>
                      <span style={convPreviewStyle}>{channelScope(channel)}</span>
                    </span>
                    <span style={channelMetaStyle}>
                      {channel.unreadCount > 0 ? (
                        <StatusPill label={`${channel.unreadCount}`} tone="warning" />
                      ) : channel.archivedAt ? (
                        <StatusPill label="Archived" tone="neutral" />
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <OffsetPagination
            page={page}
            pageSize={pageSize}
            totalItems={total}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
            pageSizeOptions={CHANNEL_PAGE_SIZES}
            noun="channels"
          />
        </>
      )}
    </div>
  );
}

function Thread({ channel, meId }: { channel: ChannelSummary; meId: string | null }): JSX.Element {
  const client = useApiClient();
  const channelId = channel.channelId;
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const { data } = await client.GET("/api/v1/messaging/channels/{id}/messages", {
      params: { path: { id: channelId }, query: { limit: 50 } },
    });
    if (sequence !== loadSequence.current) return;
    setMessages((data?.messages ?? []) as Message[]);
  }, [client, channelId]);

  useEffect(() => {
    setMessages(null);
    setDraft("");
    void load();
    return () => {
      loadSequence.current += 1;
    };
  }, [load]);

  async function send(): Promise<void> {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    const { error } = await client.POST("/api/v1/messaging/channels/{id}/messages", {
      params: { path: { id: channelId } },
      body: { body },
    });
    setSending(false);
    if (!error) {
      setDraft("");
      void load();
    }
  }

  return (
    <>
      <div style={threadHeaderStyle}>
        <span style={{ fontWeight: 600, color: t.onSurface }}>{channelLabel(channel)}</span>
        {channel.subjectId ? (
          <span style={scopeChipStyle}>
            <Glyph name="shield" size={13} />
            Patient-scoped
          </span>
        ) : null}
      </div>

      <div style={messagesAreaStyle}>
        {messages === null ? (
          <LoadingSpinner />
        ) : messages.length === 0 ? (
          <EmptyState title="No messages" description="Start the conversation below." />
        ) : (
          messages.map((message) => {
            const mine = message.authorUserId != null && message.authorUserId === meId;
            const system = message.authorUserId == null;
            if (system) {
              return (
                <div key={message.messageId} style={{ textAlign: "center" }}>
                  <span style={systemNoteStyle}>{message.body}</span>
                </div>
              );
            }
            return (
              <div
                key={message.messageId}
                style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start" }}
              >
                <div style={mine ? bubbleMineStyle : bubbleTheirsStyle}>
                  <span style={{ whiteSpace: "pre-wrap" }}>{message.body}</span>
                  <span
                    style={{
                      ...bubbleMetaStyle,
                      color: mine
                        ? `color-mix(in srgb, ${t.onEmphasis} 75%, transparent)`
                        : t.muted,
                    }}
                  >
                    {mine ? (
                      "You"
                    ) : (
                      <span className="wx-data-md">{message.authorUserId?.slice(0, 8)}</span>
                    )}{" "}
                    · {relTime(message.createdAt)}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div style={composerStyle}>
        <input
          aria-label="Message"
          placeholder={`Message ${channelLabel(channel)}...`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
          style={composerInputStyle}
        />
        <Button type="button" onClick={() => void send()} disabled={sending || !draft.trim()}>
          {sending ? "Sending..." : "Send"}
        </Button>
      </div>
    </>
  );
}

const pageShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  flex: 1,
};
const headerActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
};
const dialogStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "1.5rem",
};
const dialogTitleStyle: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  fontFamily: t.fontDisplay,
  fontSize: "1.25rem",
};
const dialogSubtitleStyle: CSSProperties = {
  margin: "0.35rem 0 0",
  color: t.onSurfaceVariant,
  fontSize: "0.875rem",
};
const dialogSearchStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
  color: t.onSurface,
  fontSize: "0.8125rem",
  fontWeight: 600,
};
const staffResultsStyle: CSSProperties = {
  minHeight: "12rem",
  maxHeight: "min(22rem, 45vh)",
  overflowY: "auto",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: t.radiusLg,
};
const dialogStateStyle: CSSProperties = {
  minHeight: "12rem",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.75rem",
  padding: "1rem",
  color: t.onSurfaceVariant,
  textAlign: "center",
};
const staffListStyle: CSSProperties = { listStyle: "none", padding: 0, margin: 0 };
const staffOptionStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  width: "100%",
  padding: "0.75rem",
  border: "none",
  borderBottom: `1px solid color-mix(in srgb, ${t.outlineVariant} 50%, transparent)`,
  textAlign: "left",
  cursor: "pointer",
};
const dialogActionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.75rem",
  flexWrap: "wrap",
};
const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 1rem",
};
const errorBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
};
const conversationWrapStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
};
const listShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};
const listHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0.875rem 1rem",
  borderBottom: `1px solid color-mix(in srgb, ${t.outlineVariant} 35%, transparent)`,
};
const listTitleStyle: CSSProperties = {
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.05rem",
  color: t.onSurface,
};
const listCountStyle: CSSProperties = {
  color: t.onSurfaceVariant,
  fontSize: "0.8rem",
  fontVariantNumeric: "tabular-nums",
};
const channelListStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  flex: 1,
  minHeight: 0,
  overflow: "auto",
};
const convRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.625rem",
  width: "100%",
  textAlign: "left",
  border: "none",
  cursor: "pointer",
  padding: "0.75rem 1rem",
};
const listAvatarStyle: CSSProperties = {
  width: "2.375rem",
  height: "2.375rem",
  flexShrink: 0,
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: t.fontDisplay,
  fontWeight: 600,
  fontSize: "0.8rem",
};
const channelTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.1rem",
};
const convTitleStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: "0.8125rem",
  color: t.onSurface,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const convPreviewStyle: CSSProperties = {
  fontSize: "0.75rem",
  color: t.muted,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const channelMetaStyle: CSSProperties = {
  flexShrink: 0,
};
const threadHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.875rem 1.5rem",
  borderBottom: `1px solid color-mix(in srgb, ${t.outlineVariant} 35%, transparent)`,
  background: t.surfaceLowest,
};
const scopeChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  fontSize: "0.75rem",
  fontWeight: 600,
  color: t.primary,
  background: t.primaryTint,
  borderRadius: "9999px",
  padding: "0.15rem 0.55rem",
};
const messagesAreaStyle: CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.875rem",
  background: t.background,
};
const bubbleBaseStyle: CSSProperties = {
  maxWidth: "70%",
  padding: "0.625rem 0.875rem",
  fontSize: "0.875rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};
const bubbleTheirsStyle: CSSProperties = {
  ...bubbleBaseStyle,
  background: t.surfaceLow,
  color: t.onSurface,
  borderRadius: "16px 16px 16px 4px",
};
const bubbleMineStyle: CSSProperties = {
  ...bubbleBaseStyle,
  background: t.primary,
  color: t.onPrimary,
  borderRadius: "16px 16px 4px 16px",
};
const bubbleMetaStyle: CSSProperties = { fontSize: "0.6875rem" };
const systemNoteStyle: CSSProperties = { fontSize: "0.75rem", color: t.muted };
const composerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.625rem",
  padding: "1rem 1.5rem",
  borderTop: `1px solid color-mix(in srgb, ${t.outlineVariant} 35%, transparent)`,
  background: t.surfaceLowest,
};
const composerInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "0.65rem 1rem",
  border: "none",
  borderRadius: "9999px",
  background: t.surfaceLow,
  outline: "none",
  fontSize: "0.9rem",
  color: t.onSurface,
};
