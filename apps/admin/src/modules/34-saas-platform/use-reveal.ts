// apps/admin/src/modules/34-saas-platform — a card section that is read on request (every read of a tenant's pricing or billing setup is
// audited, so a visit to the hub makes none). The control that reveals it stays on the page as an `aria-expanded` toggle: it is never
// replaced, so keyboard focus is not lost when it is pressed. The section mounts on the FIRST reveal (the one read) and is then hidden
// and shown without unmounting, so collapsing it does not drop what was typed in it nor read it (and audit it) again.
import { useId, useState } from "react";

export interface Reveal {
  /** Props for the toggle button. */
  readonly toggleProps: { readonly "aria-expanded": boolean; readonly "aria-controls": string };
  readonly onToggle: () => void;
  /** The section has been revealed at least once: render it (hidden while collapsed). */
  readonly mounted: boolean;
  readonly open: boolean;
  /** The id the toggle's `aria-controls` names: put it on the section's wrapper. */
  readonly sectionId: string;
}

export function useReveal(initiallyOpen = false): Reveal {
  const sectionId = useId();
  const [mounted, setMounted] = useState(initiallyOpen);
  const [open, setOpen] = useState(initiallyOpen);
  return {
    toggleProps: { "aria-expanded": open, "aria-controls": sectionId },
    onToggle: () => {
      setMounted(true);
      setOpen((was) => !was);
    },
    mounted,
    open,
    sectionId,
  };
}
