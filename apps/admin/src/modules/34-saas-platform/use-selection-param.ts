// apps/admin/src/modules/34-saas-platform — the `?param=<id>` that names the record open in a list drawer.
// Writes go through a functional updater so every other query param survives (like `useStaleSelection`).
//
// History: opening a drawer from a closed list PUSHES one entry (flagged `fromSelect`); picking another row while a drawer is
// open REPLACES it (so a run of row-picking is still one Back away from the page before it, and re-picking the open row does
// nothing). Closing pops the entry `select` pushed, so Back never lands on a dead "closed drawer" entry; a drawer reached by a
// deep link has no such entry, so closing there replaces the param instead.
import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

interface SelectState {
  fromSelect?: boolean;
}

const withParam = (current: URLSearchParams, param: string, id: string): URLSearchParams => {
  const next = new URLSearchParams(current);
  next.set(param, id);
  return next;
};

export function useSelectionParam(param: string): {
  selectedId: string | null;
  select: (id: string) => void;
  close: () => void;
} {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { state, key } = useLocation();
  // A double activation (two Close clicks before the router re-renders) must pop one entry, not two.
  const popping = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new history entry (`key`) is the trigger, not a value read inside.
  useEffect(() => {
    popping.current = false;
  }, [key]);
  const selectedId = params.get(param);
  const pushedBySelect = (state as SelectState | null)?.fromSelect === true;

  const select = useCallback(
    (id: string): void => {
      if (id === selectedId) return;
      if (selectedId !== null) {
        // Keep the entry's `fromSelect` flag so the new drawer still closes by popping the entry a select pushed.
        setParams((current) => withParam(current, param, id), {
          replace: true,
          state: pushedBySelect ? ({ fromSelect: true } satisfies SelectState) : null,
        });
        return;
      }
      setParams((current) => withParam(current, param, id), {
        state: { fromSelect: true } satisfies SelectState,
      });
    },
    [param, selectedId, pushedBySelect, setParams],
  );

  const close = useCallback((): void => {
    if (pushedBySelect) {
      if (!popping.current) navigate(-1);
      popping.current = true;
      return;
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(param);
        return next;
      },
      { replace: true },
    );
  }, [param, pushedBySelect, navigate, setParams]);

  return { selectedId, select, close };
}
