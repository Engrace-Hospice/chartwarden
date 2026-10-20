// apps/backend/src/modules/05-patient/routes/care-team-staff-typebox.ts — contract of the care-team
// staff lookup. The response schema is the allowlist: nothing outside it is ever serialised.
import { Type } from "@sinclair/typebox";

export const CARE_TEAM_STAFF_MAX_LIMIT = 200;

export const CareTeamStaffParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});

export const CareTeamStaffQuerySchema = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 100 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: CARE_TEAM_STAFF_MAX_LIMIT })),
});

export const CareTeamStaffViewSchema = Type.Object({
  userId: Type.String(),
  membershipId: Type.String(),
  displayName: Type.Union([Type.String(), Type.Null()]),
  roleLabels: Type.Array(Type.String()),
});

export const CareTeamStaffListResponseSchema = Type.Object({
  staff: Type.Array(CareTeamStaffViewSchema),
});
