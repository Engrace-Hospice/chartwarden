// M36 WP 4.6 - the caller's own notification preferences. The preferences route itself is not tenant-flag gated, so the flag
// `messaging.notification_policy` is probed through `GET /messaging/reminders` (404 when it is off; the same signal use-reminders reads).
// Off, 401/403 and any failure all fail closed: nothing is shown or written.
import { useCallback, useEffect, useState } from "react";
import { useOptionalApiClient } from "./use-promotions-enabled";

export type Channel = "in_app" | "push" | "sms" | "email" | "voice";
export interface QuietRange {
  readonly daysOfWeek: readonly number[];
  readonly start: string;
  readonly end: string;
}
export interface QuietHours {
  readonly tz: string;
  readonly ranges: readonly QuietRange[];
  readonly severityOverride: "info" | "warn" | "critical";
}
export type RoutingMap = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
export interface Preferences {
  readonly routingMap: RoutingMap;
  readonly quietHours: QuietHours;
  readonly vacationForwardToUserId: string | null;
  readonly vacationUntil: string | null;
}

export type PreferencesView =
  | { readonly status: "loading" }
  | { readonly status: "off" }
  | { readonly status: "denied" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly prefs: Preferences };

export type SaveResult =
  | { readonly ok: true; readonly prefs: Preferences }
  | { readonly ok: false; readonly message: string | null };

interface Answer {
  readonly data?: Preferences;
  readonly error?: { readonly error?: { readonly message?: unknown } };
  readonly response?: { readonly status: number };
}
/** Typed loosely: the generated path union makes the full client type too deep to instantiate here. */
interface PrefsClient {
  GET(path: string): Promise<Answer>;
  PUT(path: string, init: { body: Preferences }): Promise<Answer>;
}

const FLAG_PROBE = "/api/v1/messaging/reminders";
const PREFS = "/api/v1/notifications/preferences";

export function useNotificationPreferences() {
  const client = useOptionalApiClient() as PrefsClient | null;
  const [view, setView] = useState<PreferencesView>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the read on Retry
  useEffect(() => {
    if (!client) {
      setView({ status: "off" });
      return;
    }
    let current = true;
    const settle = (next: PreferencesView): void => {
      if (current) setView(next);
    };
    void (async () => {
      try {
        const flag = await client.GET(FLAG_PROBE);
        if (flag.response?.status === 404) return settle({ status: "off" });
        if (!flag.data) return settle({ status: "error" });
        const read = await client.GET(PREFS);
        const status = read.response?.status;
        if (read.data) return settle({ status: "ready", prefs: read.data });
        settle({ status: status === 401 || status === 403 || status === 404 ? "denied" : "error" });
      } catch {
        settle({ status: "error" });
      }
    })();
    return () => {
      current = false;
    };
  }, [client, attempt]);

  const retry = useCallback(() => {
    setView({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  /** One PUT of the whole draft; a refusal (422 / 409) carries the server's own words. */
  const save = useCallback(
    async (draft: Preferences): Promise<SaveResult> => {
      if (!client) return { ok: false, message: null };
      try {
        const res = await client.PUT(PREFS, { body: draft });
        // The PUT answers only { id, updatedAt }, not the preferences: what was sent is what is now stored.
        if (res.data && !res.error) return { ok: true, prefs: draft };
        const message = res.error?.error?.message;
        return { ok: false, message: typeof message === "string" && message ? message : null };
      } catch {
        return { ok: false, message: null };
      }
    },
    [client],
  );

  return { view, retry, save };
}
