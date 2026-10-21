// apps/backend/src/modules/36-messaging/clinical-link/binding.ts - WP 3.2: the composition-root binding for clinical links.
//
// The tenant flag `messaging.clinical_links` is read through the platform's FeatureFlagReaderPort (tenant row wins; absent
// = off, a kill switch = off), cached a few seconds per org like presence. The source ports are the owning modules' seams.
import type { DbClient } from "@chartwarden/db";
import { cacheFlagRead } from "../presence/binding";
import type { ClinicalLinkRouteDeps } from "../routes/clinical-link-routes";
import { CLINICAL_LINKS_FLAG_KEY } from "./clinical-link-service";
import { createDbClinicalLinkStore } from "./clinical-link-store-db";
import { seamClinicalLinkSources } from "./link-sources";

export interface ClinicalLinkBindingInput {
  readonly db: DbClient;
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
}

export function buildClinicalLinkDeps(
  input: ClinicalLinkBindingInput,
): Omit<ClinicalLinkRouteDeps, "canViewChannel"> {
  const { flags } = input;
  return {
    isEnabled: cacheFlagRead(async (organizationId) =>
      flags ? (await flags.forOrg(organizationId))[CLINICAL_LINKS_FLAG_KEY] === true : false,
    ),
    sources: seamClinicalLinkSources,
    store: createDbClinicalLinkStore(input.db),
  };
}
