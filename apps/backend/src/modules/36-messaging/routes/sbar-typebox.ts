// apps/backend/src/modules/36-messaging/routes/sbar-typebox.ts - WP 3.3 SBAR policy schemas (request + OpenAPI response).
// The floor is the service's (422 SBAR_POLICY_FLOOR_VIOLATION, naming the field), so `minChars` has no schema minimum:
// a value below the floor must reach `prepareSbarPolicy` rather than fail as a generic parse error.
import { type TSchema, Type } from "@sinclair/typebox";
import { SBAR_MIN_CHARS_CEILING } from "@chartwarden/messaging";

const MinChars = Type.Integer({ maximum: SBAR_MIN_CHARS_CEILING });
// Transport cap only; the 200 character bound and the PHI lint are the service's.
const Hint = Type.Union([Type.String({ maxLength: 1_000 }), Type.Null()]);

export const PutSbarPolicyBodySchema = Type.Object(
  {
    minChars: Type.Optional(
      Type.Object(
        {
          situation: Type.Optional(MinChars),
          background: Type.Optional(MinChars),
          assessment: Type.Optional(MinChars),
          recommendation: Type.Optional(MinChars),
        },
        { additionalProperties: false },
      ),
    ),
    requirePatientChannel: Type.Optional(Type.Boolean()),
    hints: Type.Optional(
      Type.Object(
        {
          situation: Type.Optional(Hint),
          background: Type.Optional(Hint),
          assessment: Type.Optional(Hint),
          recommendation: Type.Optional(Hint),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const perSection = (schema: TSchema) =>
  Type.Object({
    situation: schema,
    background: schema,
    assessment: schema,
    recommendation: schema,
  });

export const SbarPolicyResponseSchema = Type.Object({
  minChars: perSection(Type.Integer()),
  maxChars: Type.Integer(),
  requirePatientChannel: Type.Boolean(),
  hints: perSection(Type.String()),
  customized: Type.Boolean(),
});
