// @chartwarden/ui — degraded-mode banner (spec §5.2). Renders whenever any subscribed system
// status component is non-operational; hidden when everything is operational.
import type { JSX } from "react";
import { useSystemStatus } from "../../core/providers/system-status-provider";
import { t, tint } from "../theme/tokens";

export function DegradedBanner(): JSX.Element | null {
  const { components } = useSystemStatus();
  const degraded = components.filter((c) => c.status !== "operational");
  if (degraded.length === 0) return null;

  // Theme-reactive Lantern tone (§6.6): a tinted warning fill + warning text + ghost separator. An
  // `outage` among the degraded components escalates the whole banner to the error tone. (Replaces
  // the old off-palette, non-theme-reactive statusColors hex — see design-token hardening.)
  const tone = degraded.some((c) => c.status === "outage") ? t.error : t.warning;

  return (
    <output
      aria-live="polite"
      style={{
        display: "block",
        background: tint(tone),
        borderBottom: `1px solid color-mix(in srgb, ${t.outlineVariant} 35%, transparent)`,
        color: tone,
        fontFamily: t.fontSans,
        padding: "0.5rem 1rem",
        fontSize: "0.875rem",
      }}
    >
      <strong>System status:</strong>{" "}
      {degraded.map((c) => `${c.id}: ${c.headline ?? c.status}`).join(" · ")}{" "}
      <a href="/status" style={{ textDecoration: "underline", color: "inherit" }}>
        Updates
      </a>
    </output>
  );
}
