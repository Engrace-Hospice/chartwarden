// @wardenx/billing — override schemas: route #16 `POST /validation-results/:resultId:override` and
// route #17 `GET /validation-overrides` (org-wide override audit view) — §4.1 / §4.2.
//
// Only a FAILED result may be overridden, only by an actor whose role matches the rule's
// `override_role_required`, and NEVER a `regulatory_required` rule (D5). The typed reason floor is 40
// chars (server re-enforced).
import { type Static, Type } from "@sinclair/typebox";
import {
  CursorPageQuery,
  IsoDateTimeSchema,
  OverrideRoleApi,
  PageOf,
  Uuid,
} from "./common";

// ── route #16: apply an override ────────────────────────────────────────────────────────────────────────
export const ValidationOverrideRequest = Type.Object({
  reason: Type.String({ minLength: 40, maxLength: 2000 }),
  /** resultId is implicit from the URL; this guards against overriding a stale result. */
  ifResultVersion: Type.Integer(),
});
export type ValidationOverrideRequest = Static<typeof ValidationOverrideRequest>;

export const ValidationOverrideResponse = Type.Object({
  overrideId: Uuid,
  appliedAt: IsoDateTimeSchema,
  m4AuditEventId: Uuid,
});
export type ValidationOverrideResponse = Static<typeof ValidationOverrideResponse>;

// Errors (per §4.2):
//   403 OVERRIDE_ROLE_INSUFFICIENT    — actor role != rule's override_role_required
//   403 OVERRIDE_FORBIDDEN_REGULATORY — the result's rule is regulatory_required (D5)
//   409 RESULT_NOT_FAILED             — only a failed result can be overridden
//   422 REASON_TOO_SHORT              — server-side floor enforcement

// ── route #17: org-wide override audit view (compliance officer / surveyor) ─────────────────────────────
export const ValidationOverrideListQuery = Type.Composite([
  CursorPageQuery,
  Type.Object({
    providerEntityId: Type.Optional(Uuid),
    ruleKey: Type.Optional(Type.String()),
    appliedFrom: Type.Optional(IsoDateTimeSchema),
    appliedTo: Type.Optional(IsoDateTimeSchema),
  }),
]);
export type ValidationOverrideListQuery = Static<typeof ValidationOverrideListQuery>;

export const ValidationOverrideView = Type.Object({
  overrideId: Uuid,
  resultId: Uuid,
  claimId: Uuid,
  ruleKey: Type.String(),
  overrideRole: OverrideRoleApi,
  actorMembershipId: Uuid,
  /** The typed rationale (PHI-free billing justification, ≥40 chars). */
  reason: Type.String(),
  appliedAt: IsoDateTimeSchema,
  m4AuditEventId: Uuid,
});
export type ValidationOverrideView = Static<typeof ValidationOverrideView>;

export const ValidationOverrideListResponse = PageOf(ValidationOverrideView);
export type ValidationOverrideListResponse = Static<typeof ValidationOverrideListResponse>;
