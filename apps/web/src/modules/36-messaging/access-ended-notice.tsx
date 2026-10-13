// WP 2.11 forbidden / access-ended state (06-ux-design §4): static copy, never the title or any preview. Revocation
// unmounts the focused thread, so the notice takes focus and is a status region; otherwise keyboard and screen-reader
// users are dropped on <body> with no announcement.
import { EmptyState, Glyph } from "@wardenx/ui";
import { useEffect, useRef } from "react";
import type { JSX } from "react";

const TITLE = "You no longer have access to this conversation";

// `onBack` is the narrow-screen way out: below 768 px the notice replaces the inbox, so it needs a Back (WP 2.11 D2). The button sits outside the live region so it is not announced as status text.
export function AccessEndedNotice({ onBack }: { onBack: () => void }): JSX.Element {
  const ref = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <>
      <button
        type="button"
        className="wx-messaging-back"
        onClick={onBack}
        aria-label="Back to conversations"
      >
        <Glyph name="chevron-left" size={20} />
      </button>
      <output ref={ref} aria-label={TITLE} tabIndex={-1}>
        <EmptyState title={TITLE} description="Choose another conversation from the inbox." />
      </output>
    </>
  );
}
