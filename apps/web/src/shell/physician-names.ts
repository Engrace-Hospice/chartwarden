// apps/web/src/shell — display names for MDM physician ids shown on worklists and order screens. Reads the M40
// resolve seam (GET /api/v1/mdm/physician/{id}, `mdm.physician.read`), the same read the patient order list
// makes. An id that does not resolve settles to `null`: the caller shows a neutral label, never the id.
import type { ApiClient } from "@chartwarden/ui";
import { useResolvedNames } from "./resolved-names";

/** Keyed by MDM physician id; absent = still loading, `null` = looked up, no name resolved. */
export type PhysicianNames = Readonly<Record<string, string | null>>;

async function fetchPhysicianName(client: ApiClient, id: string): Promise<string | null> {
  const r = await client.GET("/api/v1/mdm/{kind}/{id}", {
    params: { path: { kind: "physician", id } },
  });
  return r.data?.canonical.displayName || null;
}

export function usePhysicianNames(ids: readonly string[]): PhysicianNames {
  return useResolvedNames("physician", ids, fetchPhysicianName);
}
