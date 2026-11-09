// @chartwarden/ui web — a `<ul>` whose list-style is removed by CSS, with its list role restated.
// Safari/VoiceOver drops list semantics from a list with `list-style: none`, so a marker-less list says `role="list"` itself.
// Biome's two a11y rules object to that on a real <ul>; the objection is answered here once, not at every marker-less list.
import type { JSX, ReactNode } from "react";

export interface UnstyledListProps {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}

export function UnstyledList({
  children,
  className,
  "aria-label": ariaLabel,
}: UnstyledListProps): JSX.Element {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: Safari/VoiceOver drops list semantics when list-style is none
    // biome-ignore lint/a11y/useSemanticElements: it already is a <ul>; the role only restores the semantics Safari drops
    <ul role="list" className={className} aria-label={ariaLabel}>
      {children}
    </ul>
  );
}
