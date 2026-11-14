// apps/web/src/modules/34-saas/wizard — the hint that a step can be skipped. The FRAME owns the skip itself (the "Skip this step" button,
// the rationale, the fresh step-up, the write), so a panel offers no second button: it only says the option exists, and only when the
// frame says the signed-in member may skip this step right now.
import type { JSX } from "react";
import type { SkipAction } from "./panel-props";

export function SkipHint({
  skip,
  children = "If this does not apply to your organization, use Skip this step below.",
}: {
  skip: SkipAction;
  children?: string;
}): JSX.Element | null {
  if (!skip.available) return null;
  return <p className="wx-row-sub">{children}</p>;
}
