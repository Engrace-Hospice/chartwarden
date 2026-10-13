import type { JSX, MouseEvent } from "react";

export interface SkipLinkProps {
  /** `id` of the focusable (tabIndex -1) main landmark to jump to. */
  targetId: string;
}

/**
 * "Skip to main content" - the first Tab stop of the shell, visible only while focused (`.wx-skip-link`,
 * app-shell.css). Moves focus programmatically instead of following the `#hash`, so the router sees no navigation.
 */
export function SkipLink({ targetId }: SkipLinkProps): JSX.Element {
  function skip(event: MouseEvent<HTMLAnchorElement>): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    document.getElementById(targetId)?.focus();
  }
  return (
    <a className="wx-skip-link" href={`#${targetId}`} onClick={skip}>
      Skip to main content
    </a>
  );
}
