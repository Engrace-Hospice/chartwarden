// M36 WP 6.1 (ADR-0091) - reads the smart work inbox. A failed refresh keeps the last answer and says it may be stale; 401/403 end the
// reads (fail closed, no retry); the safety-net poll re-reads because a request can become overdue with nobody touching the page.
import type { SmartInboxResponse } from "@chartwarden/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalApiClient } from "./use-handoffs-enabled";
import { useLatestPolling } from "./use-latest-polling";

export type SmartInboxView =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "denied"; readonly code: 401 | 403 }
  | { readonly status: "ready"; readonly inbox: SmartInboxResponse; readonly stale: boolean };

const DENIED = new Set([401, 403]);

export function useSmartInbox(): { readonly view: SmartInboxView; readonly retry: () => void } {
  const client = useOptionalApiClient();
  const [view, setView] = useState<SmartInboxView>({ status: "loading" });
  const denied = useRef(false);
  const latest = useRef(0);
  const controller = useRef<AbortController | null>(null);

  // A newer read (or a client change / unmount, which bump `latest` and abort) supersedes an older one: its answer is dropped.
  const read = useCallback(async (): Promise<boolean | undefined> => {
    if (!client || denied.current) return undefined;
    controller.current?.abort();
    const mine = ++latest.current;
    const mineController = new AbortController();
    controller.current = mineController;
    const apply = (next: (prev: SmartInboxView) => SmartInboxView): void => {
      if (mine === latest.current) setView(next);
    };
    try {
      const { data, response } = await client.GET("/api/v1/messaging/inbox", {
        signal: mineController.signal,
      });
      if (mine !== latest.current) return undefined;
      if (data) {
        apply(() => ({ status: "ready", inbox: data as SmartInboxResponse, stale: false }));
        return true;
      }
      const code = response?.status ?? 0;
      if (DENIED.has(code)) {
        denied.current = true;
        apply(() => ({ status: "denied", code: code as 401 | 403 }));
        return undefined;
      }
    } catch {
      if (mine !== latest.current) return undefined;
      // fall through: a network failure is an error or a stale answer, never an empty inbox
    }
    apply((prev) => (prev.status === "ready" ? { ...prev, stale: true } : { status: "error" }));
    return false;
  }, [client]);

  useEffect(() => {
    // A different API client is a different session: forget the last user's denial and answer until this one reads.
    denied.current = false;
    setView({ status: "loading" });
    void read();
    return () => {
      latest.current += 1;
      controller.current?.abort();
    };
  }, [read]);

  useLatestPolling(read, false);

  const retry = useCallback(() => {
    setView((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    void read();
  }, [read]);

  return { view, retry };
}
