// M36 WP 6.8 (ADR-0097) - reads for the acknowledge-required broadcast screen. 404 on the caller's own list means the tenant flag is off;
// 401/403 end the reads (fail closed). The supervisor list is optional: 403 there only hides that section.
import type {
  AckBroadcastAcknowledged,
  AckBroadcastDetail,
  AckBroadcastFilter,
  AckBroadcastMine,
  AckBroadcastSummary,
} from "@chartwarden/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalApiClient } from "./use-handoffs-enabled";

export type MineView =
  | { readonly status: "loading" }
  | { readonly status: "off" }
  | { readonly status: "error" }
  | { readonly status: "denied"; readonly code: 401 | 403 }
  | { readonly status: "ready"; readonly items: readonly AckBroadcastMine[] };

export type OverseeView =
  | { readonly status: "loading" }
  | { readonly status: "hidden" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly broadcasts: readonly AckBroadcastSummary[] };

const PAGE = 100;

export function useAckBroadcast() {
  const client = useOptionalApiClient();
  const [mine, setMine] = useState<MineView>({ status: "loading" });
  const [oversee, setOversee] = useState<OverseeView>({ status: "loading" });
  const [ackError, setAckError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (!client) {
      setMine({ status: "off" });
      setOversee({ status: "hidden" });
      return;
    }
    const mineRun = ++latest.current;
    try {
      const res = await client.GET("/api/v1/messaging/ack-broadcasts/mine");
      if (mineRun !== latest.current) return;
      const code = res.response?.status ?? 0;
      if (res.data) setMine({ status: "ready", items: res.data.items });
      else if (code === 404) setMine({ status: "off" });
      else if (code === 401 || code === 403) setMine({ status: "denied", code });
      else setMine({ status: "error" });
    } catch {
      if (mineRun === latest.current) setMine({ status: "error" });
    }
    try {
      const res = await client.GET("/api/v1/messaging/ack-broadcasts");
      if (mineRun !== latest.current) return;
      const code = res.response?.status ?? 0;
      if (res.data) setOversee({ status: "ready", broadcasts: res.data.broadcasts });
      else setOversee({ status: code === 403 || code === 404 || code === 401 ? "hidden" : "error" });
    } catch {
      if (mineRun === latest.current) setOversee({ status: "error" });
    }
  }, [client]);

  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  /** The caller's own explicit acknowledgment. Returns the record or null (and says so) on failure. */
  const acknowledge = useCallback(
    async (messageId: string): Promise<AckBroadcastAcknowledged | null> => {
      if (!client) return null;
      setAckError(false);
      setBusy(messageId);
      try {
        const res = await client.POST("/api/v1/messaging/announcements/{messageId}/ack", {
          params: { path: { messageId } },
        });
        if (!res.data) {
          setAckError(true);
          return null;
        }
        await load();
        return res.data;
      } catch {
        setAckError(true);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [client, load],
  );

  return { mine, oversee, ackError, busy, acknowledge, reload: load };
}

export type DetailView =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly detail: AckBroadcastDetail };

/** One broadcast's people for the supervisor, paged exactly; "show more" appends the next page. */
export function useBroadcastDetail(messageId: string | null, filter: AckBroadcastFilter) {
  const client = useOptionalApiClient();
  const [view, setView] = useState<DetailView>({ status: "idle" });
  const seq = useRef(0);

  const fetchPage = useCallback(
    async (offset: number): Promise<AckBroadcastDetail | null> => {
      if (!client || !messageId) return null;
      const res = await client.GET("/api/v1/messaging/announcements/{messageId}/ack-broadcast", {
        params: { path: { messageId }, query: { filter, limit: PAGE, offset } },
      });
      return (res.data as AckBroadcastDetail | undefined) ?? null;
    },
    [client, messageId, filter],
  );

  useEffect(() => {
    const run = ++seq.current;
    if (!messageId) {
      setView({ status: "idle" });
      return;
    }
    setView({ status: "loading" });
    fetchPage(0)
      .then((detail) => {
        if (run === seq.current) setView(detail ? { status: "ready", detail } : { status: "error" });
      })
      .catch(() => {
        if (run === seq.current) setView({ status: "error" });
      });
    return () => {
      seq.current += 1;
    };
  }, [messageId, fetchPage]);

  const more = useCallback(async () => {
    if (view.status !== "ready") return;
    const run = seq.current;
    const next = await fetchPage(view.detail.offset + view.detail.people.length).catch(() => null);
    if (run !== seq.current) return;
    if (!next) {
      setView({ status: "error" });
      return;
    }
    setView({
      status: "ready",
      detail: { ...next, offset: view.detail.offset, people: [...view.detail.people, ...next.people] },
    });
  }, [fetchPage, view]);

  return { view, more };
}
