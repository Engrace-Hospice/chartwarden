// A 403 on the member route means "you cannot manage members here", not "you lost the conversation" (that wording is
// for a failed thread read). Static copy, never the title. Importers: channel-members-dialog.tsx.
// The body replaces a focused control, so Close takes focus on mount (keeps the Modal's Tab trap and Escape alive).
import { Button, EmptyState } from "@wardenx/ui";
import { useEffect, useRef } from "react";
import type { JSX } from "react";

const TITLE = "You can't manage members of this conversation.";

export function MembersForbidden({ onClose }: { onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
  }, []);
  return (
    <div className="wx-channel-members-state" ref={ref}>
      <output>
        <EmptyState title={TITLE} description="Ask an administrator if you need access." />
      </output>
      <Button size="lg" tone="secondary" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}
