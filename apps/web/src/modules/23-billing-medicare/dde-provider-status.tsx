// apps/web/src/modules/23-billing-medicare — read-only platform status of the DDE access provider binding, for
// platform administrators only (#761, ADR-0103 D2). The route is gated server-side on the platform key; the screen
// only avoids asking when the session lacks it. No credentials exist in the answer.
import { useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import { type ProviderStatus, providerStatusText } from "./dde-provider-model";

export const PLATFORM_ADMIN_PERMISSION = "billing.rule_config.platform_admin";

export function DdeProviderStatus(): JSX.Element | null {
  const client = useApiClient();
  const allowed = useSession()?.permissions?.includes(PLATFORM_ADMIN_PERMISSION) ?? false;
  const [status, setStatus] = useState<ProviderStatus | "error" | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let active = true;
    client
      .GET("/api/v1/admin/billing/dde-provider")
      .then(({ data }) => {
        if (active) setStatus((data as ProviderStatus | undefined) ?? "error");
      })
      .catch(() => {
        if (active) setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [client, allowed]);

  if (!allowed || status === null) return null;
  return (
    <output className="wx-row-sub" aria-label="DDE provider">
      <strong>DDE provider: </strong>
      {status === "error" ? "status could not be read." : providerStatusText(status)}
    </output>
  );
}
