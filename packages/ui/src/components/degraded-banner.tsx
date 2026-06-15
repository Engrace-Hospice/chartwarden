// @wardenx/ui — degraded-mode banner (spec §5.2). Renders whenever any subscribed system
// status component is non-operational; hidden when everything is operational.
import type { JSX } from "react";
import { useSystemStatus } from "../providers/system-status-provider";
import { statusColors } from "../theme/colors";

export function DegradedBanner(): JSX.Element | null {
  const { components } = useSystemStatus();
  const degraded = components.filter((c) => c.status !== "operational");
  if (degraded.length === 0) return null;

  return (
    <output
      aria-live="polite"
      style={{
        display: "block",
        background: statusColors.degraded.bg,
        borderBottom: `1px solid ${statusColors.degraded.border}`,
        color: statusColors.degraded.fg,
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
