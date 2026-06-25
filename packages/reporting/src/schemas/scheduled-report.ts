// @wardenx/reporting — the `ScheduledReportCreate` TypeBox schema (M33 §4.2).
//
// The create-payload validator for a `report_schedule` row: a saved view + cron + IANA timezone +
// delivery format + recipient membership_ids (D7). Shape gate only — the domain rules (§2.3
// CRON_TOO_FREQUENT ≥ 5 min between ticks, RECIPIENT_NOT_IN_ORG, PDF_ROW_LIMIT_EXCEEDED) are enforced
// at the schedule-service layer, not here.
import { type Static, Type } from "@sinclair/typebox";

export const ScheduledReportCreate = Type.Object({
  reportViewId: Type.String({ format: "uuid" }),
  cronExpression: Type.String({ pattern: "^[0-9*/,\\- ]+$" }), // validated server-side too
  tenantTimezone: Type.String(), // IANA TZ name
  format: Type.Union([Type.Literal("pdf"), Type.Literal("xlsx"), Type.Literal("csv")]),
  recipientMembershipIds: Type.Array(Type.String({ format: "uuid" }), {
    minItems: 1,
    maxItems: 50,
  }),
});

export type ScheduledReportCreateT = Static<typeof ScheduledReportCreate>;
