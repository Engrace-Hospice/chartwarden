// M8's consumer of `m17.visit.started`: the visit-note closure clock starts at the clinician's arrival (ADR-0113).
// M17 owns the visit; M8 owns the seeded draft and its clock columns, so M8 reads the started visit and stamps
// its own `encounter` row. The instant is device-supplied (an EVV capture or the visit start), so it is clamped to
// [service date org-local 00:00, the event's server-side creation time] against handset clock skew before it becomes a
// deadline. The upper bound is the outbox row's `createdAt` (the server clock when M17 recorded the start), NOT this consumer's
// delivery time: a backlog or a retry must not widen the window a device can choose its arrival from.
import { type DbClient, organizationTimezone, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { EncounterClockStartSource } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import type { DispatchableOutboxEvent } from "../../../bootstrap/outbox-dispatcher";
import { clampClockStart, localDayStart, stampClockIfNull } from "../closure/clock-stamp";
import { isOpenNoteStatus } from "../closure/open-status";

const ENC = schema.encounters;
const CONSUMER_NAME = "m8.stamp-note-clock";
/** The M17/M18 bracket value that says EVV (not a self-attest) captured the arrival. */
const EVV_PRESENT = "evv_present";

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${CONSUMER_NAME}: payload must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${CONSUMER_NAME}: '${key}' must be a non-empty string`);
  }
  return value;
}

function startedInstantOf(payload: Record<string, unknown>): Date {
  const startedAt = new Date(nonEmptyString(payload, "startedAt"));
  if (Number.isNaN(startedAt.getTime())) {
    throw new Error(`${CONSUMER_NAME}: 'startedAt' must be an ISO instant`);
  }
  return startedAt;
}

export function buildM8VisitStartedNoteClockConsumer(deps: { readonly db: DbClient }): {
  readonly consumerName: typeof CONSUMER_NAME;
  readonly consumerModule: "m8";
  readonly eventTypes: readonly ["m17.visit.started"];
  handle(event: DispatchableOutboxEvent): Promise<void>;
} {
  return {
    consumerName: CONSUMER_NAME,
    consumerModule: "m8",
    eventTypes: ["m17.visit.started"],
    async handle(event) {
      const payload = recordOf(event.payload);
      const visitId = nonEmptyString(payload, "visitId");
      const startedAt = startedInstantOf(payload);
      const source: EncounterClockStartSource =
        payload.evvBracketState === EVV_PRESENT ? "evv_check_in" : "visit_started";
      await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: "" },
        async (txRaw) => {
          const tx = txRaw as DbClient;
          const [encounter] = await tx
            .select({
              serviceDate: ENC.serviceDate,
              status: ENC.status,
              clockStartedAt: ENC.clockStartedAt,
            })
            .from(ENC)
            .where(and(eq(ENC.organizationId, event.organizationId), eq(ENC.visitId, visitId)))
            .limit(1);
          // ponytail: a visit whose draft was never seeded has no row to stamp, so the clock falls back to the first
          // authoring write (`draft_opened`); upgrade = throw here so the delivery retries until the seed lands.
          if (!encounter || encounter.clockStartedAt !== null) return;
          if (!isOpenNoteStatus(encounter.status)) return;
          const timeZone = await organizationTimezone(tx, event.organizationId);
          const at = clampClockStart(
            startedAt,
            localDayStart(encounter.serviceDate, timeZone),
            event.createdAt,
          );
          // The UPDATE is the real guard (null clock, open status): a concurrent stamp makes this a no-op.
          await stampClockIfNull(tx, { orgId: event.organizationId, visitId, at, source });
        },
      );
    },
  };
}
