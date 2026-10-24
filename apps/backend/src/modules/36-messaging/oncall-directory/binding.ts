// apps/backend/src/modules/36-messaging/oncall-directory/binding.ts - WP 4.12 (ADR-0080) and the role-based send follow-on (ADR-0081): the
// composition-root binding. The ops flags `messaging.oncall_directory` and `messaging.role_send` (tenant row wins; absent = off) are read
// through the platform's FeatureFlagReaderPort and cached a few seconds per org. The router is the M1 seam behind the org-checking guard
// (a test source or a malformed answer is refused); BOTH features share that one guarded router, so the real M19 router drops in unchanged.
import type { DbClient } from "@chartwarden/db";
import { derivePatient } from "@chartwarden/messaging";
import { ONCALL_DIRECTORY_FLAG_KEY, ROLE_SEND_FLAG_KEY } from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";
import { guardEscalationRouter } from "../ack-escalation/escalation-router-guard";
import { createDbRoleReplayLookup } from "../ack-requests/role-replay-lookup";
import type { AfterHoursLinesService } from "../afterhours-triage/afterhours-lines";
import type { AfterHoursBinding } from "../afterhours-triage/binding";
import { createDbChannelFactsLookup } from "../medication-questions/deps";
import { createMentionActorNameResolver } from "../mention-non-member-service-db";
import { cacheFlagRead } from "../presence/binding";
import { getEscalationRouter } from "../seams";
import { type OnCallCoverageService, createOnCallCoverageService } from "./oncall-coverage-service";
import type { RoleSendPorts } from "./role-send-service";

export interface OnCallDirectoryInput {
  readonly db: DbClient;
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  /** ADR-0082: the after-hours triage binding (flag off or absent = the role send is exactly ADR-0081). */
  readonly afterHours?: Pick<AfterHoursBinding, "enabled" | "lines"> | undefined;
}

export function buildOnCallDirectoryDeps(input: OnCallDirectoryInput): {
  readonly service: OnCallCoverageService;
  readonly patientExists: (organizationId: string, patientId: string) => Promise<boolean>;
  /** ADR-0081: the ports of the role-based send; the route layer adds the urgent service. */
  readonly roleSend: RoleSendPorts;
  /** ADR-0082 S4/S5: the thread-line read (omitted => the uniform 404). */
  readonly afterHoursLines?: AfterHoursLinesService;
} {
  const flag = (key: string) =>
    cacheFlagRead(async (organizationId) =>
      input.flags ? (await input.flags.forOrg(organizationId))[key] === true : false,
    );
  const router = guardEscalationRouter({
    resolveTier: (orgId, request) => getEscalationRouter().resolveTier(orgId, request),
  });
  const displayName = createMentionActorNameResolver(input.db);
  const channelFacts = createDbChannelFactsLookup(input.db);
  return {
    // M5's PatientReader seam (org-scoped). An unbound deny-stub throws, which is a 500, never "exists".
    patientExists: async (organizationId, id) =>
      (await getSeam("PatientReader").findById({ organizationId, id })) !== null,
    service: createOnCallCoverageService({
      isEnabled: flag(ONCALL_DIRECTORY_FLAG_KEY),
      router,
      displayName,
    }),
    roleSend: {
      isEnabled: flag(ROLE_SEND_FLAG_KEY),
      router,
      displayName,
      channelPatient: async (orgId, channelId) => {
        const facts = await channelFacts(orgId, channelId);
        return facts?.kind === "care_team" ? derivePatient(facts.kind, facts.subjectId) : null;
      },
      findReplay: createDbRoleReplayLookup(input.db),
      ...(input.afterHours ? { afterHours: { enabled: input.afterHours.enabled } } : {}),
    },
    ...(input.afterHours ? { afterHoursLines: input.afterHours.lines } : {}),
  };
}
