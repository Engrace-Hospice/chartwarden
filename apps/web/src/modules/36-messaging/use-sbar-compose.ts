// M36 WP 3.3 - the SBAR form's state, owned by the thread (which is keyed by channel) so Cancel keeps what was typed until
// the message is sent or the user discards it. Held in memory only: nothing goes to the browser store or the server.
import { useCallback, useState } from "react";
import type { ChannelKind } from "./messaging-types";
import { type SbarFormValues, emptySbarValues } from "./sbar-utils";

export function useSbarCompose(kind: ChannelKind) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<SbarFormValues>(() => emptySbarValues(kind));
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  /** Sent (or queued) or discarded: forget the text and close. */
  const finish = useCallback(() => {
    setOpen(false);
    setValues(emptySbarValues(kind));
  }, [kind]);
  return { open, values, setValues, show, hide, finish };
}
export type SbarCompose = ReturnType<typeof useSbarCompose>;
