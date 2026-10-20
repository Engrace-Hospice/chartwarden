// M36 WP 5.6 (ADR-0086, PROPOSED) - reads the retention overview and the legal-hold list, and runs apply / release-preview / release against
// /api/v1/messaging/governance (S4 serves them; the contract is in @wardenx/types). Wire keys are snake_case. The routes are not in the generated
// OpenAPI client yet, so the client is narrowed to the one call shape used here. A stale step-up is handed back to the screen; ids are never logged.
import type {
  ApplyMessageLegalHoldRequest,
  MessageLegalHoldDto,
  MessageLegalHoldListDto,
  MessageLegalHoldReleasePreviewDto,
  ReleaseMessageLegalHoldRequest,
  RetentionOverviewDto,
} from "@wardenx/types";
import { RELEASE_PREVIEW_STALE_CODE } from "@wardenx/types";
import { isStepUpRequired } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalApiClient } from "./use-handoffs-enabled";

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };
interface GovernanceClient {
  GET(path: string, init?: unknown): Promise<Reply>;
  POST(path: string, init?: unknown): Promise<Reply>;
}
const BASE = "/api/v1/messaging/governance";
const HOLD_PATH = `${BASE}/legal-holds/{id}`;
const useGovernanceClient = (): GovernanceClient | null =>
  useOptionalApiClient() as unknown as GovernanceClient | null;

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
  | { readonly kind: "denied" }
  | { readonly kind: "failed" };

const failureView = (status: number | undefined): LoadView<never> =>
  status === 401 || status === 403 ? { status: "denied", code: status } : { status: "error" };

const errorCode = (error: unknown): string | undefined => {
  const e = error as { code?: unknown; error?: { code?: unknown } } | null | undefined;
  const code = e?.error?.code ?? e?.code;
  return typeof code === "string" ? code : undefined;
};

function useRead<T>(path: string): { view: LoadView<T>; reload: () => void } {
  const client = useGovernanceClient();
  const [view, setView] = useState<LoadView<T>>({ status: "loading" });
  const scope = useRef(0); // a response settling after a change or an unmount is dropped
  const read = useCallback(async (): Promise<void> => {
    if (!client) {
      setView({ status: "error" });
      return;
    }
    const mine = scope.current;
    try {
      const { data, response } = await client.GET(path);
      if (mine !== scope.current) return;
      setView(data ? { status: "ready", data: data as T } : failureView(response?.status));
    } catch {
      if (mine === scope.current) setView({ status: "error" });
    }
  }, [client, path]);
  useEffect(() => {
    scope.current += 1;
    setView({ status: "loading" });
    void read();
    return () => {
      scope.current += 1;
    };
  }, [read]);
  const reload = useCallback(() => {
    setView({ status: "loading" });
    void read();
  }, [read]);
  return { view, reload };
}

export const useRetentionOverview = () => useRead<RetentionOverviewDto>(`${BASE}/retention`);

export function useLegalHolds(): {
  view: LoadView<readonly MessageLegalHoldDto[]>;
  reload: () => void;
} {
  const { view, reload } = useRead<MessageLegalHoldListDto>(`${BASE}/legal-holds`);
  if (view.status !== "ready") return { view, reload };
  return { view: { status: "ready", data: view.data.holds }, reload };
}

function classify(reply: Reply): ActionResult {
  const status = reply.response?.status;
  if (reply.error === undefined && reply.data !== undefined) return { kind: "ok" };
  if (reply.error !== undefined && isStepUpRequired(reply.error))
    return { kind: "step_up", error: reply.error };
  if (status === 409 && errorCode(reply.error) === RELEASE_PREVIEW_STALE_CODE)
    return { kind: "stale" };
  if (status === 401 || status === 403) return { kind: "denied" };
  if (status === 400 || status === 422) return { kind: "invalid" };
  return { kind: "failed" };
}

export interface LegalHoldActions {
  readonly apply: (body: ApplyMessageLegalHoldRequest) => Promise<ActionResult>;
  readonly release: (id: string, body: ReleaseMessageLegalHoldRequest) => Promise<ActionResult>;
  readonly preview: (id: string) => Promise<MessageLegalHoldReleasePreviewDto | null>;
}

export function useLegalHoldActions(): LegalHoldActions {
  const client = useGovernanceClient();
  const apply = useCallback(
    async (body: ApplyMessageLegalHoldRequest): Promise<ActionResult> => {
      if (!client) return { kind: "failed" };
      try {
        return classify(await client.POST(`${BASE}/legal-holds`, { body }));
      } catch {
        return { kind: "failed" };
      }
    },
    [client],
  );
  const release = useCallback(
    async (id: string, body: ReleaseMessageLegalHoldRequest): Promise<ActionResult> => {
      if (!client) return { kind: "failed" };
      try {
        return classify(
          await client.POST(`${HOLD_PATH}/release`, { params: { path: { id } }, body }),
        );
      } catch {
        return { kind: "failed" };
      }
    },
    [client],
  );
  const preview = useCallback(
    async (id: string): Promise<MessageLegalHoldReleasePreviewDto | null> => {
      if (!client) return null;
      try {
        const { data } = await client.GET(`${HOLD_PATH}/release-preview`, {
          params: { path: { id } },
        });
        return (data as MessageLegalHoldReleasePreviewDto | undefined) ?? null;
      } catch {
        return null;
      }
    },
    [client],
  );
  return { apply, release, preview };
}
