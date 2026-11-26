import type { ApiClient } from "@chartwarden/ui";
import { useEffect } from "react";
import type { PlatformSupportAccess, Workspace } from "../doclens-api";

export type WorkspaceLoad =
  | { readonly ok: true; readonly data: Workspace }
  | { readonly ok: false; readonly message: string };

interface WorkspaceResponse {
  readonly data?: Workspace | undefined;
  readonly error?: unknown;
  readonly response?: { readonly status: number } | undefined;
}

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

async function readSupportWorkspace(
  client: ApiClient,
  batchId: string,
  access: PlatformSupportAccess,
): Promise<WorkspaceResponse | null> {
  return await client
    .GET("/api/v1/platform/organizations/{organizationId}/intake/uploads/{id}/workspace", {
      params: {
        path: { organizationId: access.organizationId, id: batchId },
        query: { supportSessionId: access.supportSessionId },
      },
    })
    .catch(() => null);
}

async function readTenantWorkspace(
  client: ApiClient,
  batchId: string,
): Promise<WorkspaceResponse | null> {
  return await client
    .GET("/api/v1/intake/uploads/{id}/workspace", { params: { path: { id: batchId } } })
    .catch(() => null);
}

function supportFailure(status: number | undefined): string {
  if (status === HTTP_FORBIDDEN)
    return "This support session does not authorize access to the requested intake batch.";
  if (status === HTTP_NOT_FOUND)
    return "This intake batch is not available in the support-session tenant.";
  return "The support-session review workspace could not be loaded.";
}

function tenantFailure(status: number | undefined): string {
  return status === HTTP_NOT_FOUND
    ? "This intake batch is not available to you."
    : "The unified review workspace could not be loaded.";
}

/**
 * Reads the workspace of one batch: through the tenant route, or through the platform route when a
 * support session is active (its authorization is evaluated on every read). A failed or rejected
 * request is an `ok: false` with the copy to show, never a throw.
 */
export async function loadWorkspace(
  client: ApiClient,
  batchId: string,
  supportAccess: PlatformSupportAccess | null,
): Promise<WorkspaceLoad> {
  const response = supportAccess
    ? await readSupportWorkspace(client, batchId, supportAccess)
    : await readTenantWorkspace(client, batchId);
  if (response && !response.error && response.data) return { ok: true, data: response.data };
  const status = response?.response?.status;
  return { ok: false, message: supportAccess ? supportFailure(status) : tenantFailure(status) };
}

/**
 * A support session is revalidated whenever the operator returns to the tab, so an expired or revoked
 * session stops showing the tenant's data promptly instead of at the next click.
 */
export function useSupportRevalidation(
  supportAccess: PlatformSupportAccess | null,
  refresh: () => Promise<Workspace | null>,
): void {
  useEffect(() => {
    if (!supportAccess) return;
    const revalidate = (): void => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [refresh, supportAccess]);
}
