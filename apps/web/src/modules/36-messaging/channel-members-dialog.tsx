// M36 WP 2.9 — who is in a department (discipline / location) channel, with add and remove. Offered to a holder of
// messaging.manage_members; the server also applies the channel-level rule (org_admin, or a clinical lead for a
// location channel of their own location), so a refusal is shown, not assumed.
import { Button, Modal, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ChannelArchiveControl } from "./channel-archive-control";
import { MembersForbidden } from "./members-forbidden";
import type { DmStaffMember } from "./messaging-types";
import { apiErrorMessage, correlationIdOf } from "./messaging-utils";
import { SkeletonRows } from "./skeleton-rows";
import "./announcements.css";
import "./channel-lifecycle.css";

/** The kit Button sets opacity and cursor inline, so busy feedback has to be inline too. */
const BUSY_STYLE = { opacity: 0.6, cursor: "not-allowed" } as const;

interface Member {
  userId: string;
  displayName: string;
  role: string;
}

export function ChannelMembersDialog({
  channelId,
  channelTitle,
  open,
  onClose,
  canArchive = false,
  archived = false,
  onChanged = () => {},
}: {
  channelId: string;
  channelTitle: string;
  open: boolean;
  onClose: () => void;
  /** An org admin on an archivable (discipline / location) channel. */
  canArchive?: boolean;
  archived?: boolean;
  /** Called after an archive / unarchive so the channel list is re-read. */
  onChanged?: () => unknown;
}): JSX.Element {
  const client = useApiClient();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadCorrelationId, setLoadCorrelationId] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Set when a removal succeeds: the removed row's button is gone after the reload, so focus is handed on.
  const pendingFocus = useRef<string | null | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<DmStaffMember[]>([]);
  const [candidateId, setCandidateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [candidateError, setCandidateError] = useState(false);
  const sequence = useRef(0);
  const candidateSequence = useRef(0);

  const loadMembers = useCallback(async (): Promise<void> => {
    const attempt = ++sequence.current;
    try {
      const { data, error, response } = await client.GET(
        "/api/v1/messaging/channels/{id}/members",
        {
          params: { path: { id: channelId } },
        },
      );
      if (attempt !== sequence.current) return;
      if (response?.status === 403) {
        setForbidden(true);
        return;
      }
      if (error || !data) {
        setLoadError(apiErrorMessage(error, "The member list could not be loaded."));
        setLoadCorrelationId(correlationIdOf(error));
        return;
      }
      setForbidden(false);
      setLoadError(null);
      setLoadCorrelationId(null);
      setMembers(
        data.members.map((member) => ({
          userId: member.userId,
          displayName: member.displayName?.trim() || "Staff member",
          role: member.role,
        })),
      );
    } catch {
      if (attempt !== sequence.current) return;
      setLoadError("The member list could not be loaded.");
      setLoadCorrelationId(null);
    }
  }, [client, channelId]);

  useEffect(() => {
    if (!open) return;
    setMembers(null);
    setForbidden(false);
    setLoadError(null);
    setLoadCorrelationId(null);
    setActionError(null);
    void loadMembers();
    return () => {
      sequence.current += 1;
    };
  }, [open, loadMembers]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      // Only the newest search may write: a slow older answer must not replace the one the user is looking at.
      const attempt = ++candidateSequence.current;
      void client
        .GET("/api/v1/messaging/dm/staff", { params: { query: { q: query.trim() || undefined } } })
        .then(({ data, error }) => {
          if (attempt !== candidateSequence.current) return;
          setCandidateError(Boolean(error) || !data);
          setCandidates(error ? [] : ((data?.staff ?? []) as DmStaffMember[]));
        })
        .catch(() => {
          if (attempt !== candidateSequence.current) return;
          setCandidateError(true);
          setCandidates([]);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      candidateSequence.current += 1;
    };
  }, [client, open, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list changes, which is when the row is gone
  useEffect(() => {
    if (pendingFocus.current === undefined) return;
    const neighbour = pendingFocus.current;
    pendingFocus.current = undefined;
    if (document.activeElement !== document.body) return;
    const row = neighbour
      ? listRef.current?.querySelector<HTMLElement>(`[data-member-id="${neighbour}"]`)
      : null;
    (row ?? headingRef.current)?.focus();
  }, [members]);

  const memberIds = new Set((members ?? []).map((member) => member.userId));
  const addable = candidates.filter((person) => !memberIds.has(person.userId));
  const selected = addable.find((person) => person.userId === candidateId) ?? addable[0];

  // Retry stays mounted (aria-disabled) while it runs so focus is not lost; on success the heading takes focus.
  async function retry(): Promise<void> {
    if (retrying) return;
    setRetrying(true);
    await loadMembers();
    setRetrying(false);
    if (document.activeElement === document.body) headingRef.current?.focus();
  }

  /** The row that should take focus when `userId` is removed: the next one, else the previous, else none. */
  function neighbourOf(userId: string): string | null {
    const rows = members ?? [];
    const index = rows.findIndex((member) => member.userId === userId);
    return (rows[index + 1] ?? rows[index - 1])?.userId ?? null;
  }

  async function change(
    run: () => Promise<{ error?: unknown }>,
    fallback: string,
    onSuccess?: () => void,
  ): Promise<void> {
    if (busy) return;
    // A close or channel switch bumps the sequence: a reply that lands afterwards must not write anything.
    const generation = sequence.current;
    setBusy(true);
    setActionError(null);
    try {
      const { error } = await run();
      if (generation !== sequence.current) return;
      if (error) setActionError(apiErrorMessage(error, fallback));
      else {
        onSuccess?.();
        await loadMembers();
      }
    } catch {
      if (generation === sequence.current) setActionError(fallback);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={forbidden ? "Members" : `Members of ${channelTitle}`}
      width="34rem"
    >
      {forbidden ? (
        <MembersForbidden onClose={onClose} />
      ) : (
        <div className="wx-new-conversation wx-channel-members">
          <header>
            <h2 ref={headingRef} tabIndex={-1}>
              Members
            </h2>
            <p>
              People who can read and write in <strong>{channelTitle}</strong>.
            </p>
          </header>
          {loadError ? (
            <div role="alert" className="wx-channel-members-state">
              <span>{loadError}</span>
              {loadCorrelationId ? <small>Reference {loadCorrelationId}</small> : null}
              <Button
                size="lg"
                tone="secondary"
                aria-disabled={retrying}
                style={retrying ? BUSY_STYLE : undefined}
                onClick={() => void retry()}
              >
                {retrying ? "Retrying…" : "Retry"}
              </Button>
            </div>
          ) : members === null ? (
            <SkeletonRows label="Loading members" />
          ) : (
            <ul aria-label="Channel members" ref={listRef}>
              {members.map((member) => (
                <li key={member.userId}>
                  <span>
                    {member.displayName} <small>{member.role}</small>
                  </span>
                  <Button
                    size="lg"
                    tone="secondary"
                    aria-disabled={busy}
                    data-member-id={member.userId}
                    style={busy ? BUSY_STYLE : undefined}
                    aria-label={`Remove ${member.displayName}`}
                    onClick={() =>
                      void change(
                        () =>
                          client.DELETE("/api/v1/messaging/channels/{id}/members/{userId}", {
                            params: { path: { id: channelId, userId: member.userId } },
                          }),
                        "The member could not be removed.",
                        () => {
                          pendingFocus.current = neighbourOf(member.userId);
                        },
                      )
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="wx-channel-members-add">
            <label>
              <span>Find staff</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name or email…"
              />
            </label>
            <label>
              <span>Add to channel</span>
              <select
                value={selected?.userId ?? ""}
                disabled={busy || addable.length === 0}
                onChange={(event) => setCandidateId(event.target.value)}
              >
                {addable.length === 0 ? <option value="">No staff to add</option> : null}
                {addable.map((person) => (
                  <option key={person.userId} value={person.userId}>
                    {person.displayName}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="lg"
              aria-disabled={busy || !selected}
              style={busy ? BUSY_STYLE : undefined}
              onClick={() =>
                selected &&
                void change(
                  () =>
                    client.POST("/api/v1/messaging/channels/{id}/members", {
                      params: { path: { id: channelId } },
                      body: { userId: selected.userId },
                    }),
                  "The member could not be added.",
                )
              }
            >
              Add
            </Button>
          </div>
          {candidateError ? (
            <div role="alert" className="wx-messaging-error">
              Staff could not be searched. Try again.
            </div>
          ) : null}
          {actionError ? (
            <div role="alert" className="wx-messaging-error">
              {actionError}
            </div>
          ) : null}
          {canArchive ? (
            <ChannelArchiveControl
              channelId={channelId}
              archived={archived}
              onChanged={onChanged}
            />
          ) : null}
          <footer>
            <Button size="lg" tone="secondary" onClick={onClose}>
              Close
            </Button>
          </footer>
        </div>
      )}
    </Modal>
  );
}
