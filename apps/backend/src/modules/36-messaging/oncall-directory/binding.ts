// apps/backend/src/modules/36-messaging/oncall-directory/binding.ts - WP 4.12 (ADR-0080): the composition-root binding. The ops flag
// `messaging.oncall_directory` (tenant row wins; absent = off) is read through the platform's FeatureFlagReaderPort and cached a few
// seconds per org. The router is the M1 seam behind the org-checking guard (a test source or a malformed answer is refused).
import type { DbClient } from "@wardenx/db";
import { ONCALL_DIRECTORY_FLAG_KEY } from "@wardenx/types";
import { guardEscalationRouter } from "../ack-escalation/escalation-router-guard";
import { createMentionActorNameResolver } from "../mention-non-member-service-db";
import { cacheFlagRead } from "../presence/binding";
import { getEscalationRouter } from "../seams";
import { type OnCallCoverageService, createOnCallCoverageService } from "./oncall-coverage-service";

export interface OnCallDirectoryInput {
  readonly db: DbClient;
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
}

export function buildOnCallDirectoryDeps(input: OnCallDirectoryInput): {
  readonly service: OnCallCoverageService;
} {
  return {
    service: createOnCallCoverageService({
      isEnabled: cacheFlagRead(async (organizationId) =>
        input.flags
          ? (await input.flags.forOrg(organizationId))[ONCALL_DIRECTORY_FLAG_KEY] === true
          : false,
      ),
      router: guardEscalationRouter({
        resolveTier: (orgId, request) => getEscalationRouter().resolveTier(orgId, request),
      }),
      displayName: createMentionActorNameResolver(input.db),
    }),
  };
}
