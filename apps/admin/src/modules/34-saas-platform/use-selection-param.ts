// apps/admin/src/modules/34-saas-platform — the `?param=<id>` that names the record open in a list drawer.
// Writes go through a functional updater so every other query param survives (like `useStaleSelection`);
// closing replaces the history entry, so Back leaves the page's previous state rather than re-opening the drawer.
import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

export interface SelectionParam {
  selectedId: string | null;
  select: (id: string) => void;
  close: () => void;
}

export function useSelectionParam(param: string): SelectionParam {
  const [params, setParams] = useSearchParams();
  const select = useCallback(
    (id: string): void =>
      setParams((current) => {
        const next = new URLSearchParams(current);
        next.set(param, id);
        return next;
      }),
    [param, setParams],
  );
  const close = useCallback(
    (): void =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete(param);
          return next;
        },
        { replace: true },
      ),
    [param, setParams],
  );
  return { selectedId: params.get(param), select, close };
}
