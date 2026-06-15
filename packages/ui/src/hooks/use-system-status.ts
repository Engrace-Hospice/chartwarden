// @wardenx/ui — use-system-status (spec §5.1). Convenience re-export plus a derived
// `isDegraded` helper over the system-status context.
import { useSystemStatus as useSystemStatusContext } from "../providers/system-status-provider";
import type { SystemStatusComponent } from "../types";

export { useSystemStatusContext as useSystemStatus };

/** True when any subscribed component is non-operational (drives the degraded banner). */
export function useIsDegraded(): boolean {
  const { components } = useSystemStatusContext();
  return components.some((c: SystemStatusComponent) => c.status !== "operational");
}
