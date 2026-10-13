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
  onChanged?: () => void | Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadCorrelationId, setLoadCorrelationId] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
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

  const memberIds = new Set((members ?? []).map((member) => member.userId));
  const addable = candidates.filter((person) => !memberIds.has(person.userId));
  const selected = addable.find((person) => person.userId === candidateId) ?? addable[0];

  function retry(): void {
    setLoadError(null);
    setLoadCorrelationId(null);
    setMembers(null);
    void loadMembers();
  }

  async function change(run: () => Promise<{ error?: unknown }>, fallback: string): Promise<void> {
    if (busy) return;
    // A close or channel switch bumps the sequence: a reply that lands afterwards must not write anything.
    const generation = sequence.current;
    setBusy(true);
    setActionError(null);
    try {
      const { error } = await run();
      if (generation !== sequence.current) return;
      if (error) setActionError(apiErrorMessage(error, fallback));
      else await loadMembers();
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
            <h2>Members</h2>
            <p>
              People who can read and write in <strong>{channelTitle}</strong>.
            </p>
          </header>
          {loadError ? (
            <div role="alert" className="wx-channel-members-state">
              <span>{loadError}</span>
              {loadCorrelationId ? <small>Reference {loadCorrelationId}</small> : null}
              <Button size="lg" tone="secondary" onClick={retry}>
                Retry
              </Button>
            </div>
          ) : members === null ? (
            <SkeletonRows label="Loading members" />
          ) : (
            <ul aria-label="Channel members">
              {members.map((member) => (
                <li key={member.userId}>
                  <span>
                    {member.displayName} <small>{member.role}</small>
                  </span>
                  <Button
                    size="sm"
                    tone="secondary"
                    disabled={busy}
                    aria-label={`Remove ${member.displayName}`}
                    onClick={() =>
                      void change(
                        () =>
                          client.DELETE("/api/v1/messaging/channels/{id}/members/{userId}", {
                            params: { path: { id: channelId, userId: member.userId } },
                          }),
                        "The member could not be removed.",
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
              disabled={busy || !selected}
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
            <Button tone="secondary" onClick={onClose}>
              Close
            </Button>
          </footer>
        </div>
      )}
    </Modal>
  );
}
