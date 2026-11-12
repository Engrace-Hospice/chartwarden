// Slice 7 wave 0 - the help-request wire contract: request bodies, queries and the two response views.
// The PHI-shaped message is NOT screened here (the service does that, piece 7B); these prove the shape only.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  ApproveHelpRequestRequest,
  FileHelpRequestRequest,
  HELP_REQUEST_PHASES,
  HELP_REQUEST_STATUSES,
  HelpRequestParamsSchema,
  HelpRequestViewSchema,
  PlatformHelpRequestListQuerySchema,
  PlatformHelpRequestListResponseSchema,
  PlatformHelpRequestViewSchema,
  ResolveHelpRequestRequest,
  TenantHelpRequestListQuerySchema,
  TenantHelpRequestListResponseSchema,
} from "../routes/help-request-typebox";

const ID = "70000000-0000-4000-8000-000000000001";
const AT = "2026-11-09T12:00:00.000Z";

const sessionSummary = {
  state: "open",
  startedAt: AT,
  expiresAt: "2026-11-09T20:00:00.000Z",
  closedAt: null,
  closeReason: null,
  actionCount: 2,
  lastActionAt: AT,
} as const;

const tenantView = {
  id: ID,
  stepKey: "mac_configured",
  message: "We cannot find our MAC enrolment letter",
  status: "approved",
  phase: "in_session",
  requestedAt: AT,
  approvedAt: AT,
  grant: { expiresAt: "2026-11-09T20:00:00.000Z", status: "active" },
  session: sessionSummary,
  closedAt: null,
  closedBy: null,
  closeNote: null,
} as const;

const platformView = {
  id: ID,
  tenantAccountId: "70000000-0000-4000-8000-0000000000aa",
  orgSlug: "acme",
  legalBusinessName: "Acme Hospice",
  stepKey: null,
  message: "Where do we enter the payer list?",
  status: "open",
  phase: "waiting_for_consent",
  requestedAt: AT,
  requestedByMembershipId: "70000000-0000-4000-8000-0000000000bb",
  approvedAt: null,
  supportConsentGrantId: null,
  grant: null,
  session: null,
  closedAt: null,
  closedByActorKind: null,
  closeNote: null,
} as const;

describe("help-request bodies", () => {
  it("accepts a file request with and without a step key", () => {
    expect(Value.Check(FileHelpRequestRequest, { message: "I need help here" })).toBe(true);
    expect(
      Value.Check(FileHelpRequestRequest, { stepKey: "payer_enrollment", message: "I need help" }),
    ).toBe(true);
  });

  it("refuses a message shorter than 8 or longer than 1000 characters, and an empty step key", () => {
    expect(Value.Check(FileHelpRequestRequest, { message: "short" })).toBe(false);
    expect(Value.Check(FileHelpRequestRequest, { message: "x".repeat(1001) })).toBe(false);
    expect(Value.Check(FileHelpRequestRequest, { stepKey: "", message: "long enough" })).toBe(
      false,
    );
    expect(
      Value.Check(FileHelpRequestRequest, { stepKey: "k".repeat(65), message: "long enough" }),
    ).toBe(false);
    expect(Value.Check(FileHelpRequestRequest, {})).toBe(false);
  });

  it("approve takes whole hours 1 to 24 and the field is optional (the default is the service's)", () => {
    expect(Value.Check(ApproveHelpRequestRequest, {})).toBe(true);
    expect(Value.Check(ApproveHelpRequestRequest, { hours: 8 })).toBe(true);
    expect(Value.Check(ApproveHelpRequestRequest, { hours: 24 })).toBe(true);
    expect(Value.Check(ApproveHelpRequestRequest, { hours: 0 })).toBe(false);
    expect(Value.Check(ApproveHelpRequestRequest, { hours: 25 })).toBe(false);
    expect(Value.Check(ApproveHelpRequestRequest, { hours: 1.5 })).toBe(false);
  });

  it("resolve needs a note of 8 to 500 characters", () => {
    expect(Value.Check(ResolveHelpRequestRequest, { note: "Walked them through it" })).toBe(true);
    expect(Value.Check(ResolveHelpRequestRequest, { note: "short" })).toBe(false);
    expect(Value.Check(ResolveHelpRequestRequest, { note: "n".repeat(501) })).toBe(false);
    expect(Value.Check(ResolveHelpRequestRequest, {})).toBe(false);
  });

  it("takes a uuid id in the path", () => {
    expect(Value.Check(HelpRequestParamsSchema, { id: ID })).toBe(true);
    expect(Value.Check(HelpRequestParamsSchema, { id: "not-a-uuid" })).toBe(false);
  });
});

