// @wardenx/billing — rule-config CRUD: route #18 `GET /rule-config` (list overlay + platform snapshot),
// route #19 `PATCH /rule-config/:ruleKey` (tenant overlay edit), route #20 `POST /rule-config:custom`
// (tenant custom rule with predicate DSL), route #21 `DELETE /rule-config/:ruleKey` (revert to default).
// §4.1. The D5 platform-floor protection (no overlay/disable on a `regulatory_required` rule) is enforced
// at the ABAC predicate + service layer; these are SHAPE gates only.
import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTimeSchema, OverrideRoleApi, Uuid, ValidationSeverityApi } from "./common";

export const RuleKeyParams = Type.Object({
  ruleKey: Type.String({ minLength: 1, maxLength: 128 }),
});
export type RuleKeyParams = Static<typeof RuleKeyParams>;

// ── route #18: the editor list — platform registry snapshot + tenant overlay ────────────────────────────
/** One platform-default rule's registry snapshot (the code-side §11.A registry projection). */
export const PlatformRuleSnapshotView = Type.Object({
  ruleKey: Type.String(),
  ruleVersion: Type.Integer(),
  category: Type.String(),
  title: Type.String(),
  description: Type.String(),
  defaultSeverity: ValidationSeverityApi,
  regulatoryRequired: Type.Boolean(),
  defaultOverrideRole: Type.Union([OverrideRoleApi, Type.Null()]),
});
export type PlatformRuleSnapshotView = Static<typeof PlatformRuleSnapshotView>;

/** One tenant overlay row (`validation_rule_config`). */
export const RuleConfigView = Type.Object({
  id: Uuid,
  ruleKey: Type.String(),
  ruleVersion: Type.Integer(),
  isCustom: Type.Boolean(),
  enabled: Type.Boolean(),
  severity: ValidationSeverityApi,
  overrideRoleRequired: OverrideRoleApi,
  parameters: Type.Record(Type.String(), Type.Unknown()),
  regulatoryRequiredSnapshot: Type.Boolean(),
  predicateDsl: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  setReason: Type.Union([Type.String(), Type.Null()]),
  version: Type.Integer(),
  updatedAt: IsoDateTimeSchema,
});
export type RuleConfigView = Static<typeof RuleConfigView>;

export const RuleConfigListResponse = Type.Object({
  platformRules: Type.Array(PlatformRuleSnapshotView),
  overlays: Type.Array(RuleConfigView),
});
export type RuleConfigListResponse = Static<typeof RuleConfigListResponse>;

// ── route #19: PATCH overlay edit (disable / parameterize a platform rule) ──────────────────────────────
export const RuleConfigPatchRequest = Type.Object({
  ifVersion: Type.Integer(),
  enabled: Type.Optional(Type.Boolean()),
  severity: Type.Optional(ValidationSeverityApi),
  overrideRoleRequired: Type.Optional(OverrideRoleApi),
  parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /** ≥20 chars REQUIRED when the edit disables a (non-regulatory) rule (DB CHECK + service floor). */
  setReason: Type.Optional(Type.String({ minLength: 20, maxLength: 2000 })),
});
export type RuleConfigPatchRequest = Static<typeof RuleConfigPatchRequest>;

// ── route #20: create a tenant custom rule ──────────────────────────────────────────────────────────────
export const RuleConfigCustomCreateRequest = Type.Object({
  /** Must be unique within the org; service prefixes/validates `tenant_custom_*`. */
  ruleKey: Type.String({ minLength: 1, maxLength: 128 }),
  category: Type.String({ minLength: 1, maxLength: 64 }),
  severity: ValidationSeverityApi,
  overrideRoleRequired: OverrideRoleApi,
  parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /** The custom-rule predicate (JSON-DSL); validated by the DSL interpreter at the service layer. */
  predicateDsl: Type.Record(Type.String(), Type.Unknown()),
  setReason: Type.String({ minLength: 20, maxLength: 2000 }),
});
export type RuleConfigCustomCreateRequest = Static<typeof RuleConfigCustomCreateRequest>;

// ── shared mutation response (#19 / #20) ────────────────────────────────────────────────────────────────
export const RuleConfigMutationResponse = Type.Object({
  ruleConfigId: Uuid,
  ruleKey: Type.String(),
  version: Type.Integer(),
});
export type RuleConfigMutationResponse = Static<typeof RuleConfigMutationResponse>;

// ── route #21: DELETE overlay (revert to platform default) ──────────────────────────────────────────────
export const RuleConfigDeleteResponse = Type.Object({
  ruleKey: Type.String(),
  reverted: Type.Literal(true),
});
export type RuleConfigDeleteResponse = Static<typeof RuleConfigDeleteResponse>;

// Errors (per §4.2 patterns):
//   403 RULE_REGULATORY_PROTECTED — the rule is regulatory_required; overlay/disable forbidden (D5)
//   409 RULE_OVERLAY_EXISTS       — a custom rule key collides with an existing overlay
//   412 STALE_VERSION            — If-Match / ifVersion mismatch
//   422 DISABLE_REASON_REQUIRED  — disabling a non-regulatory rule needs a ≥20-char reason
