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
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const latest = useRef(0);
  const hasData = useRef(false);
  const ackInFlight = useRef(false);
  const withdrawInFlight = useRef(false);
  const mounted = useRef(true);
  const [withdrawState, setWithdrawState] = useState<"idle" | "busy" | "failed">("idle");

  const load = useCallback(async () => {
    if (!client) {
      setMine({ status: "off" });
      setOversee({ status: "hidden" });
      return;
    }
    const run = ++latest.current;
    const current = (): boolean => run === latest.current;
    // Both reads start together; the oversight list is dropped when the caller's own list says off or denied.
    const overseeRead = client.GET("/api/v1/messaging/ack-broadcasts").then(
      (res) => ({ ok: true as const, res }),
      () => ({ ok: false as const }),
    );
    let mineEnded = false;
    const mineFailed = (): void => {
      if (hasData.current) setRefreshFailed(true);
      else setMine({ status: "error" });
    };
    try {
      const res = await client.GET("/api/v1/messaging/ack-broadcasts/mine");
      if (!current()) return;
      const code = res.response?.status ?? 0;
      if (res.data) {
        hasData.current = true;
        setRefreshFailed(false);
        setMine({ status: "ready", items: res.data.items });
      } else if (code === 404) {
        mineEnded = true;
        hasData.current = false;
        setMine({ status: "off" });
      } else if (code === 401 || code === 403) {
        mineEnded = true;
        hasData.current = false;
        setMine({ status: "denied", code });
      } else mineFailed();
    } catch {
      if (!current()) return;
      mineFailed();
    }
    if (mineEnded) {
      setOversee({ status: "hidden" });
      return;
    }
    const out = await overseeRead;
    if (!current()) return;
    const keepOrError = (prev: OverseeView): OverseeView =>
      prev.status === "ready" ? prev : { status: "error" };
    if (!out.ok) {
      setOversee(keepOrError);
      return;
    }
    const code = out.res.response?.status ?? 0;
    if (out.res.data) setOversee({ status: "ready", broadcasts: out.res.data.broadcasts });
    else if (code === 401 || code === 403 || code === 404) setOversee({ status: "hidden" });
    else setOversee(keepOrError);
  }, [client]);

  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** The caller's own explicit acknowledgment. Returns the record or null (and says so) on failure. */
  const acknowledge = useCallback(
    async (messageId: string): Promise<AckBroadcastAcknowledged | null> => {
      if (!client || ackInFlight.current) return null;
      ackInFlight.current = true;
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
        const { acknowledgedAt } = res.data;
        // Show the recorded fact now; the reload then confirms it (a failed reload keeps this and says so).
        setMine((prev) =>
          prev.status === "ready"
            ? {
                status: "ready",
                items: prev.items.map((i) =>
                  i.messageId === messageId ? { ...i, acknowledgedAt } : i,
                ),
              }
            : prev,
        );
        await load();
        return res.data;
      } catch {
        setAckError(true);
        return null;
      } finally {
        ackInFlight.current = false;
        setBusy(null);
      }
    },
    [client, load],
  );

  /** The author stops asking (ADR-0097 D14). One at a time; true on success. The recorded fact is shown at once, the reload then confirms it. */
  const withdraw = useCallback(
    async (messageId: string): Promise<boolean> => {
      if (!client || withdrawInFlight.current) return false;
      withdrawInFlight.current = true;
      setWithdrawState("busy");
      try {
        const res = await client.POST(
          "/api/v1/messaging/announcements/{messageId}/ack-broadcast/withdraw",
          {
            params: { path: { messageId } },
          },
        );
        if (!mounted.current) return false;
        if (!res.data) {
          setWithdrawState("failed");
          return false;
        }
        const { withdrawnAt } = res.data;
        setWithdrawState("idle");
        setOversee((prev) =>
          prev.status === "ready"
            ? {
                status: "ready",
                broadcasts: prev.broadcasts.map((b) =>
                  b.messageId === messageId ? { ...b, withdrawnAt, pastDeadline: false } : b,
                ),
              }
            : prev,
        );
        await load();
        return true;
      } catch {
        if (mounted.current) setWithdrawState("failed");
        return false;
      } finally {
        withdrawInFlight.current = false;
      }
    },
    [client, load],
  );
  const clearWithdrawError = useCallback(() => setWithdrawState("idle"), []);

  return {
    mine,
    oversee,
    ackError,
    refreshFailed,
    busy,
    acknowledge,
    reload: load,
    withdraw,
    withdrawState,
    clearWithdrawError,
  };
}

export type DetailView =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly detail: AckBroadcastDetail };

export type MoreState = "idle" | "busy" | "failed";

/** One broadcast's people for the supervisor, paged exactly; "show more" appends the next page. */
export function useBroadcastDetail(messageId: string | null, filter: AckBroadcastFilter) {
  const client = useOptionalApiClient();
  const [view, setView] = useState<DetailView>({ status: "idle" });
  const [moreState, setMoreState] = useState<MoreState>("idle");
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const moreInFlight = useRef(false);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the manual re-read trigger
  useEffect(() => {
    const run = ++seq.current;
    moreInFlight.current = false;
    setMoreState("idle");
    if (!messageId) {
      setView({ status: "idle" });
      return;
    }
    setView({ status: "loading" });
    fetchPage(0)
      .then((detail) => {
        if (run === seq.current)
          setView(detail ? { status: "ready", detail } : { status: "error" });
      })
      .catch(() => {
        if (run === seq.current) setView({ status: "error" });
      });
    return () => {
      seq.current += 1;
    };
  }, [messageId, fetchPage, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /** Appends the next page. One request at a time; a failure keeps the pages already loaded and offers a retry. */
  const more = useCallback(async () => {
    if (view.status !== "ready" || moreInFlight.current) return;
    moreInFlight.current = true;
    setMoreState("busy");
    const run = seq.current;
    const next = await fetchPage(view.detail.offset + view.detail.people.length).catch(() => null);
    if (run !== seq.current) return;
    moreInFlight.current = false;
    if (!next) {
      setMoreState("failed");
      return;
    }
    setMoreState("idle");
    setView({
      status: "ready",
      detail: {
        ...next,
        offset: view.detail.offset,
        people: [...view.detail.people, ...next.people],
      },
    });
  }, [fetchPage, view]);

  return { view, more, moreState, reload };
}
