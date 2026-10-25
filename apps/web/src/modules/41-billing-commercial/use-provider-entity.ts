// apps/web/src/modules/41-billing-commercial — the provider entity every commercial read is scoped to (the API requires one, and
// proves the actor reaches it). The choice lives in the URL (`?entity=`) so a queue, a payer view and a shared link agree; with
// none chosen, the first entity the actor can actually bill for is used (probed, so a scoped biller never lands on a 404).
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
  | {
      readonly status: "ready";
      readonly entities: readonly ProviderEntityOption[];
      /** The entity used when the URL names none (or an unknown one): the first the actor can bill for. */
      readonly defaultId: string;
    };

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is a retry trigger; the URL choice is read once per load.
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    const chosenAtLoad = params.get(ENTITY_PARAM) ?? "";
    const load = async (): Promise<ProviderEntityState> => {
      const { data, error } = await client.GET("/api/v1/provider-entities", {
        params: { query: { limit: ENTITY_PAGE_SIZE } },
      });
      if (error || !data) return { status: "error" };
      const all = (data.items ?? []).map((p) => ({ id: p.id, legalName: p.legalName, ccn: p.ccn }));
      if (all.some((e) => e.id === chosenAtLoad)) {
        return { status: "ready", entities: all, defaultId: chosenAtLoad };
      }
      // No explicit choice: default to the first entity the actor can actually bill for. A scoped biller's first listed entity
      // may be outside their billing scope (the read answers 404), so probe in order with a cheap, patient-free read.
      for (const entity of all) {
        const probe = await client.GET("/api/v1/billing/commercial/payer-plans", {
          params: { query: { providerEntityId: entity.id } },
        });
        if (!probe.error) return { status: "ready", entities: all, defaultId: entity.id };
      }
      return { status: "ready", entities: [], defaultId: "" }; // none billable: the gate says so
    };
    void load()
      .then((next) => {
        if (active) setState(next);
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
  const fallback = state.status === "ready" ? state.defaultId : "";
  const entityId = entities.some((e) => e.id === chosen) ? chosen : fallback;

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
