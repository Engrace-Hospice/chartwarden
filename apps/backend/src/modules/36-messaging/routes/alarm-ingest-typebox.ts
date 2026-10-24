// apps/backend/src/modules/36-messaging/routes/alarm-ingest-typebox.ts - WP 6.10 (ADR-0101, PROPOSED) schemas for the alarm ingest routes.
// Wire keys are camelCase (the contract in packages/types/src/messaging-alarm-ingest.ts). No schema here carries a secret except the one-time
// credential response; the list shape has no cipher, no hash and no secret.
import {
  ALARM_INGEST_ALERT_TYPES,
  ALARM_INGEST_EVENT_STATUSES,
  ALARM_KIND_PATTERN,
  ALARM_MAX_MAPPINGS_PER_SOURCE,
  ALARM_SEVERITY_CEILINGS,
  ALARM_SOURCE_NAME_MAX,
} from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import { UUID_PATTERN } from "./messaging-typebox";

// The inbound body schema lives with the module (the service validates with it); re-exported here so the route surface, and the OpenAPI contract,
// take it from the routes directory like every other schema.
export { AlarmEventBodySchema } from "../alarm-ingest/alarm-ingest-schema";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const Instant = Type.String({ format: "date-time" });
const NullableInstant = Type.Union([Instant, Type.Null()]);

export const AlarmSourceIdParamsSchema = Type.Object({ id: Uuid }, { additionalProperties: false });

const Mapping = Type.Object(
  {
    alarmKind: Type.String({ pattern: ALARM_KIND_PATTERN }),
    alertType: Type.Union(ALARM_INGEST_ALERT_TYPES.map((t) => Type.Literal(t))),
    severityCeiling: Type.Union(ALARM_SEVERITY_CEILINGS.map((c) => Type.Literal(c))),
  },
  { additionalProperties: false },
);

export const CreateAlarmSourceBodySchema = Type.Object(
  {
    // Trimmed length is enforced again by the service and the table CHECK; the schema bounds the raw input.
    name: Type.String({ minLength: 1, maxLength: ALARM_SOURCE_NAME_MAX + 100 }),
    mappings: Type.Array(Mapping, { minItems: 1, maxItems: ALARM_MAX_MAPPINGS_PER_SOURCE }),
  },
  { additionalProperties: false },
);

const SourceShape = {
  id: Uuid,
  name: Type.String(),
  enabled: Type.Boolean(),
  secretGeneration: Type.Integer(),
  createdAt: Instant,
  rotatedAt: NullableInstant,
  disabledAt: NullableInstant,
  lastAcceptedAt: NullableInstant,
  mappings: Type.Array(Mapping),
  last24h: Type.Object({
    alerted: Type.Integer(),
    noRecipients: Type.Integer(),
    unmapped: Type.Integer(),
    pending: Type.Integer(),
  }),
};

export const AlarmSourceResponseSchema = Type.Object(SourceShape);
export const AlarmSourceCredentialResponseSchema = Type.Object({
  ...SourceShape,
  keyId: Type.String(),
  secret: Type.String(),
});
export const AlarmSourceListResponseSchema = Type.Object({
  sources: Type.Array(AlarmSourceResponseSchema),
});

export const AlarmIngestAcceptedResponseSchema = Type.Object({
  status: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate")]),
  outcome: Type.Union(ALARM_INGEST_EVENT_STATUSES.map((s) => Type.Literal(s))),
});
