// apps/backend/src/modules/36-messaging/routes/patient-context-typebox.ts — WP 3.1 response schema (OpenAPI only; the
// handler returns the service's plain object, which this mirrors).
import { Type } from "@sinclair/typebox";

const Ok = <T extends ReturnType<typeof Type.Object>>(data: T) =>
  Type.Object({
    state: Type.Literal("ok"),
    as_of: Type.String({ format: "date-time" }),
    link: Type.String(),
    data,
  });
const Unavailable = Type.Object({ state: Type.Literal("unavailable"), link: Type.String() });
const Tile = <T extends ReturnType<typeof Type.Object>>(data: T) =>
  Type.Union([Ok(data), Unavailable]);

export const PatientContextResponseSchema = Type.Object({
  patient_id: Type.String({ format: "uuid" }),
  // A tile the caller may not see is ABSENT, so every key is optional.
  tiles: Type.Object({
    status: Type.Optional(Tile(Type.Object({ status: Type.Union([Type.String(), Type.Null()]) }))),
    care_team: Type.Optional(Tile(Type.Object({ member_count: Type.Integer() }))),
    allergies: Type.Optional(
      Tile(
        Type.Object({
          entries: Type.Array(
            Type.Object({
              allergen: Type.String(),
              severity: Type.Union([Type.String(), Type.Null()]),
            }),
          ),
        }),
      ),
    ),
    medications: Type.Optional(Tile(Type.Object({ active_count: Type.Integer() }))),
    // The caller's own active tasks on the patient; absent while the tenant flag `messaging.tasks` is off.
    open_tasks: Type.Optional(Tile(Type.Object({ count: Type.Integer() }))),
  }),
});
