// apps/backend/src/modules/02-identity/routes/org-admin-typebox.ts — OpenAPI request/response contracts for the
// GAP-115 org-admin routes (organizations, provider entities, locations, step-up overrides, /me/session, the
// funeral-home link). Named `*-typebox` so the table-ownership import heuristic never mistakes it for a Drizzle
// import. The runtime validators are `org-admin-validation.ts` / `step-up-override-admin.ts`; these PUBLISH the
// same shapes so the generated client can express every call (a route with no published body types it `never`).
import { type TSchema, Type } from "@sinclair/typebox";

const Lifecycle = Type.Union([
  Type.Literal("created"),
  Type.Literal("active"),
  Type.Literal("suspended"),
  Type.Literal("closed"),
]);
const Iso = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);

// ── organizations ────────────────────────────────────────────────────────────────────────────────
export const OrganizationViewSchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  legalName: Type.String(),
  displayName: Type.String(),
  status: Type.String(),
  createdAt: Iso,
  updatedAt: Iso,
});

export const OrganizationListResponseSchema = Type.Object({
  items: Type.Array(OrganizationViewSchema),
  nextCursor: Nullable(Type.String()),
});

export const OrganizationCreateRequestSchema = Type.Object({
  legalName: Type.String({ minLength: 1, maxLength: 200 }),
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  slug: Type.Optional(
    Type.String({
      description:
        "3-40 lower-case letters, digits or hyphens; derived from legalName when absent.",
    }),
  ),
});

export const OrganizationPatchRequestSchema = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  legalName: Type.Optional(
    Type.String({ minLength: 1, maxLength: 200, description: "Platform operators only." }),
  ),
});

// ── provider entities ────────────────────────────────────────────────────────────────────────────
export const ProviderEntityDetailSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  ccn: Type.String(),
  legalName: Type.String(),
  doingBusinessAs: Nullable(Type.String()),
  fiscalIntermediary: Nullable(Type.String()),
  npi: Type.String(),
  fiscalYearEnd: Type.String({ description: "MMDD" }),
  iqiesFacilityId: Nullable(Type.String()),
  billingAddress: Nullable(
    Type.Object({
      line1: Type.String(),
      line2: Nullable(Type.String()),
      city: Type.String(),
      state: Type.String(),
      postalCode: Type.String(),
    }),
  ),
  status: Lifecycle,
  createdAt: Iso,
  updatedAt: Iso,
});

export const ProviderEntityCreateRequestSchema = Type.Object({
  ccn: Type.String({ pattern: "^[0-9A-Z]{6}$", description: "CMS Certification Number." }),
  npi: Type.String({
    pattern: "^[0-9]{10}$",
    description: "10 digits with a correct NPI check digit.",
  }),
  legalName: Type.String({ minLength: 1, maxLength: 200 }),
  doingBusinessAs: Type.Optional(Type.String({ maxLength: 200 })),
  fiscalIntermediary: Type.Optional(Type.String({ maxLength: 200 })),
  taxId: Type.String({
    description:
      "9-digit EIN (12-3456789). Write-once: enveloped by the KMS cipher, never returned. 503 TAX_ID_CIPHER_UNBOUND until that cipher is bound.",
  }),
  fiscalYearEnd: Type.String({ pattern: "^[0-9]{4}$", description: "MMDD" }),
  iqiesFacilityId: Type.Optional(Type.String({ maxLength: 50 })),
});

export const ProviderEntityPatchRequestSchema = Type.Object({
  legalName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  doingBusinessAs: Type.Optional(Type.String({ maxLength: 200 })),
  fiscalIntermediary: Type.Optional(Type.String({ maxLength: 200 })),
  iqiesFacilityId: Type.Optional(Type.String({ maxLength: 50 })),
  billingAddress: Type.Optional(
    Type.Object(
      {
        line1: Type.String({ minLength: 1, maxLength: 55 }),
        line2: Type.Optional(Type.String({ maxLength: 55 })),
        city: Type.String({ minLength: 1, maxLength: 30 }),
        state: Type.String({ pattern: "^[A-Z]{2}$" }),
        postalCode: Type.String({ pattern: "^\\d{5}(-\\d{4})?$" }),
      },
      {
        description:
          "The billing address printed on the 837I billing-provider loop (2010AA). Replaces the first stored address.",
      },
    ),
  ),
  status: Type.Optional(Lifecycle),
});

