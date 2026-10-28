import { schema } from "@chartwarden/db";
// apps/backend/src/modules/05-patient/routes/assignment-typebox.ts — TypeBox contract of the M5 §4.3
// assignment routes (GAP-015). Role values come from the DB enum so the route cannot drift from it.
import { Type } from "@sinclair/typebox";

// `admitting_staff` is the system-issued access grant (create-patient); it is never assigned by hand.
const ROLES = schema.patientAssignments.role.enumValues.filter((r) => r !== "admitting_staff");

export const AssignmentParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  assignmentId: Type.String({ minLength: 1, maxLength: 64 }),
});

export const AssignClinicianBodySchema = Type.Object({
  clinicianUserId: Type.String({ format: "uuid" }),
  role: Type.Union(ROLES.map((r) => Type.Literal(r))),
  assignedAt: Type.Optional(Type.String({ format: "date" })),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
});

export const EndAssignmentBodySchema = Type.Object({
  unassignedAt: Type.Optional(Type.String({ format: "date" })),
});

export const PatientAssignmentViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  clinicianUserId: Type.String(),
  role: Type.String(),
  assignedAt: Type.String({ format: "date" }),
  unassignedAt: Type.Union([Type.String({ format: "date" }), Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
  current: Type.Boolean(),
});

export const PatientAssignmentListResponseSchema = Type.Object({
  assignments: Type.Array(PatientAssignmentViewSchema),
});
