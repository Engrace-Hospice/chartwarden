// @chartwarden/portal — who is signed in (not who the care is for): their display name and portal relationship.
// Kept apart from the patient context, which owns exactly one request (the care summary) per patient. Both reads
// are best-effort personalisation: a failure leaves the neutral copy ("Welcome back"), never an error state.
import { useApiClient } from "@chartwarden/ui";
import { createContext, useContext, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { fetchSignedInName } from "./auth-http";

export interface PortalViewer {
  name: string | null;
  relationship: string | null;
}

const UNKNOWN_VIEWER: PortalViewer = { name: null, relationship: null };

const ViewerContext = createContext<PortalViewer>(UNKNOWN_VIEWER);

export function PortalViewerProvider({ children }: { children: ReactNode }): JSX.Element {
  const client = useApiClient();
  const [viewer, setViewer] = useState<PortalViewer>(UNKNOWN_VIEWER);

  useEffect(() => {
    let active = true;
    // Independent reads: a slow auth session must not hold back the relationship-driven copy.
    void fetchSignedInName().then((name) => {
      if (active) setViewer((prev) => ({ ...prev, name }));
    });
    void client
      .GET("/api/v1/portal/sessions/current", {})
      .then((res) =>
        "error" in res ? null : (res.data as { relationship?: string })?.relationship,
      )
      .catch(() => null)
      .then((relationship) => {
        // The API reports "unknown" when the account row is missing — treat it as no relationship.
        const known = relationship && relationship !== "unknown" ? relationship : null;
        if (active) setViewer((prev) => ({ ...prev, relationship: known }));
      });
    return () => {
      active = false;
    };
  }, [client]);

  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>;
}

/** The signed-in person; an all-null viewer until it loads or when rendered outside the provider. */
export function usePortalViewer(): PortalViewer {
  return useContext(ViewerContext);
}
