// apps/admin/src/modules/34-saas-platform/onboarding — shown while a quiet refresh has failed: what is on screen was loaded before the
// last change and may be out of date, so the operator is told and can reload (rather than acting on it unknowingly).
import { Button, InlineAlert } from "@chartwarden/ui";
import type { JSX } from "react";

export function StaleNotice({
  stale,
  onReload,
}: {
  stale: boolean;
  onReload: () => void;
}): JSX.Element | null {
  if (!stale) return null;
  return (
    <div className="wx-form-stack">
      <InlineAlert tone="warning">
        Could not refresh this page after the last change, so what you see may be out of date.
      </InlineAlert>
      <div>
        <Button tone="secondary" size="sm" onClick={onReload}>
          Reload
        </Button>
      </div>
    </div>
  );
}
