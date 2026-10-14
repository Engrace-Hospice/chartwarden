// apps/backend/src/modules/36-messaging/handoffs/binding.ts - WP 3.5: the composition-root binding for clinical handoffs.
//
// The tenant flag `messaging.handoffs` is read through the platform's FeatureFlagReaderPort (tenant row wins; absent = off,
// a kill switch = off), cached a few seconds per org like tasks and SBAR. Everything is built from ports so the routes, the
// expiry tick, the notification consumer and the revocation consumer share one service and one store. The expiry tick and
// the offboarding sweep do NOT consult the flag: accountability must never stall on it.
import type { DbClient } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import type { HintOutboxPort } from "../message-hint-events";
import type { Tx } from "../messaging-write-core";
import type { Part2ChannelGate } from "../part2-channel-gate";
import { cacheFlagRead } from "../presence/binding";
import { createDbTaskStore } from "../tasks/task-store-db";
import type { PatientLabelPort } from "./handoff-dto";
import { type ExpirySummary, expireDueHandoffsForOrg } from "./handoff-expiry";
import { createDbHandoffPolicyStore } from "./handoff-policy-store-db";
import { type ResolveSummary, reassignHandoffsForLeaver } from "./handoff-reassign";
import { HANDOFFS_FLAG_KEY, type HandoffService, createHandoffService } from "./handoff-service";
import { createSeamSourcePorts } from "./handoff-sources";
import { createDbHandoffStore } from "./handoff-store-db";
import { createSeamSummaryPorts } from "./handoff-summaries";

export interface HandoffBindingInput {
  readonly db: DbClient;
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  readonly outbox?: HintOutboxPort | undefined;
  readonly messaging: {
    canViewChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;
  };
  readonly caseloadPatientIds: (orgId: string, userId: string) => Promise<readonly string[]>;
  readonly patientLabels: PatientLabelPort;
  readonly part2Gate: Part2ChannelGate;
  readonly permissionsFor: (orgId: string, userId: string) => Promise<ReadonlySet<string>>;
  readonly isActiveUser: (orgId: string, userId: string) => Promise<boolean>;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  readonly now?: () => Date;
  /** Failure log sink for the tick and the offboarding sweep (ids and error class name only). */
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

export interface HandoffBinding {
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  readonly service: HandoffService;
  /** The expiry tick body for one org (flag-independent). */
  readonly expireDue: (orgId: string) => Promise<ExpirySummary>;
  /** Offboarding: wire next to the task reassignment in the access-revocation consumer. */
  readonly reassignForLeaver: (orgId: string, leaverUserId: string) => Promise<ResolveSummary>;
  /** Notification-consumer port: is the handoff still open? A stale `offered` event must not alert. */
  readonly stillOffered: (orgId: string, handoffId: string) => Promise<boolean>;
  /** Notification-consumer port: a user who left must not be alerted. */
  readonly isActiveUser: (orgId: string, userId: string) => Promise<boolean>;
  /** Notification-consumer port: record that no supervisor could be reached (idempotent). */
  readonly markNeedsAttention: (orgId: string, handoffId: string) => Promise<void>;
}

export function buildHandoffBinding(input: HandoffBindingInput): HandoffBinding {
  const { db, flags, outbox } = input;
  const store = createDbHandoffStore(db);
  const policyStore = createDbHandoffPolicyStore(db);
  const clock = input.now ? { now: input.now } : {};
  const warn = input.warn ? { warn: input.warn } : {};
  return {
    isEnabled: cacheFlagRead(async (organizationId) =>
      flags ? (await flags.forOrg(organizationId))[HANDOFFS_FLAG_KEY] === true : false,
    ),
    service: createHandoffService({
      db,
      outbox,
      store,
      policyStore,
      taskStore: createDbTaskStore(db),
      messaging: input.messaging,
      caseloadPatientIds: input.caseloadPatientIds,
      patientLabels: input.patientLabels,
      part2Gate: input.part2Gate,
      permissionsFor: input.permissionsFor,
      isActiveUser: input.isActiveUser,
      sources: createSeamSourcePorts((o, u, p) => store.activeTasksAssignedTo(o, u, p)),
      summaries: createSeamSummaryPorts((o, ids) => store.taskStatuses(o, ids)),
      displayName: input.displayName,
      ...clock,
    }),
    expireDue: (orgId) =>
      expireDueHandoffsForOrg({ db, store, policyStore, outbox, ...clock, ...warn }, orgId),
    reassignForLeaver: (orgId, leaverUserId) =>
      reassignHandoffsForLeaver(
        { db, store, taskStore: createDbTaskStore(db), outbox, ...clock, ...warn },
        orgId,
        leaverUserId,
      ),
    isActiveUser: input.isActiveUser,
    stillOffered: async (orgId, handoffId) => (await store.stateOf(orgId, handoffId)) === "offered",
    markNeedsAttention: (orgId, handoffId) =>
      withOrgContext(db, systemOrgContext(orgId), async (tx) => {
        await store.markNeedsAttention(tx as unknown as Tx, orgId, handoffId);
      }),
  };
}
