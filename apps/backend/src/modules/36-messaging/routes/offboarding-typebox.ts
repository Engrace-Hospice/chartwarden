import { OFFBOARDING_ITEM_KEYS, OFFBOARDING_ITEM_STATES } from "@chartwarden/types";
// apps/backend/src/modules/36-messaging/routes/offboarding-typebox.ts - WP 5.9 (ADR-0084, PROPOSED) schemas for the workforce-offboarding routes.
// Counts and fixed keys only: no name, message text or patient.
import { Type } from "@sinclair/typebox";
import { UUID_PATTERN } from "./messaging-typebox";

const literals = <T extends string>(values: readonly T[]) =>
  Type.Unsafe<T>(Type.Union(values.map((v) => Type.Literal(v))));

export const OffboardingParamsSchema = Type.Object(
  { userId: Type.String({ pattern: UUID_PATTERN }) },
  { additionalProperties: false },
);

export const OffboardingItemSchema = Type.Object({
  key: literals(OFFBOARDING_ITEM_KEYS),
  state: literals(OFFBOARDING_ITEM_STATES),
  count: Type.Integer({ minimum: 0 }),
  acted: Type.Integer({ minimum: 0 }),
  needs_person: Type.Integer({ minimum: 0 }),
});

export const OffboardingResponseSchema = Type.Object({
  user_id: Type.String(),
  items: Type.Array(OffboardingItemSchema),
  done: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  complete: Type.Boolean(),
  blocked_by: Type.Array(literals(OFFBOARDING_ITEM_KEYS)),
});
