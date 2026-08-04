import { t } from "@wardenx/ui";
import type { JSX } from "react";
// apps/web/src/modules/02-identity — the WardenX brand lockup for the auth-flow cards (Sign in, MFA,
// org-select, …). Matches the P0 Pencil auth frame (wardenx-P0-foundation.pen `a1dbhD`): the Lantern
// hearth mark in brand gold (`--color-accent` — brand warmth only, never status) + "WardenX" in the
// Fraunces display voice. Shared so every auth card has one identical lockup.
export function BrandLockup(): JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill={t.accent} aria-hidden="true">
        <path d="M12 2.5c2 3.2 5 5.2 5 9.2a5 5 0 0 1-10 0c0-2.2.9-3.8 2.1-4.9.2 1.4 1 2.4 2.1 2.7-.7-2.5.3-5.1.7-7z" />
      </svg>
      <span
        style={{ fontFamily: t.fontDisplay, fontWeight: 600, fontSize: "1.5rem", color: t.primary }}
      >
        WardenX
      </span>
    </div>
  );
}
