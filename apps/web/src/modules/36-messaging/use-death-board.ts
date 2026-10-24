// M36 WP 6.9 (ADR-0098, PROPOSED) - reads and writes against /api/v1/messaging/death-boards for the death-board screen. Same structural view of
// the shared client as use-partners (same auth, CSRF and idempotency middleware). The list answers `{enabled:false}` while the tenant flag is off,
// which is the screen's signal to say "not turned on" instead of "nothing to do".
import type { DeathBoardItemDto, DeathBoardListDto } from "@chartwarden/types";
import type { ApiClient } from "@chartwarden/ui";
import { useCallback, useMemo } from "react";
import { type ExportResult, classify } from "./use-export";
import { useOptionalApiClient } from "./use-handoffs-enabled";
import { type Fetcher, type LoadView, type Reply, useRead } from "./use-retention";

export type { LoadView } from "./use-retention";

const BOARDS = "/api/v1/messaging/death-boards";
const ITEMS = "/api/v1/messaging/death-board-items";

interface Init {
  readonly params?: { readonly path: { readonly itemId: string } };
  readonly body?: unknown;
}
interface LooseClient {
  GET: (path: string, init?: Init) => Promise<Reply<unknown>>;
  POST: (path: string, init?: Init) => Promise<Reply<unknown>>;
}
const loose = (client: ApiClient): LooseClient => client as unknown as LooseClient;
const typed = <T>(reply: Reply<unknown>): Reply<T> => reply as Reply<T>;

export function useDeathBoards(): {
  view: LoadView<DeathBoardListDto>;
  reload: () => void;
  refreshFailed: boolean;
} {
  const fetcher = useCallback<Fetcher<DeathBoardListDto>>(
    async (c) => typed<DeathBoardListDto>(await loose(c).GET(BOARDS)),
    [],
  );
  return useRead(fetcher);
}

export interface DeathBoardActions {
  readonly complete: (itemId: string) => Promise<ExportResult<{ item: DeathBoardItemDto }>>;
  readonly reassign: (
    itemId: string,
    toUserId: string,
  ) => Promise<ExportResult<{ item: DeathBoardItemDto }>>;
}

export function useDeathBoardActions(): DeathBoardActions {
  const client = useOptionalApiClient();
  return useMemo<DeathBoardActions>(() => {
    const post = async (
      itemId: string,
      action: "complete" | "reassign",
      body?: unknown,
    ): Promise<ExportResult<{ item: DeathBoardItemDto }>> => {
      if (!client) return { kind: "failed" };
      try {
        return classify(
          typed<{ item: DeathBoardItemDto }>(
            await loose(client).POST(`${ITEMS}/{itemId}/${action}`, {
              params: { path: { itemId } },
              ...(body ? { body } : {}),
            }),
          ),
        );
      } catch {
        return { kind: "failed" };
      }
    };
    return {
      complete: (itemId) => post(itemId, "complete"),
      reassign: (itemId, toUserId) => post(itemId, "reassign", { to_user_id: toUserId }),
    };
  }, [client]);
}
