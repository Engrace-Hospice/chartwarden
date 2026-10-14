// M36 WP 3.3 - the SBAR form's state, owned by the thread (which is keyed by channel) so Cancel keeps what was typed until
// the message is sent or the user discards it. The text is mirrored to the server-side draft slot by useServerDraft
// (WP 2.5, sealed with the ordinary text draft), so it also survives a channel switch, a reload and another device.
import { SBAR_SECTION_KEYS, type SbarSections } from "@wardenx/types";
import { useCallback, useMemo, useState } from "react";
import type { ChannelKind } from "./messaging-types";
import {
  type SbarFormValues,
  defaultSbarUrgency,
  emptySbarValues,
  sbarDraftOf,
  sbarValuesOf,
} from "./sbar-utils";

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
  /**
   * A server draft was restored: fill the form (it stays closed until the user opens it) or clear it. An urgency the
   * user already picked while the first read was in flight is kept when the sections were still blank; resolving a
   * conflict never keeps it, the chosen side's urgency wins.
   */
  const restore = useCallback(
    (sbar: SbarSections | null, keepPickedUrgency = false) =>
      setValues((current) => {
        const sectionsBlank = SBAR_SECTION_KEYS.every((key) => current.sections[key].trim() === "");
        const picked =
          keepPickedUrgency && sectionsBlank && current.urgency !== defaultSbarUrgency(kind);
        if (!sbar) return sectionsBlank ? current : emptySbarValues(kind);
        const restored = sbarValuesOf(kind, sbar);
        return picked ? { ...restored, urgency: current.urgency } : restored;
      }),
    [kind],
  );
  /** What the draft slot should hold for this form; null when blank. Stable while the text is unchanged. */
  const draft = useMemo(() => sbarDraftOf(values), [values]);
  return { open, values, setValues, show, hide, finish, restore, draft };
}
export type SbarCompose = ReturnType<typeof useSbarCompose>;
