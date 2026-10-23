// WCAG 2.5.8 (#648): an interactive target on a chart screen is at least 24 x 24 CSS px. Spread into a link's
// or icon button's style; add `gap`/`fontWeight` beside it, never a smaller box.
export const TARGET_24 = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: "1.5rem",
  minHeight: "1.5rem",
} as const;
