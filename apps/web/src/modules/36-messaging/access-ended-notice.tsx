// WP 2.11 forbidden / access-ended state (06-ux-design §4): static copy, never the title or any preview. Revocation
// unmounts the focused thread, so the notice takes focus and is a status region; otherwise keyboard and screen-reader
// users are dropped on <body> with no announcement.
import { EmptyState } from "@wardenx/ui";
import { useEffect, useRef } from "react";
import type { JSX } from "react";

const TITLE = "You no longer have access to this conversation";

export function AccessEndedNotice(): JSX.Element {
  const ref = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <output ref={ref} aria-label={TITLE} tabIndex={-1}>
      <EmptyState title={TITLE} description="Choose another conversation from the inbox." />
    </output>
  );
}
