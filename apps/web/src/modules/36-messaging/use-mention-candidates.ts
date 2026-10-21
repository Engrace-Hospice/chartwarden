// The @-mention candidate lookup behind the composer popup: debounced GET of the channel's mention candidates for the
// active query, the highlighted row, and an explicit retry. Moved out of ConversationThread unchanged to keep it small.
import { useApiClient } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { MentionCandidate, MentionOption } from "./messaging-types";

const MENTION_DEBOUNCE_MS = 250;
/** The server needs this many characters before it will name people outside the conversation. */
const NON_MEMBER_MIN_QUERY = 2;
const NOT_IN_CONVERSATION = "Not in this conversation";

export interface MentionCandidates {
  /** Members first, then (WP 2.3) people outside the conversation, marked `not_member`. */
  readonly candidates: MentionOption[];
  /** True when the sender may add a non-member (server-decided: permission AND channel authority). */
  readonly canAdd: boolean;
  readonly loading: boolean;
  readonly error: boolean;
  readonly activeIndex: number;
  readonly setActiveIndex: (update: (index: number) => number) => void;
  readonly retry: () => void;
}

export function useMentionCandidates(input: {
  channelId: string;
  meId: string;
  query: { query: string; start: number } | null;
}): MentionCandidates {
  const { channelId, meId, query } = input;
  const client = useApiClient();
  const [candidates, setCandidates] = useState<MentionOption[]>([]);
  const [canAdd, setCanAdd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const generationRef = useRef(0);

  useEffect(() => {
    // Incrementing this value is the explicit retry signal for the same query.
    void retryCount;
    if (!query) {
      generationRef.current += 1;
      setCandidates([]);
      setLoading(false);
      setError(false);
      return;
    }
    const generation = ++generationRef.current;
    setLoading(true);
    setError(false);
    const timer = window.setTimeout(() => {
      // The non-member lookup is best effort: if it fails the member list still works.
      const nonMembers =
        query.query.trim().length >= NON_MEMBER_MIN_QUERY
          ? client
              .GET("/api/v1/messaging/channels/{id}/mention-non-members", {
                params: { path: { id: channelId }, query: { q: query.query } },
              })
              .then(({ data }) => data ?? null)
              .catch(() => null)
          : Promise.resolve(null);
      void Promise.all([
        client.GET("/api/v1/messaging/channels/{id}/mention-candidates", {
          params: { path: { id: channelId }, query: { q: query.query } },
        }),
        nonMembers,
      ])
        .then(([{ data, error: failure }, outside]) => {
          if (generation !== generationRef.current) return;
          setLoading(false);
          setError(Boolean(failure));
          const members = failure
            ? []
            : ((data?.candidates ?? []) as MentionCandidate[]).filter(
                (candidate) => !(candidate.kind === "staff" && candidate.entityId === meId),
              );
          const others = (outside?.people ?? [])
            .filter((person) => person.entityId !== meId)
            .map((person) => ({
              kind: "not_member" as const,
              entityId: person.entityId,
              displayName: person.displayName,
              detail: NOT_IN_CONVERSATION,
            }));
          setCandidates([...members, ...others]);
          setCanAdd(outside?.canAdd === true);
          setActiveIndex(0);
        })
        .catch(() => {
          if (generation !== generationRef.current) return;
          setLoading(false);
          setError(true);
          setCandidates([]);
        });
    }, MENTION_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [channelId, client, meId, query, retryCount]);

  return {
    candidates,
    canAdd,
    loading,
    error,
    activeIndex,
    setActiveIndex,
    retry: () => setRetryCount((value) => value + 1),
  };
}
