import { BACKGROUND_REQUEST_HEADERS, type operations, useApiClient } from "@wardenx/ui";
// apps/web/src/shell — the shared client state for the global alert inbox. The shell owns the
// global bell, while M36 consumes this provider for the full inbox screen (ADR-0030).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { JSX, ReactNode } from "react";
import type { NavigateFunction } from "react-router-dom";
import { useSessionState } from "./session";

/** Fresh enough for operational alerts without creating a request per render or per component. */
export const ALERT_INBOX_POLL_INTERVAL_MS = 60_000;

type AlertInboxResponse =
  operations["getApiV1AlertsInbox"]["responses"][200]["content"]["application/json"];

/** Generated OpenAPI contract for an alert shown to the current actor. */
export type AlertInboxItem = AlertInboxResponse["alerts"][number];

interface AlertInboxContextValue {
  readonly alerts: AlertInboxItem[] | null;
  readonly unreadCount: number;
  readonly loading: boolean;
  readonly loadFailed: boolean;
  load: (options?: { background?: boolean }) => Promise<void>;
  markRead: (alert: AlertInboxItem) => void;
  activateAlert: (alert: AlertInboxItem, navigate: NavigateFunction) => void;
}

const AlertInboxContext = createContext<AlertInboxContextValue | null>(null);

/** A deep link is data, never an instruction to leave the authenticated SPA. */
export function isInternalAlertDeepLink(deepLink: string | null): deepLink is string {
  return deepLink !== null && /^\/(?!\/)/.test(deepLink);
}

export function AlertInboxProvider({ children }: { children: ReactNode }): JSX.Element {
  const client = useApiClient();
  const { session, status } = useSessionState();
  const [alerts, setAlerts] = useState<AlertInboxItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const markingRead = useRef(new Set<string>());
  const loadInFlight = useRef<Promise<void> | null>(null);
  const scopeRef = useRef<string | null>(null);
  const scope =
    status === "authenticated" && session ? `${session.organizationId}:${session.userId}` : null;

  useEffect(() => {
    scopeRef.current = scope;
    setAlerts(null);
    setLoading(false);
    setLoadFailed(false);
    markingRead.current.clear();
    // A response for the previous user/org must neither hydrate this scope nor block its first fetch.
    loadInFlight.current = null;
  }, [scope]);

  const load = useCallback(
    async (options?: { background?: boolean }): Promise<void> => {
      if (scope === null) return;
      if (loadInFlight.current) return loadInFlight.current;

      setLoading(true);
      const requestScope = scope;
      const response = options?.background
        ? client.GET("/api/v1/alerts/inbox", { headers: BACKGROUND_REQUEST_HEADERS })
        : client.GET("/api/v1/alerts/inbox");
      const request = response
        .then(({ data, error }) => {
          if (scopeRef.current !== requestScope) return;
          if (error) {
            setLoadFailed(true);
            return;
          }
          setLoadFailed(false);
          setAlerts(data?.alerts ?? []);
        })
        .catch(() => {
          if (scopeRef.current === requestScope) setLoadFailed(true);
        })
        .finally(() => {
          if (scopeRef.current === requestScope) setLoading(false);
          if (loadInFlight.current === request) loadInFlight.current = null;
        });
      loadInFlight.current = request;
      return request;
    },
    [client, scope],
  );

  useEffect(() => {
    if (scope === null) return;

    void load();

    const refreshWhenVisible = (): void => {
      if (!document.hidden) void load();
    };
    const poll = (): void => {
      if (!document.hidden) {
        // The background marker prevents this maintenance request from extending idle sessions.
        void load({ background: true });
      }
    };

    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const interval = window.setInterval(poll, ALERT_INBOX_POLL_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(interval);
    };
  }, [load, scope]);

  const markRead = useCallback(
    (alert: AlertInboxItem): void => {
      if (alert.readAt !== null || markingRead.current.has(alert.alertId)) return;

      markingRead.current.add(alert.alertId);
      const readAt = new Date().toISOString();
      setAlerts(
        (current) =>
          current?.map((item) => (item.alertId === alert.alertId ? { ...item, readAt } : item)) ??
          current,
      );

      // Deliberately background work: routing and the optimistic unread count do not wait on it.
      void client
        .POST("/api/v1/alerts/{id}/read", { params: { path: { id: alert.alertId } } })
        .then(({ error }) => {
          if (error) void load(); // Restore the server's canonical state after a failed receipt.
        })
        .catch(() => {
          void load();
        })
        .finally(() => {
          markingRead.current.delete(alert.alertId);
        });
    },
    [client, load],
  );

  const activateAlert = useCallback(
    (alert: AlertInboxItem, navigate: NavigateFunction): void => {
      if (alert.readAt === null) markRead(alert);
      if (isInternalAlertDeepLink(alert.deepLink)) navigate(alert.deepLink);
    },
    [markRead],
  );
  const unreadCount = useMemo(
    () => (alerts ?? []).filter((alert) => alert.readAt === null).length,
    [alerts],
  );

  return (
    <AlertInboxContext.Provider
      value={{ alerts, unreadCount, loading, loadFailed, load, markRead, activateAlert }}
    >
      {children}
    </AlertInboxContext.Provider>
  );
}

export function useAlertInbox(): AlertInboxContextValue {
  const value = useContext(AlertInboxContext);
  if (!value) throw new Error("useAlertInbox must be used within <AlertInboxProvider>");
  return value;
}
