// @chartwarden/billing — platform-admin schemas: route #41 `POST /api/v1/admin/billing/platform-rules`
// (register a new platform rule, with the `regulatory_required` tag) and route #42
// `POST /api/v1/admin/billing/wage-index:load` (trigger the annual wage-index loader against a CMS file
// URI) — §4.1. Platform-only; these write platform-shared reference data (no org scope, no PHI).
import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTimeSchema, OverrideRoleApi, ValidationSeverityApi } from "./common";

// ── route #41: register a platform rule ─────────────────────────────────────────────────────────────────
export const PlatformRuleRegisterRequest = Type.Object({
  ruleKey: Type.String({ minLength: 1, maxLength: 128 }),
  category: Type.String({ minLength: 1, maxLength: 64 }),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  description: Type.String({ minLength: 1, maxLength: 4096 }),
  severity: ValidationSeverityApi,
  regulatoryRequired: Type.Boolean(),
  overrideRoleRequired: Type.Optional(OverrideRoleApi),
  ruleVersion: Type.Integer({ minimum: 1, default: 1 }),
});
export type PlatformRuleRegisterRequest = Static<typeof PlatformRuleRegisterRequest>;

export const PlatformRuleRegisterResponse = Type.Object({
  ruleKey: Type.String(),
  ruleVersion: Type.Integer(),
  registeredAt: IsoDateTimeSchema,
});
export type PlatformRuleRegisterResponse = Static<typeof PlatformRuleRegisterResponse>;

// ── route #42: trigger the annual wage-index loader ─────────────────────────────────────────────────────
export const WageIndexLoadRequest = Type.Object({
  /** The CMS source file URI (e.g. the published hospice wage-index CSV for the FY). */
  cmsFileUri: Type.String({ format: "uri", maxLength: 2048 }),
  /** The fiscal year the file applies to (FY starting calendar year). */
  fiscalYearStarting: Type.Integer({ minimum: 2000, maximum: 2100 }),
});
export type WageIndexLoadRequest = Static<typeof WageIndexLoadRequest>;

export const WageIndexLoadResponse = Type.Object({
  /** The enqueued loader job id (the actual load runs as a P3 worker). */
  jobId: Type.String(),
  fiscalYearStarting: Type.Integer(),
  enqueuedAt: IsoDateTimeSchema,
});
export type WageIndexLoadResponse = Static<typeof WageIndexLoadResponse>;
