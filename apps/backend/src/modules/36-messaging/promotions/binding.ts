// apps/backend/src/modules/36-messaging/promotions/binding.ts - WP 3.7: the composition-root binding for chart promotion.
//
// The tenant flag `messaging.promotions` is read through the platform's FeatureFlagReaderPort (tenant row wins; absent =
// off, a kill switch = off), cached a few seconds per org like tasks and handoffs. Everything is built from ports so the
// routes, the source-reader seam and the two outbox consumers share one service and one store. The outcome consumer does
// NOT consult the flag: a decision an owning module already committed must always be recorded.
import type { DbClient } from "@chartwarden/db";
import type { ChartPromotionSourceReader, ClinicalLinkSource } from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";
import type { HintOutboxPort } from "../message-hint-events";
import type { Part2ChannelGate } from "../part2-channel-gate";
import { cacheFlagRead } from "../presence/binding";
import {
  PROMOTIONS_FLAG_KEY,
  type PromotionMessageFacts,
  type PromotionService,
  createPromotionService,
} from "./promotion-service";
import { type PromotionBodyOpener, createDbPromotionBodyPorts } from "./promotion-snapshot";
import { createPromotionSourceReader } from "./promotion-source-reader";
import { createDbPromotionStore } from "./promotion-store-db";

export interface PromotionBindingInput {
  readonly db: DbClient;
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  readonly outbox?: HintOutboxPort | undefined;
  readonly messaging: {
    canViewChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;
  };
  readonly messageLookup: (
    orgId: string,
    channelId: string,
    messageId: string,
  ) => Promise<PromotionMessageFacts | null>;
  readonly part2Gate: Part2ChannelGate;
  /** The entitled-reader message body decrypt (`MessageBodyCipher.open`); no new crypto lives in this module. */
  readonly bodyOpener: PromotionBodyOpener;
  readonly permissionsFor: (orgId: string, userId: string) => Promise<ReadonlySet<string>>;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  /** Defaults to the IdgScheduleProvider seam's `linkSummary` (a meeting of the organisation exists). */
  readonly meetingExists?: (orgId: string, meetingId: string) => Promise<boolean>;
  readonly now?: () => Date;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

/** The consumer-facing facts of one request. Includes the patient id: an in-process port, never an event payload. */
export interface PromotionRequestFacts {
  readonly requestedByUserId: string;
  readonly targetModule: string;
  readonly targetKind: string;
  readonly status: string;
  readonly patientId: string;
}

export interface PromotionBinding {
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  readonly service: PromotionService;
  /** The seam implementation M8 and M14 read; register it with `registerMessagingSeams({ promotionSource })`. */
  readonly sourceReader: ChartPromotionSourceReader;
  /** Notification-consumer port: is the request still proposed? A stale `requested` event must not alert. */
  readonly stillProposed: (orgId: string, promotionRequestId: string) => Promise<boolean>;
  /** Consumer port: who asked, for what target and about which patient (null when the request is gone). */
  readonly requestFacts: (
    orgId: string,
    promotionRequestId: string,
  ) => Promise<PromotionRequestFacts | null>;
}

const seamMeetingExists = async (orgId: string, meetingId: string): Promise<boolean> =>
  (await (getSeam("IdgScheduleProvider") as ClinicalLinkSource).linkSummary(orgId, meetingId)) !==
  null;

export function buildPromotionBinding(input: PromotionBindingInput): PromotionBinding {
  const { db, flags, outbox } = input;
  const store = createDbPromotionStore(db);
  const isEnabled = cacheFlagRead(async (organizationId) =>
    flags ? (await flags.forOrg(organizationId))[PROMOTIONS_FLAG_KEY] === true : false,
  );
  const warn = input.warn ? { warn: input.warn } : {};
  const clock = input.now ? { now: input.now } : {};
  return {
    isEnabled,
    service: createPromotionService({
      db,
      outbox,
      store,
      messaging: input.messaging,
      messageLookup: input.messageLookup,
      part2Gate: input.part2Gate,
      permissionsFor: input.permissionsFor,
      meetingExists: input.meetingExists ?? seamMeetingExists,
      displayName: input.displayName,
      ...clock,
      ...warn,
    }),
    sourceReader: createPromotionSourceReader({
      store,
      isEnabled,
      part2Gate: input.part2Gate,
      bodies: createDbPromotionBodyPorts(db, input.bodyOpener),
      permissionsFor: input.permissionsFor,
    }),
    stillProposed: async (orgId, id) => (await store.get(orgId, id))?.status === "proposed",
    requestFacts: async (orgId, id) => {
      const row = await store.get(orgId, id);
      return row
        ? {
            requestedByUserId: row.requestedByUserId,
            targetModule: row.targetModule,
            targetKind: row.targetKind,
            status: row.status,
            patientId: row.patientId,
          }
        : null;
    },
  };
}
