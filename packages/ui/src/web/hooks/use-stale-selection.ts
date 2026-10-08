// packages/ui/src/web/hooks — a `?param=<id>` that names a record the list no longer holds.
//
// The drawer is resolved from the loaded list, so a link to a record that was filtered out, deleted or mistyped rendered
// nothing and left the param in the URL: no drawer, no message, and the drawer could pop up later when the list changed.
// Once the list has finished loading and the id is absent, this clears the param (replace, so Back is not trapped) and says so.
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useOptionalToast } from "../system/toast";

export interface StaleSelectionOptions {
  /** The search param holding the selected id (`event`, `tenant`, …). */
  param: string;
  /** True only once a load has COMPLETED successfully — not merely "not loading", which is also true before the first fetch. */
  ready: boolean;
  /** Whether the selected id is present in the loaded data. */
  found: boolean;
  /** Param values that are not record ids (e.g. `new`), which never count as stale. */
  ignore?: readonly string[];
  message?: string;
}

export const STALE_SELECTION_MESSAGE = "That record is no longer in this list.";

export function useStaleSelection({
  param,
  ready,
  found,
  ignore = [],
  message = STALE_SELECTION_MESSAGE,
}: StaleSelectionOptions): void {
  const [params, setParams] = useSearchParams();
  const toast = useOptionalToast();
  const selected = params.get(param);
  const stale =
    ready && selected !== null && selected !== "" && !ignore.includes(selected) && !found;

  useEffect(() => {
    if (!stale) return;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(param);
        return next;
      },
      { replace: true },
    );
    toast?.show(message, { tone: "info" });
  }, [stale, param, message, setParams, toast]);
}
