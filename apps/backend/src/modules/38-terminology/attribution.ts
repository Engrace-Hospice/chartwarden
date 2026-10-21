// apps/backend/src/modules/38-terminology/attribution.ts — licence attribution exposure (GAP-108).
//
// SNOMED CT, LOINC and the RxNorm full release are free to use only with attribution. The text comes from the
// active `terminology_license_attestation` and is exposed three ways: the `X-Terminology-Attribution` response
// header on every `/:system/*` read route, `GET /api/v1/terminology/attributions` for UI footers/about screens,
// and the FHIR `CodeSystem.copyright` element (the store fills `CodeSystemMeta.copyright`). Reads sit on the hot
// lookup path, so the resolver caches the (tiny) active set for a short TTL; a freshly recorded or revoked
// attestation is visible everywhere within that window.
import type { CodeSystemId } from "@chartwarden/terminology";
import type { SystemAttribution, TerminologyOpsStore } from "./ops-store";

/** Response header carrying a system's attribution text (header-safe, single line). */
export const ATTRIBUTION_HEADER = "x-terminology-attribution";
const HEADER_MAX_CHARS = 1000;
const DEFAULT_TTL_MS = 60_000;

/** The resolver the read routes consult. */
export interface AttributionResolver {
  textFor(system: CodeSystemId): Promise<string | null>;
  all(): Promise<readonly SystemAttribution[]>;
}

/** A header-safe rendering: printable ASCII only, whitespace collapsed, bounded. Full text is on /attributions. */
export function attributionHeaderValue(text: string): string {
  const flat = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\x20-\x7e]/g, "?");
  return flat.length > HEADER_MAX_CHARS ? `${flat.slice(0, HEADER_MAX_CHARS - 3)}...` : flat;
}

/** Cache the active attributions for `ttlMs`. */
export function createAttributionResolver(
  ops: Pick<TerminologyOpsStore, "activeAttributions">,
  ttlMs: number = DEFAULT_TTL_MS,
  clock: () => number = Date.now,
): AttributionResolver {
  let cache: { at: number; items: readonly SystemAttribution[] } | null = null;
  async function load(): Promise<readonly SystemAttribution[]> {
    if (cache && clock() - cache.at < ttlMs) return cache.items;
    const items = await ops.activeAttributions();
    cache = { at: clock(), items };
    return items;
  }
  return {
    all: load,
    async textFor(system) {
      return (await load()).find((a) => a.systemId === system)?.attributionText ?? null;
    },
  };
}
