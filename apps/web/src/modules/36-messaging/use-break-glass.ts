// M36 WP 5.8 (ADR-0087, PROPOSED) - reads and writes against /api/v1/messaging/break-glass through the typed client with literal paths, so tsc checks
// the DTOs against the generated schema. A stale step-up is handed back to the screen; ids, justifications and notes are never logged.
import type {
  BreakGlassGrantDto,
  BreakGlassReviewDetailDto,
  BreakGlassReviewDto,
  CompleteBreakGlassReviewRequest,
  CreateBreakGlassRequest,
} from "@chartwarden/types";
import { type ApiClient, isStepUpRequired } from "@chartwarden/ui";
import { useCallback, useMemo } from "react";
import { useOptionalApiClient } from "./use-handoffs-enabled";
import { type Fetcher, type LoadView, type Reply, errorCode, useRead } from "./use-retention";

export type { LoadView } from "./use-retention";

export type ReviewStatusFilter = "pending" | "reviewed" | "all";

export type BreakGlassResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | { readonly kind: "step_up"; readonly error: unknown }
  /** 404: the same answer for every refusal; the screen must not guess a reason. */
  | { readonly kind: "not_available" }
  /** 409 with its code (BREAK_GLASS_NOT_NEEDED, _ALREADY_ACTIVE, _STILL_ACTIVE, _REVIEW_DONE). */
  | { readonly kind: "conflict"; readonly code: string | undefined }
  | { readonly kind: "invalid" }
  | { readonly kind: "denied"; readonly code: 401 | 403 }
  | { readonly kind: "failed" };

function classify<T>(reply: Reply<T>): BreakGlassResult<T> {
  const status = reply.response?.status;
  if (reply.error === undefined && reply.data !== undefined)
    return { kind: "ok", data: reply.data };
  if (reply.error !== undefined && isStepUpRequired(reply.error)) {
    return { kind: "step_up", error: reply.error };
  }
  if (status === 404) return { kind: "not_available" };
  if (status === 409) return { kind: "conflict", code: errorCode(reply.error) };
  if (status === 401 || status === 403) return { kind: "denied", code: status };
  if (status === 400 || status === 422) return { kind: "invalid" };
  return { kind: "failed" };
}

const fetchMine: Fetcher<{ grants: BreakGlassGrantDto[] }> = (c) =>
  c.GET("/api/v1/messaging/break-glass/mine");

/** The caller's own grants (newest first). A reload re-reads by the server's instants. */
export function useMyGrants(): {
  view: LoadView<readonly BreakGlassGrantDto[]>;
  reload: () => void;
} {
  const { view, reload } = useRead(fetchMine);
  const mapped = useMemo<LoadView<readonly BreakGlassGrantDto[]>>(
    () => (view.status === "ready" ? { status: "ready", data: view.data.grants ?? [] } : view),
    [view],
  );
  return { view: mapped, reload };
}

export function useReviews(status: ReviewStatusFilter): {
  view: LoadView<readonly BreakGlassReviewDto[]>;
  reload: () => void;
  refreshFailed: boolean;
} {
  const fetcher = useCallback<Fetcher<{ reviews: BreakGlassReviewDto[] }>>(
    (c) => c.GET("/api/v1/messaging/break-glass/reviews", { params: { query: { status } } }),
    [status],
  );
  const { view, reload, refreshFailed } = useRead(fetcher);
  const mapped = useMemo<LoadView<readonly BreakGlassReviewDto[]>>(
    () => (view.status === "ready" ? { status: "ready", data: view.data.reviews ?? [] } : view),
    [view],
  );
  return { view: mapped, reload, refreshFailed };
}

export function useReviewDetail(reviewId: string): {
  view: LoadView<BreakGlassReviewDetailDto>;
  reload: () => void;
} {
  const fetcher = useCallback<Fetcher<BreakGlassReviewDetailDto>>(
    (c: ApiClient) =>
      c.GET("/api/v1/messaging/break-glass/reviews/{id}", { params: { path: { id: reviewId } } }),
    [reviewId],
  );
  const { view, reload } = useRead(fetcher);
  return { view, reload };
}

export interface BreakGlassActions {
  readonly create: (body: CreateBreakGlassRequest) => Promise<BreakGlassResult<BreakGlassGrantDto>>;
  readonly end: (grantId: string) => Promise<BreakGlassResult<BreakGlassGrantDto>>;
  readonly complete: (
    reviewId: string,
    body: CompleteBreakGlassReviewRequest,
  ) => Promise<BreakGlassResult<BreakGlassReviewDetailDto>>;
}

export function useBreakGlassActions(): BreakGlassActions {
  const client = useOptionalApiClient();
  return useMemo<BreakGlassActions>(
    () => ({
      async create(body) {
        if (!client) return { kind: "failed" };
        try {
          return classify(await client.POST("/api/v1/messaging/break-glass", { body }));
        } catch {
          return { kind: "failed" };
        }
      },
      async end(grantId) {
        if (!client) return { kind: "failed" };
        try {
          return classify(
            await client.POST("/api/v1/messaging/break-glass/{id}/end", {
              params: { path: { id: grantId } },
            }),
          );
        } catch {
          return { kind: "failed" };
        }
      },
      async complete(reviewId, body) {
        if (!client) return { kind: "failed" };
        try {
          return classify(
            await client.POST("/api/v1/messaging/break-glass/reviews/{id}/complete", {
              params: { path: { id: reviewId } },
              body,
            }),
          );
        } catch {
          return { kind: "failed" };
        }
      },
    }),
    [client],
  );
}
