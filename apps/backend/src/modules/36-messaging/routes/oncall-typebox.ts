// apps/backend/src/modules/36-messaging/routes/oncall-typebox.ts - WP 4.12 (ADR-0080) schemas for the on-call directory. The query
// accepts ONLY a role from the closed list and a patient id (the router is patient-scoped); an unknown key is a 422. The response is
// display names, enums and instants: no user id, no contact detail, no patient data.
import { type TSchema, Type } from "@sinclair/typebox";
import { ONCALL_DIRECTORY_ROLES, ONCALL_DIRECTORY_STATUSES, ONCALL_RANKS } from "@wardenx/types";
import { UUID_PATTERN } from "./messaging-typebox";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const oneOf = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((v) => Type.Literal(v)));

export const OnCallCoverageQuerySchema = Type.Object(
  { role: oneOf(ONCALL_DIRECTORY_ROLES), patient_id: Type.String({ pattern: UUID_PATTERN }) },
  { additionalProperties: false },
);

export const OnCallCoverageResponseSchema = Type.Object({
  role: oneOf(ONCALL_DIRECTORY_ROLES),
  as_of: Type.String({ format: "date-time" }),
  status: oneOf(ONCALL_DIRECTORY_STATUSES),
  tiers: Type.Array(
    Type.Object({
      tier: Type.Integer({ minimum: 1 }),
      state: oneOf(["covering", "coverage_gap"] as const),
      people: Type.Array(
        Type.Object({ display_name: nullable(Type.String()), rank: oneOf(ONCALL_RANKS) }),
      ),
      shift_ends_at: nullable(Type.String({ format: "date-time" })),
      time_zone: Type.String(),
    }),
  ),
});
