// M36 WP 2.9 — who is in a department (discipline / location) channel, with add and remove. Offered to a holder of
// messaging.manage_members; the server also applies the channel-level rule (org_admin, or a clinical lead for a
// location channel of their own location), so a refusal is shown, not assumed.
import { Button, LoadingSpinner, Modal, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { DmStaffMember } from "./messaging-types";
import { apiErrorMessage } from "./messaging-utils";
import "./announcements.css";

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
}: {
  channelId: string;
  channelTitle: string;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
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
      const { data, error } = await client.GET("/api/v1/messaging/channels/{id}", {
        params: { path: { id: channelId } },
      });
      if (attempt !== sequence.current) return;
      if (error || !data) {
        setLoadError(apiErrorMessage(error, "The member list could not be loaded."));
        return;
      }
      setLoadError(null);
      setMembers(
        data.members.map((member) => ({
          userId: member.userId,
          displayName: member.displayName?.trim() || "Staff member",
          role: member.role,
        })),
      );
    } catch {
      if (attempt === sequence.current) setLoadError("The member list could not be loaded.");
    }
  }, [client, channelId]);

  useEffect(() => {
    if (!open) return;
    setMembers(null);
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

  async function change(run: () => Promise<{ error?: unknown }>, fallback: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const { error } = await run();
      if (error) setActionError(apiErrorMessage(error, fallback));
      else await loadMembers();
    } catch {
      setActionError(fallback);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} ariaLabel={`Members of ${channelTitle}`} width="34rem">
      <div className="wx-new-conversation wx-channel-members">
        <header>
          <h2>Members</h2>
          <p>
            People who can read and write in <strong>{channelTitle}</strong>.
          </p>
        </header>
        {loadError ? (
          <div role="alert" className="wx-conversation-picker-state">
            <span>{loadError}</span>
            <Button size="sm" tone="secondary" onClick={() => void loadMembers()}>
              Retry
            </Button>
          </div>
        ) : members === null ? (
          <output className="wx-conversation-picker-state">
            <LoadingSpinner label="Loading members" />
          </output>
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
        <footer>
          <Button tone="secondary" onClick={onClose}>
            Close
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
