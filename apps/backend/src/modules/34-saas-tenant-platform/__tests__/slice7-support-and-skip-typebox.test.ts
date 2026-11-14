// Slice 7 wave 0 - the support-session read contracts, the `assist` grant scope, the tenant skip body and the step view's
// additive fields, plus the failure codes the slice adds. Shape only: no service is exercised.
import {
  M34_SUPPORT_SESSION_ERROR_STATUS,
  SupportSessionError,
} from "@chartwarden/saas-tenant-platform";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { HelpRequestError, M34_HELP_REQUEST_ERROR_STATUS } from "../help/help-request-errors";
import { WizardStepViewSchema } from "../routes/onboarding-wizard-typebox";
import {
  PlatformSupportConsentGrantListQuerySchema,
  PlatformSupportConsentGrantListResponseSchema,
  PlatformSupportConsentGrantViewSchema,
} from "../routes/platform/platform-typebox";
import {
  SupportConsentGrantRequest,
  SupportConsentGrantViewSchema,
  TenantSupportSessionEventListResponseSchema,
  TenantSupportSessionListQuerySchema,
  TenantSupportSessionListResponseSchema,
  TenantSupportSessionParamsSchema,
} from "../routes/tenant/tenant-typebox";
import { SkipOnboardingTaskRequest } from "../routes/typebox";

const ID = "80000000-0000-4000-8000-000000000001";
const AT = "2026-11-09T12:00:00.000Z";

describe("grant issue request: the assist scope", () => {
  const body = {
    grantReason: "help request 80000000-0000-4000-8000-000000000001",
    expiresAtIsoOffsetHours: 8,
  };

  it("accepts assist beside the two existing scopes", () => {
    for (const scope of ["organization_scoped", "assist"]) {
      expect(Value.Check(SupportConsentGrantRequest, { ...body, scope })).toBe(true);
    }
    expect(
      Value.Check(SupportConsentGrantRequest, {
        ...body,
        scope: "patient_scoped",
        patientIdsInScope: [ID],
      }),
    ).toBe(true);
  });

  it("refuses an unknown scope", () => {
    expect(Value.Check(SupportConsentGrantRequest, { ...body, scope: "everything" })).toBe(false);
  });

  it("the grant view reports assist too", () => {
    const view = {
      id: ID,
      tenantAccountId: ID,
      scope: "assist",
      grantReason: "help request",
      issuedAt: AT,
      expiresAt: AT,
      revokedAt: null,
      active: true,
      createdAt: AT,
    };
    expect(Value.Check(SupportConsentGrantViewSchema, view)).toBe(true);
  });
});

describe("tenant support-session reads", () => {
  const session = {
    id: ID,
    supportConsentGrantId: ID,
    state: "closed",
    startedAt: AT,
    expiresAt: AT,
    closedAt: AT,
    closeReason: "grant_revoked",
    actionCount: 3,
    lastActionAt: AT,
  };
  const event = {
    id: ID,
    supportSessionId: ID,
    eventKind: "ops.write",
    occurredAt: AT,
    detail: {
      route: "/api/v1/platform/tenants/:orgSlug/org-profile",
      method: "PATCH",
      status: 200,
    },
  };

  it("lists sessions without an operator id", () => {
    const page = { items: [session], nextCursor: null, hasMore: false };
    expect(Value.Check(TenantSupportSessionListResponseSchema, page)).toBe(true);
    expect(
      Value.Check(TenantSupportSessionListResponseSchema, {
        items: [{ ...session, state: "paused" }],
        nextCursor: null,
        hasMore: false,
      }),
    ).toBe(false);
    expect(
      Object.keys(TenantSupportSessionListResponseSchema.properties.items.items.properties),
    ).not.toContain("actorMembershipId");
  });

  it("lists ledger events, a lifecycle row having no route detail and never an operator ip", () => {
    const page = {
      items: [event, { ...event, eventKind: "session.start", detail: null }],
      nextCursor: "next",
      hasMore: true,
    };
    expect(Value.Check(TenantSupportSessionEventListResponseSchema, page)).toBe(true);
    const props = Object.keys(
      TenantSupportSessionEventListResponseSchema.properties.items.items.properties,
    );
    expect(props).not.toContain("actorIp");
    expect(props).not.toContain("actorMembershipId");
  });

  it("takes the page query and a uuid session id", () => {
    expect(Value.Check(TenantSupportSessionListQuerySchema, { limit: 10 })).toBe(true);
    expect(Value.Check(TenantSupportSessionListQuerySchema, { limit: 0 })).toBe(false);
    expect(Value.Check(TenantSupportSessionParamsSchema, { id: ID })).toBe(true);
    expect(Value.Check(TenantSupportSessionParamsSchema, { id: "x" })).toBe(false);
  });
});

