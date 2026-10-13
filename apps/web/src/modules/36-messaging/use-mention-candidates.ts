// The @-mention candidate lookup behind the composer popup: debounced GET of the channel's mention candidates for the
// active query, the highlighted row, and an explicit retry. Moved out of ConversationThread unchanged to keep it small.
import { useApiClient } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { MentionCandidate } from "./messaging-types";

const MENTION_DEBOUNCE_MS = 250;

export interface MentionCandidates {
  readonly candidates: MentionCandidate[];
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
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
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
      void client
        .GET("/api/v1/messaging/channels/{id}/mention-candidates", {
          params: { path: { id: channelId }, query: { q: query.query } },
        })
        .then(({ data, error: failure }) => {
          if (generation !== generationRef.current) return;
          setLoading(false);
          setError(Boolean(failure));
          setCandidates(
            failure
              ? []
              : ((data?.candidates ?? []) as MentionCandidate[]).filter(
                  (candidate) => !(candidate.kind === "staff" && candidate.entityId === meId),
                ),
          );
          setActiveIndex(0);
        });
    }, MENTION_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [channelId, client, meId, query, retryCount]);

  return {
    candidates,
    loading,
    error,
    activeIndex,
    setActiveIndex,
    retry: () => setRetryCount((value) => value + 1),
  };
}
