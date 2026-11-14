// apps/web/src/modules/34-saas/wizard — a panel's handlers are async and called with `void`, so anything that throws inside one (a
// follow-up reload, a digest, a bug) would reject silently and leave the screen looking idle. `guard` runs one and, if it throws, says so
// on screen. The writes themselves report their refusals through `useOpsWrite`; this is only for what escapes it.
import { InlineAlert } from "@chartwarden/ui";
import { useCallback, useState } from "react";
import type { JSX } from "react";

const UNEXPECTED =
  "Something went wrong before this finished. Reload the page to see where things stand, then try again.";

export function useGuarded(): {
  readonly guard: (work: () => Promise<void>) => Promise<void>;
  readonly notice: JSX.Element | null;
} {
  const [crashed, setCrashed] = useState(false);
  const guard = useCallback(async (work: () => Promise<void>): Promise<void> => {
    setCrashed(false);
    try {
      await work();
    } catch {
      setCrashed(true);
    }
  }, []);
  return { guard, notice: crashed ? <InlineAlert tone="error">{UNEXPECTED}</InlineAlert> : null };
}
