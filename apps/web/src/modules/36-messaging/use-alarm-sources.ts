// M36 WP 6.10 (ADR-0102, PROPOSED) - the read of /api/v1/messaging/alarm-sources for the alarm sources screen. Read only: creating, rotating and
// disabling a source is done through the API (a fresh step-up each), and the one-time secret is never shown or kept by this screen.
import type { AlarmSourceDto } from "@chartwarden/types";
import type { ApiClient } from "@chartwarden/ui";
import { useCallback, useMemo } from "react";
import { type Fetcher, type LoadView, type Reply, useRead } from "./use-retention";

export type { LoadView } from "./use-retention";

const BASE = "/api/v1/messaging/alarm-sources";

interface LooseClient {
  GET: (path: string) => Promise<Reply<unknown>>;
}
const loose = (client: ApiClient): LooseClient => client as unknown as LooseClient;

interface SourceList {
  sources?: AlarmSourceDto[];
}

export function useAlarmSources(): {
  view: LoadView<readonly AlarmSourceDto[]>;
  reload: () => void;
  refreshFailed: boolean;
} {
  const fetcher = useCallback<Fetcher<SourceList>>(
    async (c) => (await loose(c).GET(BASE)) as Reply<SourceList>,
    [],
  );
  const { view, reload, refreshFailed } = useRead(fetcher);
  const mapped = useMemo<LoadView<readonly AlarmSourceDto[]>>(
    () =>
      view.status !== "ready"
        ? view
        : Array.isArray(view.data.sources)
          ? { status: "ready", data: view.data.sources }
          : { status: "error" },
    [view],
  );
  return { view: mapped, reload, refreshFailed };
}
