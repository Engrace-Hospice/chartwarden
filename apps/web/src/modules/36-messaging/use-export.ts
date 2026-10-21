// M36 WP 5.7 (ADR-0089, PROPOSED) - reads and writes against /api/v1/messaging/export. The generated client schema does not know these routes yet, so the
// calls go through a small structural view of the same client (same auth, CSRF and idempotency middleware) and are typed against the DTOs in
// @chartwarden/types. A stale step-up is handed back to the screen; ids, justifications and notes are never logged.
import type {
  CreateMessagingExportRequest,
  DecideMessagingExportRequest,
  MessagingExportJobDetailDto,
  MessagingExportJobSummaryDto,
} from "@chartwarden/types";
import { type ApiClient, isStepUpRequired } from "@chartwarden/ui";
import { useCallback, useMemo } from "react";
import { useOptionalApiClient } from "./use-handoffs-enabled";
import { type Fetcher, type LoadView, type Reply, errorCode, useRead } from "./use-retention";

export type { LoadView } from "./use-retention";

const BASE = "/api/v1/messaging/export";

interface Init {
  readonly params?: { readonly path: { readonly id: string } };
  readonly body?: unknown;
  readonly parseAs?: "blob";
}
interface LooseClient {
  GET: (path: string, init?: Init) => Promise<Reply<unknown>>;
  POST: (path: string, init?: Init) => Promise<Reply<unknown>>;
}
const loose = (client: ApiClient): LooseClient => client as unknown as LooseClient;
const typed = <T>(reply: Reply<unknown>): Reply<T> => reply as Reply<T>;

export type ExportResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | { readonly kind: "step_up"; readonly error: unknown }
  /** 404: the same answer for every refusal (flag off included); the screen must not guess a reason. */
  | { readonly kind: "not_available" }
  /** 409 with its code (EXPORT_ALREADY_DECIDED, _NOT_READY, _EXPIRED, _TOO_LARGE). */
  | { readonly kind: "conflict"; readonly code: string | undefined }
  | { readonly kind: "invalid" }
  /** 429 (EXPORT_LIMIT). */
  | { readonly kind: "limit" }
  | { readonly kind: "denied"; readonly code: 401 | 403 }
  | { readonly kind: "failed" };

export function classify<T>(reply: Reply<T>): ExportResult<T> {
  const status = reply.response?.status;
  if (reply.error === undefined && reply.data !== undefined)
    return { kind: "ok", data: reply.data };
  if (reply.error !== undefined && isStepUpRequired(reply.error))
    return { kind: "step_up", error: reply.error };
  if (status === 429) return { kind: "limit" };
  if (status === 404) return { kind: "not_available" };
  if (status === 409) return { kind: "conflict", code: errorCode(reply.error) };
  if (status === 401 || status === 403) return { kind: "denied", code: status };
  if (status === 400 || status === 422) return { kind: "invalid" };
  return { kind: "failed" };
}

interface JobList {
  jobs?: MessagingExportJobSummaryDto[];
}

function useJobList(path: string): {
  view: LoadView<readonly MessagingExportJobSummaryDto[]>;
  reload: () => void;
  refreshFailed: boolean;
} {
  const fetcher = useCallback<Fetcher<JobList>>(
    async (c) => typed<JobList>(await loose(c).GET(path)),
    [path],
  );
  const { view, reload, refreshFailed } = useRead(fetcher);
  const mapped = useMemo<LoadView<readonly MessagingExportJobSummaryDto[]>>(
    () => (view.status === "ready" ? { status: "ready", data: view.data.jobs ?? [] } : view),
    [view],
  );
  return { view: mapped, reload, refreshFailed };
}

/** The caller's own export jobs (newest first). */
export const useMyExports = () => useJobList(`${BASE}/mine`);
/** The approver queue: pending requests, never the caller's own. */
export const usePendingExports = () => useJobList(`${BASE}/pending`);

export function useExportDetail(id: string): {
  view: LoadView<MessagingExportJobDetailDto>;
  reload: () => void;
} {
  const fetcher = useCallback<Fetcher<MessagingExportJobDetailDto>>(
    async (c) =>
      typed<MessagingExportJobDetailDto>(
        await loose(c).GET(`${BASE}/{id}`, { params: { path: { id } } }),
      ),
    [id],
  );
  const { view, reload } = useRead(fetcher);
  return { view, reload };
}

/** Saves a blob as a file through a temporary anchor. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface ExportActions {
  readonly create: (
    body: CreateMessagingExportRequest,
  ) => Promise<ExportResult<MessagingExportJobSummaryDto>>;
  readonly approve: (
    id: string,
    body: DecideMessagingExportRequest,
  ) => Promise<ExportResult<MessagingExportJobDetailDto>>;
  readonly reject: (
    id: string,
    body: DecideMessagingExportRequest,
  ) => Promise<ExportResult<MessagingExportJobDetailDto>>;
  readonly cancel: (id: string) => Promise<ExportResult<MessagingExportJobSummaryDto>>;
  /** Fetches the artefact and saves it; the file never touches storage or a URL. */
  readonly download: (id: string) => Promise<ExportResult<true>>;
}

export function useExportActions(): ExportActions {
  const client = useOptionalApiClient();
  return useMemo<ExportActions>(() => {
    const post = async <T>(path: string, init?: Init): Promise<ExportResult<T>> => {
      if (!client) return { kind: "failed" };
      try {
        return classify(typed<T>(await loose(client).POST(path, init)));
      } catch {
        return { kind: "failed" };
      }
    };
    const byId = (id: string, body?: unknown): Init => ({
      params: { path: { id } },
      ...(body === undefined ? {} : { body }),
    });
    return {
      create: (body) => post(BASE, { body }),
      approve: (id, body) => post(`${BASE}/{id}/approve`, byId(id, body)),
      reject: (id, body) => post(`${BASE}/{id}/reject`, byId(id, body)),
      cancel: (id) => post(`${BASE}/{id}/cancel`, byId(id)),
      async download(id) {
        if (!client) return { kind: "failed" };
        try {
          const reply = typed<Blob>(
            await loose(client).GET(`${BASE}/{id}/download`, {
              params: { path: { id } },
              parseAs: "blob",
            }),
          );
          const result = classify(reply);
          if (result.kind !== "ok") return result;
          saveBlob(result.data, `chartwarden-messaging-export-${id}.json`);
          return { kind: "ok", data: true };
        } catch {
          return { kind: "failed" };
        }
      },
    };
  }, [client]);
}