describe("platform support-consent-grant list", () => {
  const grant = {
    id: ID,
    tenantAccountId: ID,
    scope: "assist",
    grantReason: "help request 80000000-0000-4000-8000-000000000001",
    issuedAt: AT,
    expiresAt: AT,
    revokedAt: null,
    active: true,
  };

  it("takes a tenant account and an active flag", () => {
    expect(Value.Check(PlatformSupportConsentGrantListQuerySchema, {})).toBe(true);
    expect(
      Value.Check(PlatformSupportConsentGrantListQuerySchema, {
        tenantAccountId: ID,
        active: true,
      }),
    ).toBe(true);
    expect(Value.Check(PlatformSupportConsentGrantListQuerySchema, { tenantAccountId: "x" })).toBe(
      false,
    );
  });

  it("returns grants with their scope and state", () => {
    expect(Value.Check(PlatformSupportConsentGrantViewSchema, grant)).toBe(true);
    expect(
      Value.Check(PlatformSupportConsentGrantListResponseSchema, {
        items: [grant],
        nextCursor: null,
        hasMore: false,
      }),
    ).toBe(true);
    expect(Value.Check(PlatformSupportConsentGrantViewSchema, { ...grant, scope: "all" })).toBe(
      false,
    );
  });
});

describe("tenant skip and the step view", () => {
  it("reuses the operator's skip body: a rationale of 8 to 2000 characters", () => {
    expect(
      Value.Check(SkipOnboardingTaskRequest, { skipRationale: "We bill outside the system" }),
    ).toBe(true);
    expect(Value.Check(SkipOnboardingTaskRequest, { skipRationale: "short" })).toBe(false);
  });

  it("adds skippedBy, skippedByLabel and tenantSkippable to the step view and keeps systemSkipped", () => {
    const properties = Object.keys(WizardStepViewSchema.properties);
    expect(properties).toEqual(
      expect.arrayContaining(["skippedBy", "skippedByLabel", "tenantSkippable", "systemSkipped"]),
    );
    for (const skippedBy of ["system", "tenant", "platform_ops", null]) {
      const step = {
        id: null,
        key: "mac_configured",
        title: "t",
        description: "d",
        owner: "either",
        sequence: 8,
        optional: false,
        status: "skipped",
        locked: false,
        lockedBy: null,
        completionMode: "attestation",
        evidence: null,
        attestedBy: null,
        assignedToMembershipId: null,
        dueAt: null,
        startedAt: null,
        completedAt: null,
        blockerReason: null,
        skipRationale: "does not apply",
        systemSkipped: skippedBy === "system",
        skippedBy,
        skippedByLabel: skippedBy === "tenant" ? "Your organization" : null,
        skippable: true,
        tenantSkippable: true,
        createdAt: null,
        templateKey: "mac_configured",
        isCanonical: true,
        canonicalOrder: 8,
      };
      expect(Value.Check(WizardStepViewSchema, step)).toBe(true);
      expect(Value.Check(WizardStepViewSchema, { ...step, skippedBy: "operator" })).toBe(false);
      expect(Value.Check(WizardStepViewSchema, { ...step, skippedByLabel: undefined })).toBe(false);
    }
  });
});

describe("failure codes", () => {
  it("answers the four support codes with their status", () => {
    expect(M34_SUPPORT_SESSION_ERROR_STATUS.SUPPORT_SESSION_NON_PHI).toBe(403);
    expect(M34_SUPPORT_SESSION_ERROR_STATUS.SUPPORT_GRANT_SCOPE_NOT_ALLOWED).toBe(403);
    expect(M34_SUPPORT_SESSION_ERROR_STATUS.SUPPORT_GRANT_INACTIVE).toBe(409);
    const error = new SupportSessionError(
      "SUPPORT_SESSION_NON_PHI",
      "an assist session has no PHI",
    );
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe("SUPPORT_SESSION_NON_PHI");
  });

  it("answers a second live help request with 409 carrying the live one's id", () => {
    expect(M34_HELP_REQUEST_ERROR_STATUS.HELP_REQUEST_ALREADY_OPEN).toBe(409);
    const error = new HelpRequestError(
      "HELP_REQUEST_ALREADY_OPEN",
      "a help request is already open",
      [{ field: "helpRequestId", code: "HELP_REQUEST_ALREADY_OPEN", message: ID }],
    );
    expect(error.statusCode).toBe(409);
    expect(error.details?.[0]?.message).toBe(ID);
  });
});
