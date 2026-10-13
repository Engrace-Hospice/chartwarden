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
import { BUSY_STYLE } from "./busy-style";
import "./channel-lifecycle.css";

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
  const retryFocusPending = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState("");
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
        pendingFocus.current = undefined;
        setForbidden(true);
        return;
      }
      if (error || !data) {
        pendingFocus.current = undefined;
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
      pendingFocus.current = undefined;
      setLoadError("The member list could not be loaded.");
      setLoadCorrelationId(null);
    }
  }, [client, channelId]);

  useEffect(() => {
    pendingFocus.current = undefined;
    retryFocusPending.current = open;
    setCandidates([]);
    setCandidateError(false);
    setAnnouncement("");
    setMembers(null);
    setForbidden(false);
    setLoadError(null);
    setLoadCorrelationId(null);
    setActionError(null);
    // Reset on close as well: this component stays mounted while the Modal renders nothing, so a stale list or error
    // block would otherwise render on the first frame of the next open, take the Modal's initial focus, and then be
    // replaced by the skeleton, dropping focus to <body>.
    setRetrying(false);
    setBusy(false);
    if (!open) return;
    void loadMembers();
    return () => {
      sequence.current += 1;
      pendingFocus.current = undefined;
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
      ? Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-member-id]") ?? []).find(
          (element) => element.dataset.memberId === neighbour,
        )
      : null;
    (row ?? headingRef.current)?.focus();
  }, [members]);

  // After the commit of a finished Retry (or first load): if the list is back and focus fell to <body>, the heading takes
  // it. On a normal open the Modal has already put focus on the first control (the "Find staff" input, while the skeleton
  // shows), so for the first load this is only a fallback.
  useEffect(() => {
    if (retrying || !retryFocusPending.current) return;
    if (members === null && loadError === null) return;
    retryFocusPending.current = false;
    if (loadError === null && members !== null && document.activeElement === document.body) {
      headingRef.current?.focus();
    }
  }, [retrying, loadError, members]);

  // The list was replaced by the error block (e.g. a reload failed after a change) and focus fell to <body>.
  useEffect(() => {
    if (loadError === null || retrying) return;
    if (document.activeElement === document.body)
      errorRef.current?.querySelector("button")?.focus();
  }, [loadError, retrying]);

  const memberIds = new Set((members ?? []).map((member) => member.userId));
  const addable = candidates.filter((person) => !memberIds.has(person.userId));
  const locked = busy || members === null || loadError !== null;
  const selected = addable.find((person) => person.userId === candidateId) ?? addable[0];

  // Retry stays mounted (aria-disabled) while it runs so focus is not lost. The handoff to the heading happens in the
  // effect below, after the commit that removes Retry, not here: state set after an await is not committed yet.
  async function retry(): Promise<void> {
    if (retrying) return;
    pendingFocus.current = undefined;
    retryFocusPending.current = true;
    setRetrying(true);
    await loadMembers();
    setRetrying(false);
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
    setAnnouncement("");
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
      pendingFocus.current = undefined;
      if (generation === sequence.current) setActionError(fallback);
    } finally {
      // Not cleared here: the handoff is consumed by the effect that runs once the reloaded list commits.
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
            <div role="alert" className="wx-channel-members-state" ref={errorRef}>
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
          ) : members.length === 0 ? (
            <p className="wx-channel-members-state">No members yet</p>
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
                    aria-disabled={locked}
                    data-member-id={member.userId}
                    style={locked ? BUSY_STYLE : undefined}
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
                          setAnnouncement(`${member.displayName} removed.`);
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
                aria-disabled={busy || addable.length === 0}
                onChange={(event) => {
                  if (!busy) setCandidateId(event.target.value);
                }}
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
              aria-disabled={locked || !selected}
              style={locked || !selected ? BUSY_STYLE : undefined}
              onClick={() =>
                selected &&
                !locked &&
                void change(
                  () =>
                    client.POST("/api/v1/messaging/channels/{id}/members", {
                      params: { path: { id: channelId } },
                      body: { userId: selected.userId },
                    }),
                  "The member could not be added.",
                  () => setAnnouncement(`${selected.displayName} added.`),
                )
              }
            >
              Add
            </Button>
          </div>
          <output aria-label="Member changes">{announcement}</output>
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
