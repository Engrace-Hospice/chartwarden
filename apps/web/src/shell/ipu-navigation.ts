import { useApiClient, useFeatureFlag } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import { useSession } from "./session";

/** Only the unit configuration screen remains in Admissions for an administrator setting up IPU. */
export function filterIpuNavigation<T extends { path: string }>(
  screens: readonly T[],
  enabled: boolean,
  hasActiveUnit: boolean,
  isAdmin: boolean,
): T[] {
  return screens.filter(
    (screen) =>
      (screen.path !== "/ipu" && !screen.path.startsWith("/ipu/")) ||
      (enabled && (hasActiveUnit || (isAdmin && screen.path === "/ipu"))),
  );
}

/** An IPU is available in the navigation only after the tenant flag and an active unit are confirmed. */
export function useIpuNavigationAvailability(): {
  enabled: boolean;
  hasActiveUnit: boolean;
  isAdmin: boolean;
} {
  const client = useApiClient();
  const session = useSession();
  const enabled = useFeatureFlag("ipu_module_enabled");
  const organizationId = session?.organizationId ?? "";
  const canReadUnits = session?.permissions?.includes("m37.unit.read") ?? false;
  const [availability, setAvailability] = useState<{
    organizationId: string;
    hasActiveUnit: boolean;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !organizationId || !canReadUnits) return;
    let current = true;
    void client
      .GET("/api/v1/inpatient-units")
      .then(({ data, error }) => {
        if (current)
          setAvailability({
            organizationId,
            hasActiveUnit: !error && Boolean(data?.items?.some((unit) => unit.isActive)),
          });
      })
      .catch(() => {
        if (current) setAvailability({ organizationId, hasActiveUnit: false });
      });
    return () => {
      current = false;
    };
  }, [client, enabled, organizationId, canReadUnits]);

  return {
    enabled,
    hasActiveUnit:
      enabled && availability?.organizationId === organizationId && availability.hasActiveUnit,
    isAdmin: session?.isAdmin === true,
  };
}
