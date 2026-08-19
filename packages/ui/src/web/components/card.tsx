import type { HTMLAttributes, JSX, ReactNode } from "react";
import { cardSurface, t } from "../theme/tokens";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  padding?: string;
  as?: "section" | "article" | "div";
}

/** Token-only surface card. It is deliberately presentational: a clickable card must be a button/link. */
export function Card({
  children,
  padding = t.space5,
  as: Element = "section",
  style,
  ...props
}: CardProps): JSX.Element {
  return (
    <Element {...props} className="wx-card" style={{ ...cardSurface, padding, ...style }}>
      {children}
    </Element>
  );
}
