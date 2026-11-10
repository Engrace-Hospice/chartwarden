// apps/web/src/modules/34-saas/wizard — the "This does not apply to us" entry point on a skippable billing or e-prescribing step. The FRAME
// owns the skip itself (the rationale, the fresh step-up, the write); this only shows where to start it, and only when the frame says the
// signed-in member may skip this step right now.
import { Button } from "@chartwarden/ui";
import type { JSX } from "react";
import type { SkipAction } from "./panel-props";

export function SkipEntry({
  skip,
  heading,
  children,
}: {
  skip: SkipAction;
  heading: string;
  children: string;
}): JSX.Element | null {
  if (!skip.available) return null;
  return (
    <section className="wx-drawer-card" aria-label="If this step does not apply">
      <div className="wx-drawer-card-head">
        <h3>{heading}</h3>
      </div>
      <p className="wx-row-sub">{children}</p>
      <div className="wx-drawer-actions">
        <Button tone="secondary" onClick={skip.request}>
          This does not apply to us
        </Button>
      </div>
    </section>
  );
}
