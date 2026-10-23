// M36 WP 6.1 (ADR-0100) - reads the smart work inbox. A failed refresh keeps the last answer and says it may be stale; 401/403 end the
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

  const read = useCallback(async (): Promise<boolean | undefined> => {
    if (!client || denied.current) return undefined;
    try {
      const { data, response } = await client.GET("/api/v1/messaging/inbox", {});
      if (data) {
        setView({ status: "ready", inbox: data as SmartInboxResponse, stale: false });
        return true;
      }
      const code = response?.status ?? 0;
      if (DENIED.has(code)) {
        denied.current = true;
        setView({ status: "denied", code: code as 401 | 403 });
        return undefined;
      }
    } catch {
      // fall through: a network failure is an error or a stale answer, never an empty inbox
    }
    setView((prev) => (prev.status === "ready" ? { ...prev, stale: true } : { status: "error" }));
    return false;
  }, [client]);

  useEffect(() => {
    void read();
  }, [read]);

  useLatestPolling(read, false);

  const retry = useCallback(() => {
    setView((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    void read();
  }, [read]);

  return { view, retry };
}
