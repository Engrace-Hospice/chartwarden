// apps/web/src/modules/08-encounters/review — the inline styles of the blocker panel and the review panel. Lantern tokens only; flat (a
// hairline and a tint, no card shadow), like the composer's own strips. Status is always carried by words as well as by tint.
import type { CSSProperties } from "react";
import { hairline } from "../encounter-compose-styles";

export const panelStyle: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  padding: "1rem 1.1rem",
  border: hairline,
  borderRadius: "0.9rem",
  background: "var(--color-surface)",
  fontSize: "0.8125rem",
  color: "var(--color-on-surface)",
};

export const panelHeading: CSSProperties = {
  margin: 0,
  fontSize: "0.95rem",
  fontWeight: 650,
};

export const groupHeading: CSSProperties = {
  margin: 0,
  fontSize: "0.8125rem",
  fontWeight: 650,
};

export const paragraph: CSSProperties = { margin: 0 };

export const statusLine: CSSProperties = {
  display: "grid",
  gap: "0.2rem",
  padding: "0.6rem 0.75rem",
  borderRadius: "0.6rem",
  border: hairline,
  background: "var(--color-surface-container-low)",
};

export const statusBlocked: CSSProperties = {
  borderColor: "color-mix(in srgb, var(--color-error) 35%, transparent)",
  background: "color-mix(in srgb, var(--color-error) 7%, var(--color-surface))",
};

export const list: CSSProperties = {
  display: "grid",
  gap: "0.5rem",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

export const blockerRow: CSSProperties = {
  display: "grid",
  justifyItems: "start",
  gap: "0.15rem",
  padding: "0.5rem 0.75rem",
  borderLeft: "3px solid var(--color-error)",
  background: "color-mix(in srgb, var(--color-error) 5%, var(--color-surface))",
};

export const checkRow: CSSProperties = {
  display: "grid",
  gap: "0.1rem",
};

export const groupBox: CSSProperties = {
  display: "grid",
  gap: "0.4rem",
  paddingTop: "0.5rem",
  borderTop: hairline,
};

export const reviewRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.5rem 0",
  borderTop: hairline,
};

export const reviewRowText: CSSProperties = {
  display: "grid",
  gap: "0.1rem",
  minWidth: 0,
};
