// apps/web/src/modules/08-encounters/findings — the patient's recent weights for the visit being written.
//
//   GET /api/v1/encounters/{encounterId}/weight-history  ->  { current, prior, history }
//
// `prior` is the weight from the last earlier visit, which is what the weight field compares against. The comparison is a convenience, so a
// failed read leaves `weightHistory` null and says why in `error`; it never blocks recording a weight. `reload` reads again (for instance
// once this visit's own vitals were saved, so `current` shows it).
import { useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import { type WeightHistoryView, loadWeightHistory } from "./findings-api";

export interface WeightHistoryState {
  readonly weightHistory: WeightHistoryView | null;
  readonly error: string | null;
  readonly reload: () => void;
}

export function useWeightHistory(encounterId: string): WeightHistoryState {
  const client = useApiClient();
  const [read, setRead] = useState<Pick<WeightHistoryState, "weightHistory" | "error">>({
    weightHistory: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-reads the history on `reload`.
  useEffect(() => {
    let active = true;
    void loadWeightHistory(client, encounterId).then((result) => {
      if (!active) return;
      setRead(
        result.ok
          ? { weightHistory: result.value, error: null }
          : { weightHistory: null, error: result.message },
      );
    });
    return () => {
      active = false;
    };
  }, [client, encounterId, attempt]);

  const reload = useCallback(() => setAttempt((count) => count + 1), []);
  return { ...read, reload };
}
