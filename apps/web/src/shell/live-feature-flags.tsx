// apps/web/src/shell — feeds <FeatureFlagProvider> the org's real flags (GET /api/v1/system/feature-flags). AppShell used
// to default `flags = {}` and nothing ever loaded them, so every `useFeatureFlag` consumer read false in the real app.
// Flags are read once per bound organization (after sign-in and org selection); until then, or on any failure, the map is
// empty so every flag reads false (fail closed — the server stays the authority). An explicit `flags` prop (tests,
// stories) wins and issues no read.
import { FeatureFlagProvider, useApiClient } from "@wardenx/ui";
import type { FeatureFlags } from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useSession } from "./session";

const NO_FLAGS: FeatureFlags = {};

export interface LiveFeatureFlagProviderProps {
  /** Fixed flags (tests, stories): used as-is and nothing is loaded. */
  readonly flags?: FeatureFlags | undefined;
  readonly children: ReactNode;
}

export function LiveFeatureFlagProvider({
  flags,
  children,
}: LiveFeatureFlagProviderProps): JSX.Element {
  const client = useApiClient();
  const organizationId = useSession()?.organizationId ?? "";
  const [loaded, setLoaded] = useState<{ org: string; flags: FeatureFlags } | null>(null);
  const fixed = flags !== undefined;

  useEffect(() => {
    if (fixed || organizationId === "") return;
    let current = true;
    Promise.resolve()
      .then(() => client.GET("/api/v1/system/feature-flags"))
      .then((result) => {
        if (current && result?.data?.flags)
          setLoaded({ org: organizationId, flags: result.data.flags });
      })
      .catch(() => {
        // Fail closed: no flags loaded means every flag reads false.
      });
    return () => {
      current = false;
    };
  }, [client, fixed, organizationId]);

  const resolved = flags ?? (loaded?.org === organizationId ? loaded.flags : NO_FLAGS);
  return <FeatureFlagProvider flags={resolved}>{children}</FeatureFlagProvider>;
}
