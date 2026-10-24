// apps/backend/src/modules/36-messaging/afterhours-triage/binding.ts - ADR-0082 (PROPOSED, flag `messaging.afterhours_triage`, absent = off): the
// composition-root binding. ONE flag read (the flag and the four it needs), shared by the role send, the urgent send's transaction hook and the
// thread-line read. The outcome consumer is built separately (outbox-consumers/afterhours-outcome.ts) over the same store.
import type { DbClient } from "@chartwarden/db";
import { derivePatient } from "@chartwarden/messaging";
import { getSeam } from "../../../bootstrap/index";
import { createDbChannelFactsLookup } from "../medication-questions/deps";
import type { HintOutboxPort } from "../message-hint-events";
import { SUD_PRIVACY_FLAG } from "../part2-channel-gate";
import { type AfterHoursLinkStore, createDbAfterHoursLinkStore } from "./afterhours-link-store";
import { type AfterHoursFlagReader, buildAfterHoursEnabled } from "./afterhours-flag";
import { type AfterHoursLinesService, createAfterHoursLinesService } from "./afterhours-lines";
import { createAfterHoursRequestWriter } from "./afterhours-request";

export interface AfterHoursBindingInput {
  readonly db: DbClient;
  readonly flags?: AfterHoursFlagReader | undefined;
  readonly outbox?: HintOutboxPort | undefined;
}

export interface AfterHoursBinding {
  readonly enabled: (orgId: string) => Promise<boolean>;
  readonly store: AfterHoursLinkStore;
  /** The urgent service's transaction-hook port (`UrgentServiceDeps.afterHoursTriage`). */
  readonly urgentPort: {
    readonly enabled: (orgId: string) => Promise<boolean>;
    readonly requestInTx: ReturnType<typeof createAfterHoursRequestWriter>;
  };
  readonly lines: AfterHoursLinesService;
}

type PrivacyFlagReaderShape = {
  roomingFactsFor(input: {
    organizationId: string;
    patientIds: readonly string[];
  }): Promise<readonly { patientId: string; privacyFlags: readonly string[] }[]>;
};

/** Restricted (Part 2) = the channel's patient carries M5's `sud` privacy flag. Any failure throws (the lines service reads that as restricted). */
function createRestrictedChannelCheck(db: DbClient) {
  const channelFacts = createDbChannelFactsLookup(db);
  return async (orgId: string, channelId: string): Promise<boolean> => {
    const facts = await channelFacts(orgId, channelId);
    const patientId = facts ? derivePatient(facts.kind, facts.subjectId) : null;
    if (!patientId) throw new Error("channel has no patient");
    const reader = getSeam("PatientPrivacyFlagReader") as unknown as PrivacyFlagReaderShape;
    const found = await reader.roomingFactsFor({ organizationId: orgId, patientIds: [patientId] });
    const fact = found.find((f) => f.patientId === patientId);
    if (!fact) throw new Error("privacy flags unreadable");
    return fact.privacyFlags.includes(SUD_PRIVACY_FLAG);
  };
}

export function buildAfterHoursTriageBinding(input: AfterHoursBindingInput): AfterHoursBinding {
  const enabled = buildAfterHoursEnabled(input.flags);
  const store = createDbAfterHoursLinkStore(input.db);
  return {
    enabled,
    store,
    urgentPort: {
      enabled,
      requestInTx: createAfterHoursRequestWriter({ outbox: input.outbox, store }),
    },
    lines: createAfterHoursLinesService({
      isEnabled: enabled,
      store,
      isRestrictedChannel: createRestrictedChannelCheck(input.db),
    }),
  };
}
