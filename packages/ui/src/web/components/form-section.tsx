import type { JSX, ReactNode } from "react";
import { t } from "../theme/tokens";
import { Card } from "./card";

export interface FormSectionProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}

/** Consistent section chrome for long, regulated forms. Field layout remains caller-owned. */
export function FormSection({ title, description, children }: FormSectionProps): JSX.Element {
  return (
    <Card>
      <div style={{ display: "flex", flexDirection: "column", gap: t.space1 }}>
        <h2 style={{ margin: 0, fontSize: "1.125rem" }}>{title}</h2>
        {description ? <p style={{ margin: 0, color: t.onSurfaceVariant }}>{description}</p> : null}
      </div>
      <div style={{ marginTop: t.space5 }}>{children}</div>
    </Card>
  );
}
