// A 403 on the member route means "you cannot manage members here", not "you lost the conversation" (that wording is
// for a failed thread read). Static copy, never the title. Importers: channel-members-dialog.tsx.
import { Button, EmptyState } from "@wardenx/ui";
import type { JSX } from "react";

const TITLE = "You can't manage members of this conversation.";

export function MembersForbidden({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div className="wx-channel-members-state">
      <output aria-label={TITLE}>
        <EmptyState title={TITLE} description="Ask an administrator if you need access." />
      </output>
      <Button size="lg" tone="secondary" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}
