// A record's form as the redesign's right-hand drawer beside its list: the kit `Drawer` with Cancel and the save
// action in its footer. Like the dialog it replaces, it cannot be dismissed (Cancel, the close button, Escape) while
// a write is in flight: closing it would orphan the request and its outcome.
//
// A drawer does not block the page the way that dialog did, so while `busy` everything outside the drawer goes inert
// (a row's Edit, an opener, Reload, a link): nothing can swap, unmount or navigate away from the form whose outcome has
// not landed. A form that is open but idle can still be replaced by choosing another record, like any kit drawer.
import { Button, Drawer, InlineAlert } from "@chartwarden/ui";
import { type JSX, type ReactNode, useEffect, useRef } from "react";

/** Marks every element outside `node`'s own path to the document body inert; returns the undo. */
function inertAround(node: Element): () => void {
  const marked: Element[] = [];
  for (let el: Element | null = node; el && el !== document.body; el = el.parentElement) {
    const parent: Element | null = el.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === el || sibling.hasAttribute("inert")) continue;
      sibling.setAttribute("inert", "");
      marked.push(sibling);
    }
  }
  return () => {
    for (const el of marked) el.removeAttribute("inert");
  };
}

export function FormDrawer({
  title,
  busy,
  onClose,
  save,
  error,
  children,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  /** The primary action; the drawer adds Cancel before it. */
  save: ReactNode;
  /** A failed write's refusal, announced in the drawer beside Save (not in the page, which can sit below it). */
  error?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const aside = marker.current?.closest("aside");
    if (!busy || !aside) return;
    return inertAround(aside);
  }, [busy]);
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Drawer
      title={title}
      label={title}
      onClose={close}
      closeDisabled={busy}
      footer={
        <>
          <Button tone="secondary" type="button" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {save}
        </>
      }
    >
      <span ref={marker} hidden />
      {children}
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    </Drawer>
  );
}
