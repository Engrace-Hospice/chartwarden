// apps/web/src/modules/41-billing-commercial — the provider entity every commercial read is scoped to (the API requires one, and
// proves the actor reaches it). The choice lives in the URL (`?entity=`) so a queue, a payer view and a shared link agree; with
// none chosen, the first entity the actor can see is used, which is the whole picture for a single-entity agency.
import { useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

export interface ProviderEntityOption {
  readonly id: string;
  readonly legalName: string;
  readonly ccn: string | null;
}

export type ProviderEntityState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly entities: readonly ProviderEntityOption[] };

const ENTITY_PARAM = "entity";
const ENTITY_PAGE_SIZE = 100;

export function useProviderEntity(): {
  state: ProviderEntityState;
  entityId: string;
  setEntityId: (id: string) => void;
  retry: () => void;
} {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState<ProviderEntityState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is a retry trigger, not a value the effect reads.
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void client
      .GET("/api/v1/provider-entities", { params: { query: { limit: ENTITY_PAGE_SIZE } } })
      .then(({ data, error }) => {
        if (!active) return;
        if (error || !data) {
          setState({ status: "error" });
          return;
        }
        setState({
          status: "ready",
          entities: (data.items ?? []).map((p) => ({
            id: p.id,
            legalName: p.legalName,
            ccn: p.ccn,
          })),
        });
      })
      .catch(() => {
        if (active) setState({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [client, attempt]);

  const chosen = params.get(ENTITY_PARAM) ?? "";
  const entities = state.status === "ready" ? state.entities : [];
  const entityId = entities.some((e) => e.id === chosen) ? chosen : (entities[0]?.id ?? "");

  return {
    state,
    entityId,
    setEntityId: (id) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(ENTITY_PARAM, id);
          next.delete("claim");
          return next;
        },
        { replace: true },
      ),
    retry: () => setAttempt((n) => n + 1),
  };
}
