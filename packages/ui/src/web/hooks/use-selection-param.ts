// packages/ui/src/web/hooks — the `?param=<id>` that names the record open in a list drawer.
// Writes go through a functional updater so every other query param survives (like `useStaleSelection`).
//
// History: opening a drawer from a closed list PUSHES one entry (stamped `fromSelect: <param>`); picking another row while a
// drawer is open REPLACES it (so a run of row-picking is still one Back away from the page before it, and re-picking the open
// row does nothing). Closing pops the entry `select` pushed, so Back never lands on a dead "closed drawer" entry; a drawer
// reached by a deep link has no such entry, so closing there replaces the param instead. The stamp names the param, so an
// entry pushed for one selection is never popped by another.
import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

interface SelectState {
  /** The param this entry was pushed for. */
  fromSelect?: string;
}

const withParam = (current: URLSearchParams, param: string, id: string): URLSearchParams => {
  const next = new URLSearchParams(current);
  next.set(param, id);
  return next;
};

export interface SelectionParam {
  selectedId: string | null;
  select: (id: string) => void;
  /**
   * Closes the drawer: pops the entry `select` pushed, or replaces the param when the drawer came from a link. Also what a stale
   * selection should call (`useStaleSelection({ clear: close })`), so clearing a vanished record unwinds its own entry.
   */
  close: () => void;
}

export function useSelectionParam(param: string): SelectionParam {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { state, key } = useLocation();
  // Two activations before the router re-renders (a double click, Enter then click) must pop one entry, not two ...
  const popping = useRef(false);
  // ... and must read what the first one already asked for, not this render's param.
  const pending = useRef<{ id: string; pushed: boolean } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new history entry (`key`) is the trigger, not a value read inside.
  useEffect(() => {
    popping.current = false;
    pending.current = null;
  }, [key]);
  const selectedId = params.get(param);
  const pushedBySelect = (state as SelectState | null)?.fromSelect === param;

  const select = useCallback(
    (id: string): void => {
      const current = pending.current ? pending.current.id : selectedId;
      if (id === current) return;
      const pushed = pending.current ? pending.current.pushed : pushedBySelect;
      if (current !== null) {
        // Keep the entry's stamp so the new drawer still closes by popping the entry a select pushed.
        pending.current = { id, pushed };
        setParams((latest) => withParam(latest, param, id), {
          replace: true,
          state: pushed ? ({ fromSelect: param } satisfies SelectState) : null,
        });
        return;
      }
      pending.current = { id, pushed: true };
      setParams((latest) => withParam(latest, param, id), {
        state: { fromSelect: param } satisfies SelectState,
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
      (latest) => {
        const next = new URLSearchParams(latest);
        next.delete(param);
        return next;
      },
      { replace: true },
    );
  }, [param, pushedBySelect, navigate, setParams]);

  return { selectedId, select, close };
}
