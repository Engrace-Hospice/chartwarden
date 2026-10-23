// M36 WP 5.6 (ADR-0055 item 7, ADR-0086, PROPOSED) - reads the redaction list and runs request / approve / self-approve / countersign against
// /api/v1/messaging/governance/redactions. Typed client with literal paths. A stale step-up is handed back to the screen (same as the hold actions);
// ids and reasons are never logged.
import type { MessageRedactionListDto, RequestMessageRedactionRequest } from "@chartwarden/types";
import { isStepUpRequired } from "@chartwarden/ui";
import { useMemo } from "react";
import { useOptionalApiClient } from "./use-handoffs-enabled";
import { type Fetcher, type LoadView, errorCode, useRead } from "./use-retention";

const fetchRedactions: Fetcher<MessageRedactionListDto> = (c) =>
  c.GET("/api/v1/messaging/governance/redactions");

export function useRedactions(): {
  view: LoadView<MessageRedactionListDto>;
  reload: () => void;
  refreshFailed: boolean;
} {
  return useRead<MessageRedactionListDto>(fetchRedactions);
}

export type RedactionResult =
  | { readonly kind: "ok" }
  | { readonly kind: "step_up"; readonly error: unknown }
  | { readonly kind: "denied"; readonly code: 401 | 403 }
  | { readonly kind: "same_person" }
  | { readonly kind: "lapsed" }
  | { readonly kind: "exists" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid" }
  | { readonly kind: "failed" };

interface Reply {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response?: { readonly status: number };
}

export function classifyRedaction(reply: Reply): RedactionResult {
  const status = reply.response?.status;
  if (reply.error === undefined && reply.data !== undefined) return { kind: "ok" };
  if (reply.error !== undefined && isStepUpRequired(reply.error))
    return { kind: "step_up", error: reply.error };
  const code = errorCode(reply.error);
  if (code === "REDACTION_SELF_APPROVAL" || code === "REDACTION_COUNTERSIGN_SELF")
    return { kind: "same_person" };
  if (code === "REDACTION_FALLBACK_UNAVAILABLE") return { kind: "unavailable" };
  if (code === "REDACTION_COUNTERSIGN_LAPSED") return { kind: "lapsed" };
  if (code === "REDACTION_EXISTS") return { kind: "exists" };
  if (status === 409) return { kind: "unavailable" };
  if (status === 404) return { kind: "not_found" };
  if (status === 401 || status === 403) return { kind: "denied", code: status };
  if (status === 400 || status === 422) return { kind: "invalid" };
  return { kind: "failed" };
}

export type DecisionKind = "approve" | "self_approve" | "countersign";

export interface RedactionActions {
  readonly request: (body: RequestMessageRedactionRequest) => Promise<RedactionResult>;
  readonly decide: (kind: DecisionKind, id: string) => Promise<RedactionResult>;
}

export function useRedactionActions(): RedactionActions {
  const client = useOptionalApiClient();
  return useMemo<RedactionActions>(
    () => ({
      async request(body) {
        if (!client) return { kind: "failed" };
        try {
          return classifyRedaction(
            await client.POST("/api/v1/messaging/governance/redactions", { body }),
          );
        } catch {
          return { kind: "failed" };
        }
      },
      async decide(kind, id) {
        if (!client) return { kind: "failed" };
        const init = { params: { path: { id } } };
        try {
          return classifyRedaction(
            kind === "approve"
              ? await client.POST("/api/v1/messaging/governance/redactions/{id}/approve", init)
              : kind === "self_approve"
                ? await client.POST(
                    "/api/v1/messaging/governance/redactions/{id}/self-approve",
                    init,
                  )
                : await client.POST(
                    "/api/v1/messaging/governance/redactions/{id}/countersign",
                    init,
                  ),
          );
        } catch {
          return { kind: "failed" };
        }
      },
    }),
    [client],
  );
}
