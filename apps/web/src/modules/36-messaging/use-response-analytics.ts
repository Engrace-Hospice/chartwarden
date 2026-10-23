// M36 WP 6.2 (ADR-0092, PROPOSED) - reads GET /api/v1/messaging/analytics/response through the typed client. The server answers 404 while
// the tenant flag is off (shown as the "not turned on" panel), 401/403 as no access. A newer request supersedes an older one.
import type { AnalyticsGroupBy, ResponseAnalyticsReport } from "@chartwarden/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalApiClient } from "./use-handoffs-enabled";

export type AnalyticsView =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "flag_off" }
  | { readonly status: "denied"; readonly code: 401 | 403 }
  | { readonly status: "ready"; readonly report: ResponseAnalyticsReport };

const DAY_MS = 86_400_000;

export function useResponseAnalytics(
  days: number,
  groupBy: AnalyticsGroupBy,
): { view: AnalyticsView; reload: () => void } {
  const client = useOptionalApiClient();
  const [view, setView] = useState<AnalyticsView>({ status: "loading" });
  const latest = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    latest.current += 1;
    const mine = latest.current;
    const apply = (next: AnalyticsView): void => {
      if (mine === latest.current) setView(next);
    };
    if (!client) return apply({ status: "error" });
    const to = new Date();
    const from = new Date(to.getTime() - days * DAY_MS);
    try {
      const { data, response } = await client.GET("/api/v1/messaging/analytics/response", {
        params: { query: { from: from.toISOString(), to: to.toISOString(), groupBy } },
      });
      const status = response?.status;
      if (data) return apply({ status: "ready", report: data as ResponseAnalyticsReport });
      if (status === 404) return apply({ status: "flag_off" });
      if (status === 401 || status === 403) return apply({ status: "denied", code: status });
      apply({ status: "error" });
    } catch {
      apply({ status: "error" });
    }
  }, [client, days, groupBy]);

  useEffect(() => {
    setView({ status: "loading" });
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  return { view, reload: () => void load() };
}
