// apps/web/src/modules/34-saas/wizard — what the server said about each input, kept beside that input only until the member edits it: a
// refusal of a field that was then changed is stale, and leaving it up reads as a second refusal of the new value.
import type { OpsFailure } from "@chartwarden/ui";
import { useState } from "react";

export interface ServerFieldErrors {
  /** The server's message for each field not edited since it was refused. */
  readonly errors: Readonly<Record<string, string>>;
  /** The member edited `field`: its server message goes. */
  readonly touch: (field: string) => void;
}

export function useServerFieldErrors(failure: OpsFailure | null): ServerFieldErrors {
  // Tied to the failure it was recorded for: a new refusal starts with nothing edited.
  const [touched, setTouched] = useState<{
    failure: OpsFailure | null;
    fields: ReadonlySet<string>;
  }>({
    failure: null,
    fields: new Set(),
  });
  const edited = touched.failure === failure ? touched.fields : new Set<string>();
  const errors = Object.fromEntries(
    Object.entries(failure?.fieldErrors ?? {}).filter(([field]) => !edited.has(field)),
  );
  return {
    errors,
    // functional: two fields edited in one event (the vendor and the mode) must both be recorded, not the last over the first
    touch: (field) =>
      setTouched((prev) => ({
        failure,
        fields: new Set([...(prev.failure === failure ? prev.fields : []), field]),
      })),
  };
}