describe("help-request queries", () => {
  it("the platform inbox filters by a comma-separated status list and a tenant account", () => {
    expect(Value.Check(PlatformHelpRequestListQuerySchema, {})).toBe(true);
    expect(
      Value.Check(PlatformHelpRequestListQuerySchema, { status: "open,approved", limit: 1 }),
    ).toBe(true);
    expect(Value.Check(PlatformHelpRequestListQuerySchema, { tenantAccountId: ID })).toBe(true);
    expect(Value.Check(PlatformHelpRequestListQuerySchema, { status: "open,bogus" })).toBe(false);
    expect(Value.Check(PlatformHelpRequestListQuerySchema, { status: "open," })).toBe(false);
  });

  it("the tenant list pages its history by cursor and limit", () => {
    expect(Value.Check(TenantHelpRequestListQuerySchema, {})).toBe(true);
    expect(Value.Check(TenantHelpRequestListQuerySchema, { limit: 25, cursor: "abc" })).toBe(true);
    expect(Value.Check(TenantHelpRequestListQuerySchema, { limit: 0 })).toBe(false);
  });

  it("names the four statuses and the four phases the screens switch on", () => {
    expect([...HELP_REQUEST_STATUSES]).toEqual(["open", "approved", "resolved", "cancelled"]);
    expect([...HELP_REQUEST_PHASES]).toEqual([
      "waiting_for_consent",
      "ready_to_start",
      "in_session",
      "ended",
    ]);
  });
});

describe("help-request views", () => {
  it("the tenant view accepts a live request and an ended one", () => {
    expect(Value.Check(HelpRequestViewSchema, tenantView)).toBe(true);
    expect(
      Value.Check(HelpRequestViewSchema, {
        ...tenantView,
        status: "resolved",
        phase: "ended",
        session: { ...sessionSummary, state: "closed", closedAt: AT, closeReason: "grant_revoked" },
        closedAt: AT,
        closedBy: "ChartWarden operations",
        closeNote: "Walked them through it",
      }),
    ).toBe(true);
  });

  it("the tenant view accepts the open request that has no grant and no session yet", () => {
    expect(
      Value.Check(HelpRequestViewSchema, {
        ...tenantView,
        stepKey: null,
        status: "open",
        phase: "waiting_for_consent",
        approvedAt: null,
        grant: null,
        session: null,
      }),
    ).toBe(true);
  });

  it("the tenant view never carries an operator id: closedBy is a label, not an id", () => {
    expect(
      Value.Check(HelpRequestViewSchema, {
        ...tenantView,
        closedBy: "70000000-0000-4000-8000-0000000000bb",
      }),
    ).toBe(false);
    expect(Object.keys(HelpRequestViewSchema.properties)).not.toContain("actorMembershipId");
    expect(
      Object.keys(HelpRequestViewSchema.properties.session.anyOf[0]?.properties ?? {}),
    ).not.toContain("actorMembershipId");
  });

  it("refuses an unknown status, phase or close reason", () => {
    expect(Value.Check(HelpRequestViewSchema, { ...tenantView, status: "done" })).toBe(false);
    expect(Value.Check(HelpRequestViewSchema, { ...tenantView, phase: "waiting" })).toBe(false);
    expect(
      Value.Check(HelpRequestViewSchema, {
        ...tenantView,
        session: { ...sessionSummary, closeReason: "whenever" },
      }),
    ).toBe(false);
  });

  it("the platform row carries the tenant, the grant to start against and the session id", () => {
    expect(Value.Check(PlatformHelpRequestViewSchema, platformView)).toBe(true);
    expect(
      Value.Check(PlatformHelpRequestViewSchema, {
        ...platformView,
        status: "approved",
        phase: "ready_to_start",
        approvedAt: AT,
        supportConsentGrantId: "70000000-0000-4000-8000-0000000000cc",
        grant: { expiresAt: "2026-11-09T20:00:00.000Z", status: "active" },
        session: { ...sessionSummary, sessionId: "70000000-0000-4000-8000-0000000000dd" },
      }),
    ).toBe(true);
    expect(
      Value.Check(PlatformHelpRequestViewSchema, { ...platformView, orgSlug: undefined }),
    ).toBe(false);
  });

  it("wraps both views in the list envelopes the screens read", () => {
    expect(
      Value.Check(TenantHelpRequestListResponseSchema, {
        current: tenantView,
        items: [],
        nextCursor: null,
        hasMore: false,
      }),
    ).toBe(true);
    expect(
      Value.Check(TenantHelpRequestListResponseSchema, {
        current: null,
        items: [tenantView],
        nextCursor: "next",
        hasMore: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(PlatformHelpRequestListResponseSchema, {
        items: [platformView],
        nextCursor: null,
        hasMore: false,
      }),
    ).toBe(true);
    expect(Value.Check(PlatformHelpRequestListResponseSchema, { items: [platformView] })).toBe(
      false,
    );
  });
});
