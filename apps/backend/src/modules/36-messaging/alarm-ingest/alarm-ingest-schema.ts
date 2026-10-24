// M36 WP 6.10 (ADR-0102, PROPOSED) - the strict inbound body of an alarm. NO free-text field exists: a sender cannot put a patient name, a room or
// a sentence into an alert. `additionalProperties: false` refuses anything else. The body is also capped at ALARM_INGEST_MAX_BODY_BYTES by the route.
import {
  ALARM_EVENT_ID_PATTERN,
  ALARM_KIND_PATTERN,
  ALARM_REQUESTED_SEVERITIES,
} from "@chartwarden/types";
import { type Static, Type } from "@sinclair/typebox";

export const AlarmEventBodySchema = Type.Object(
  {
    /** The sender's own id for this alarm: the idempotency key. A retry sends the SAME id. */
    eventId: Type.String({ pattern: ALARM_EVENT_ID_PATTERN }),
    /** The sender's alarm code, mapped by the tenant to a catalog alert type. */
    alarmKind: Type.String({ pattern: ALARM_KIND_PATTERN }),
    /** What the sender thinks the severity is. Capped at the mapping's ceiling; never raises it. */
    severity: Type.Optional(
      Type.Union(ALARM_REQUESTED_SEVERITIES.map((s) => Type.Literal(s))),
    ),
    /** When the device raised it. Optional; refused when far from the server clock. */
    occurredAt: Type.Optional(
      Type.String({
        // ISO 8601 with an explicit zone; the service parses it and bounds it against the server clock.
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$",
        maxLength: 40,
      }),
    ),
  },
  { additionalProperties: false },
);

export type AlarmEventBody = Static<typeof AlarmEventBodySchema>;
