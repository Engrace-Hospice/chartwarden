// apps/admin/src/modules/34-saas-platform/onboarding — the one line shown where a control is hidden because the operator's role does not
// hold its permission, so a missing button is explained instead of silently absent.
import type { JSX } from "react";

export function RoleCannot({ what }: { what: string }): JSX.Element {
  return <p className="wx-row-sub">Your role cannot {what}.</p>;
}
