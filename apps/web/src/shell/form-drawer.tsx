// A record's form as the redesign's right-hand drawer beside its list: the kit `Drawer` with Cancel and the save
// action in its footer. Like the dialog it replaces, it cannot be dismissed (Cancel, the close button, Escape) while
// a write is in flight: closing it would orphan the request and its outcome.
import { Button, Drawer } from "@chartwarden/ui";
import type { JSX, ReactNode } from "react";

export function FormDrawer({
  title,
  busy,
  onClose,
  save,
  children,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  /** The primary action; the drawer adds Cancel before it. */
  save: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Drawer
      title={title}
      label={title}
      onClose={close}
      footer={
        <>
          <Button tone="secondary" type="button" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {save}
        </>
      }
    >
      {children}
    </Drawer>
  );
}
