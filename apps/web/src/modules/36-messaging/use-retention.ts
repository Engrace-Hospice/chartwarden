// M36 WP 5.6 (ADR-0086, PROPOSED) - reads the retention overview and the legal-hold list, and runs apply / release-preview / release against
// /api/v1/messaging/governance (S4 serves them; the contract is in @wardenx/types). Wire keys are snake_case. The calls go through the typed
// client with literal paths, so tsc checks the DTOs against the generated schema. A stale step-up is handed back to the screen; ids are never logged.
import type {
  ApplyMessageLegalHoldRequest,
  MessageLegalHoldDto,
  MessageLegalHoldListDto,
  MessageLegalHoldReleasePreviewDto,
  ReleaseMessageLegalHoldRequest,
  RetentionOverviewDto,
} from "@wardenx/types";
import { RELEASE_PREVIEW_STALE_CODE } from "@wardenx/types";
import { type ApiClient, isStepUpRequired } from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalApiClient } from "./use-handoffs-enabled";

interface Reply<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response?: { readonly status: number };
}
type Fetcher<T> = (client: ApiClient) => Promise<Reply<T>>;

const fetchRetention: Fetcher<RetentionOverviewDto> = (c) =>
  c.GET("/api/v1/messaging/governance/retention");
const fetchHolds: Fetcher<MessageLegalHoldListDto> = (c) =>
  c.GET("/api/v1/messaging/governance/legal-holds");

export type LoadView<T> =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "denied"; readonly code: 401 | 403 }
  | { readonly status: "ready"; readonly data: T };

export type ActionResult =
  | { readonly kind: "ok" }
  | { readonly kind: "step_up"; readonly error: unknown }
  | { readonly kind: "stale" }
  | { readonly kind: "invalid" }
  | { readonly kind: "denied"; readonly code: 401 | 403 }
  | { readonly kind: "failed" };

const failureView = (status: number | undefined): LoadView<never> =>
  status === 401 || status === 403 ? { status: "denied", code: status } : { status: "error" };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const errorCode = (error: unknown): string | undefined => {
  if (!isRecord(error)) return undefined;
  const code = (isRecord(error.error) ? error.error.code : undefined) ?? error.code;
  return typeof code === "string" ? code : undefined;
};

/** Stale-while-revalidate: only the first load shows "loading"; a reload keeps the previous data on screen until the
 *  newest response lands, and only the newest request may apply (an older one settling late is dropped). A reload that
 *  fails with a plain error keeps the data and raises `refreshFailed` (an inline Retry); a refusal (401/403) replaces it. */
function useRead<T>(fetcher: Fetcher<T>): {
  view: LoadView<T>;
  reload: () => void;
  refreshFailed: boolean;
} {
  const client = useOptionalApiClient();
  const [view, setView] = useState<LoadView<T>>({ status: "loading" });
  const [refreshFailed, setRefreshFailed] = useState(false);
  const scope = useRef(0);
  const hasData = useRef(false);
  const apply = useCallback((next: LoadView<T>): void => {
    if (next.status === "ready") {
      hasData.current = true;
      setRefreshFailed(false);
      setView(next);
    } else if (next.status === "error" && hasData.current) {
      setRefreshFailed(true);
    } else {
      hasData.current = false;
      setRefreshFailed(false);
      setView(next);
    }
  }, []);
  const read = useCallback(async (): Promise<void> => {
    scope.current += 1;
    const mine = scope.current;
    if (!client) {
      apply({ status: "error" });
      return;
    }
    try {
      const { data, response } = await fetcher(client);
      if (mine !== scope.current) return;
      apply(data ? { status: "ready", data } : failureView(response?.status));
    } catch {
      if (mine === scope.current) apply({ status: "error" });
    }
  }, [client, fetcher, apply]);
  useEffect(() => {
    hasData.current = false;
    setRefreshFailed(false);
    setView({ status: "loading" });
    void read();
    return () => {
      scope.current += 1; // an unmount or a new client drops whatever is still in flight
    };
  }, [read]);
  const reload = useCallback((): void => {
    setRefreshFailed(false);
    if (!hasData.current) setView({ status: "loading" }); // Retry from the error view shows the spinner
    void read();
  }, [read]);
  return { view, reload, refreshFailed };
}

export const useRetentionOverview = () => useRead<RetentionOverviewDto>(fetchRetention);

export function useLegalHolds(): {
  view: LoadView<readonly MessageLegalHoldDto[]>;
  reload: () => void;
  refreshFailed: boolean;
} {
  const { view, reload, refreshFailed } = useRead<MessageLegalHoldListDto>(fetchHolds);
  const mapped = useMemo<LoadView<readonly MessageLegalHoldDto[]>>(
    () => (view.status === "ready" ? { status: "ready", data: view.data.holds } : view),
    [view],
  );
  return { view: mapped, reload, refreshFailed };
}

function classify(reply: Reply<unknown>): ActionResult {
  const status = reply.response?.status;
  if (reply.error === undefined && reply.data !== undefined) return { kind: "ok" };
  if (reply.error !== undefined && isStepUpRequired(reply.error))
    return { kind: "step_up", error: reply.error };
  if (status === 409 && errorCode(reply.error) === RELEASE_PREVIEW_STALE_CODE)
    return { kind: "stale" };
  if (status === 401 || status === 403) return { kind: "denied", code: status };
  if (status === 400 || status === 422) return { kind: "invalid" };
  return { kind: "failed" };
}

// The generated schema types the id lists as mutable arrays where the shared DTO says readonly: copy them (same wire shape).
const toWireApplyBody = (body: ApplyMessageLegalHoldRequest) => ({
  name: body.name,
  reason: body.reason,
  ...(body.channel_ids ? { channel_ids: [...body.channel_ids] } : {}),
  ...(body.user_ids ? { user_ids: [...body.user_ids] } : {}),
  ...(body.patient_ids ? { patient_ids: [...body.patient_ids] } : {}),
  ...(body.org_wide === undefined ? {} : { org_wide: body.org_wide }),
});

export interface LegalHoldActions {
  readonly apply: (body: ApplyMessageLegalHoldRequest) => Promise<ActionResult>;
  readonly release: (id: string, body: ReleaseMessageLegalHoldRequest) => Promise<ActionResult>;
  readonly preview: (id: string) => Promise<MessageLegalHoldReleasePreviewDto | null>;
}

export function useLegalHoldActions(): LegalHoldActions {
  const client = useOptionalApiClient();
  return useMemo<LegalHoldActions>(
    () => ({
      async apply(body) {
        if (!client) return { kind: "failed" };
        try {
          return classify(
            await client.POST("/api/v1/messaging/governance/legal-holds", {
              body: toWireApplyBody(body),
            }),
          );
        } catch {
          return { kind: "failed" };
        }
      },
      async release(id, body) {
        if (!client) return { kind: "failed" };
        try {
          return classify(
            await client.POST("/api/v1/messaging/governance/legal-holds/{id}/release", {
              params: { path: { id } },
              body,
            }),
          );
        } catch {
          return { kind: "failed" };
        }
      },
      async preview(id) {
        if (!client) return null;
        try {
          const { data } = await client.GET(
            "/api/v1/messaging/governance/legal-holds/{id}/release-preview",
            { params: { path: { id } } },
          );
          return data ?? null;
        } catch {
          return null;
        }
      },
    }),
    [client],
  );
}