// ── locations ────────────────────────────────────────────────────────────────────────────────────
export const LocationDetailSchema = Type.Object({
  id: Type.String(),
  providerEntityId: Type.String(),
  name: Type.String(),
  addressLine1: Type.String(),
  addressLine2: Nullable(Type.String()),
  city: Type.String(),
  state: Type.String(),
  postalCode: Type.String(),
  phone: Nullable(Type.String()),
  fax: Nullable(Type.String()),
  timezone: Type.String(),
  status: Lifecycle,
  createdAt: Iso,
  updatedAt: Iso,
});

const LocationFields = {
  name: Type.String({ minLength: 1, maxLength: 200 }),
  addressLine1: Type.String({ minLength: 1, maxLength: 200 }),
  addressLine2: Type.Optional(Type.String({ maxLength: 200 })),
  city: Type.String({ minLength: 1, maxLength: 100 }),
  state: Type.String({ pattern: "^[A-Z]{2}$" }),
  postalCode: Type.String({ pattern: "^\\d{5}(-\\d{4})?$" }),
  phone: Type.Optional(Type.String({ maxLength: 30 })),
  fax: Type.Optional(Type.String({ maxLength: 30 })),
  timezone: Type.String({ description: "IANA zone, e.g. America/Los_Angeles." }),
};

export const LocationCreateRequestSchema = Type.Object({
  providerEntityId: Type.String({ minLength: 1 }),
  ...LocationFields,
});

export const LocationPatchRequestSchema = Type.Partial(
  Type.Object({ ...LocationFields, status: Lifecycle }),
);

// ── step-up overrides ────────────────────────────────────────────────────────────────────────────
export const StepUpOverrideSchema = Type.Object({
  operationKey: Type.String(),
  qualifyingFactors: Type.Array(Type.Union([Type.Literal("webauthn"), Type.Literal("totp")])),
  maxAgeSec: Type.Integer({ minimum: 1, maximum: 300 }),
  rationale: Type.String(),
  configuredByMembershipId: Type.String(),
  configuredAt: Iso,
});

export const StepUpOverrideListResponseSchema = Type.Object({
  overrides: Type.Array(StepUpOverrideSchema),
});

export const StepUpOverrideRequestSchema = Type.Object({
  operationKey: Type.String({ pattern: "^[a-z][a-z0-9_.]{0,99}$" }),
  qualifyingFactors: Type.Array(Type.Union([Type.Literal("webauthn"), Type.Literal("totp")]), {
    minItems: 1,
    description:
      "A non-empty subset of the platform floor [webauthn, totp]. SMS is refused (a loosening).",
  }),
  maxAgeSec: Type.Integer({
    minimum: 1,
    maximum: 300,
    description:
      "At most the platform floor's 300s: a tenant may only shorten the freshness window.",
  }),
  rationale: Type.String({ minLength: 10, maxLength: 2000 }),
});

export const StepUpOverrideRemovedResponseSchema = Type.Object({ removed: Type.Boolean() });

// ── /me/session + funeral ────────────────────────────────────────────────────────────────────────
export const MeSessionResponseSchema = Type.Object({
  sessionId: Type.String(),
  userId: Type.String(),
  organizationId: Type.String(),
  lastStepUpAt: Nullable(Iso),
  lastStepUpFactor: Nullable(
    Type.Union([Type.Literal("webauthn"), Type.Literal("totp"), Type.Literal("sms")]),
  ),
  stepUpStatus: Type.Union([Type.Literal("none"), Type.Literal("fresh"), Type.Literal("expired")]),
  stepUpExpiresAt: Nullable(Iso),
  stepUpSecondsRemaining: Type.Integer({ minimum: 0 }),
});

export const FuneralInviteRequestSchema = Type.Object({
  patientId: Type.String({ minLength: 1 }),
  /**
   * Where the one-time link is emailed. REQUIRED on a durable deployment (422 without it): the token is never returned in a
   * response, so a link with no recipient could never be redeemed. Refused 503 `LINK_DELIVERY_UNAVAILABLE` while the
   * transactional email provider is unbound.
   */
  recipientEmail: Type.Optional(Type.String({ maxLength: 254 })),
});
export const FuneralInviteResponseSchema = Type.Object({
  linkId: Type.String(),
  expiresAt: Type.String(),
});

/** GET /api/v1/funeral/case - the MINIMUM decedent facts a redeemed funeral-home session reads (legal name, date of death). */
export const FuneralCaseResponseSchema = Type.Object({
  patientId: Type.String(),
  decedentName: Type.String(),
  dateOfDeath: Type.String(),
});
