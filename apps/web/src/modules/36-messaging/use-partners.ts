// M36 WP 6.6 (ADR-0096, PROPOSED) - reads and writes against /api/v1/messaging/external-shares for the staff admin screen. Same structural view of the
// shared client as use-export (same auth, CSRF and idempotency middleware). The invitation token and the code come back ONCE from create and are
// held only in the screen's state; they are never logged, stored or put in a URL.
import type {
  CreateExternalShareRequest,
  CreatedExternalShareDto,
  ExternalShareDto,
} from "@chartwarden/types";
import type { ApiClient } from "@chartwarden/ui";
import { useCallback, useMemo } from "react";
import { type ExportResult, classify } from "./use-export";
import { useOptionalApiClient } from "./use-handoffs-enabled";
import { type Fetcher, type LoadView, type Reply, useRead } from "./use-retention";

export type { LoadView } from "./use-retention";

const BASE = "/api/v1/messaging/external-shares";

interface Init {
  readonly params?: { readonly path: { readonly id: string } };
  readonly body?: unknown;
}
interface LooseClient {
  GET: (path: string, init?: Init) => Promise<Reply<unknown>>;
  POST: (path: string, init?: Init) => Promise<Reply<unknown>>;
  DELETE: (path: string, init?: Init) => Promise<Reply<unknown>>;
}
const loose = (client: ApiClient): LooseClient => client as unknown as LooseClient;
const typed = <T>(reply: Reply<unknown>): Reply<T> => reply as Reply<T>;

interface ShareList {
  shares?: ExternalShareDto[];
}

export function useExternalShares(): {
  view: LoadView<readonly ExternalShareDto[]>;
  reload: () => void;
  refreshFailed: boolean;
} {
  const fetcher = useCallback<Fetcher<ShareList>>(
    async (c) => typed<ShareList>(await loose(c).GET(BASE)),
    [],
  );
  const { view, reload, refreshFailed } = useRead(fetcher);
  const mapped = useMemo<LoadView<readonly ExternalShareDto[]>>(
    () => (view.status === "ready" ? { status: "ready", data: view.data.shares ?? [] } : view),
    [view],
  );
  return { view: mapped, reload, refreshFailed };
}

export interface PartnerActions {
  readonly create: (
    body: CreateExternalShareRequest,
  ) => Promise<ExportResult<CreatedExternalShareDto>>;
  readonly revoke: (id: string) => Promise<ExportResult<ExternalShareDto>>;
  /** D14: new invitation AND new code for an active share; the secrets come back once. */
  readonly reissue: (id: string) => Promise<ExportResult<CreatedExternalShareDto>>;
}

export function usePartnerActions(): PartnerActions {
  const client = useOptionalApiClient();
  return useMemo<PartnerActions>(
    () => ({
      async create(body) {
        if (!client) return { kind: "failed" };
        try {
          return classify(typed<CreatedExternalShareDto>(await loose(client).POST(BASE, { body })));
        } catch {
          return { kind: "failed" };
        }
      },
      async reissue(id) {
        if (!client) return { kind: "failed" };
        try {
          return classify(
            typed<CreatedExternalShareDto>(
              await loose(client).POST(`${BASE}/{id}/reissue`, { params: { path: { id } } }),
            ),
          );
        } catch {
          return { kind: "failed" };
        }
      },
      async revoke(id) {
        if (!client) return { kind: "failed" };
        try {
          return classify(
            typed<ExternalShareDto>(
              await loose(client).DELETE(`${BASE}/{id}`, { params: { path: { id } } }),
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
