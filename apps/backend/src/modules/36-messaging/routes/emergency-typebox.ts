// apps/backend/src/modules/36-messaging/routes/emergency-typebox.ts - M36 ADR-0106 route schemas. The request side is parsed by hand in the
// handler (after the flag check), so a malformed request cannot tell a flag-off tenant from a flag-on one.
import { Type } from "@sinclair/typebox";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export const EmergencyMessageParamsSchema = Type.Object({
  messageId: Type.String({ pattern: UUID_PATTERN }),
});
export const EmergencyParamsSchema = Type.Object({
  emergencyId: Type.String({ pattern: UUID_PATTERN }),
});

const SummaryProps = {
  emergencyId: Type.String(),
  messageId: Type.String(),
  channelId: Type.String(),
  createdAt: Type.String(),
  deadlineAt: Type.String(),
  counts: Type.Object({
    audience: Type.Integer(),
    acknowledged: Type.Integer(),
    pending: Type.Integer(),
  }),
  pastDeadline: Type.Boolean(),
};

const EmergencySummarySchema = Type.Object(SummaryProps);
export const EmergencyCreatedSchema = Type.Object({ ...SummaryProps, created: Type.Boolean() });
export const EmergencyDetailSchema = Type.Object({
  ...SummaryProps,
  people: Type.Array(
    Type.Object({
      userId: Type.String(),
      displayName: Type.String(),
      acknowledgedAt: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});
export const EmergencyListSchema = Type.Object({ emergencies: Type.Array(EmergencySummarySchema) });
export const EmergencyMineSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      emergencyId: Type.String(),
      messageId: Type.String(),
      channelId: Type.String(),
      createdAt: Type.String(),
      deadlineAt: Type.String(),
      acknowledgedAt: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});
export const EmergencyAcknowledgedSchema = Type.Object({
  emergencyId: Type.String(),
  acknowledgedAt: Type.String(),
  already: Type.Boolean(),
});
