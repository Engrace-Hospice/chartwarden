// @chartwarden/ui web — shown while a quiet refresh has failed: what is on screen was loaded before the last change and may be out of
// date, so the person is told and can reload (rather than acting on it unknowingly). Hoisted from the admin onboarding wizard.
import type { JSX } from "react";
import { Button } from "./button";
import { InlineAlert } from "./inline-alert";

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
