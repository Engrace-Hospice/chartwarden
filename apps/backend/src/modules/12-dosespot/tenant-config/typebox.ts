// apps/backend/src/modules/12-dosespot/tenant-config/typebox.ts — request and response contracts of the tenant DoseSpot routes
// (`/api/v1/tenant/dosespot`, and the platform copy under `/api/v1/platform/tenants/:orgSlug/dosespot`). Named `*-typebox` so the
// table-ownership heuristic never reads it as a Drizzle import. The credential exists only in a request; no response schema has
// a field for it.
import { type Static, type TSchema, Type } from "@sinclair/typebox";

const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const Iso = Type.String({ format: "date-time" });

export const DoseSpotEnvironmentSchema = Type.Union([
  Type.Literal("sandbox"),
  Type.Literal("production"),
]);
export const ProbeOutcomeSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("credential_rejected"),
  Type.Literal("unreachable"),
]);

export const PutClinicBodySchema = Type.Object(
  {
    environment: Type.Union([Type.Literal("sandbox"), Type.Literal("production")], {
      description:
        "Which DoseSpot environment the clinic lives in. A name, never a URL: the host is platform configuration. Production is available only when the platform has enabled it.",
    }),
    clinicId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description:
          "The clinic id DoseSpot issued (1-64 letters, digits, dots, dashes or underscores).",
      }),
    ),
    serviceClinicianId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 64,
        description:
          "The DoseSpot clinician the service token is minted for (patient sync, history, status polling).",
      }),
    ),
    clinicKey: Type.Optional(
      Type.String({
        minLength: 8,
        maxLength: 512,
        description:
          "The clinic key DoseSpot issued. Write-only: it is sealed under the tenant's own key and never returned. Omit it to keep the stored one.",
      }),
    ),
    subscriptionKey: Type.Optional(
      Type.String({
        minLength: 8,
        maxLength: 512,
        description:
          "The DoseSpot Subscription-Key, when the clinic has its own. Write-only. Platform support may set it; a tenant administrator may only rotate one that platform support set.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type PutClinicBody = Static<typeof PutClinicBodySchema>;

export const ClinicConfigViewSchema = Type.Object({
  source: Type.Union([Type.Literal("tenant"), Type.Literal("platform_env"), Type.Literal("none")]),
  status: Nullable(
    Type.Union([
      Type.Literal("draft"),
      Type.Literal("registered"),
      Type.Literal("verified"),
      Type.Literal("active"),
    ]),
  ),
  environment: Nullable(DoseSpotEnvironmentSchema),
  clinicId: Nullable(Type.String()),
  serviceClinicianId: Nullable(Type.String()),
  hasSecret: Type.Boolean(),
  live: Type.Boolean({
    description:
      "Whether the registration is actually served on this deployment: active, and its environment allowed (a sandbox row needs the platform to enable sandbox). `status` alone says what the row was left in.",
  }),
  notLiveReason: Nullable(
    Type.Union([Type.Literal("sandbox_not_enabled"), Type.Literal("environment_unavailable")], {
      description:
        "Why an `active` row is not live: the platform has not enabled sandbox, or the environment has no usable host or flag here. Null when live, or never activated.",
    }),
  ),
  registeredAt: Nullable(Iso),
  verifiedAt: Nullable(Iso),
  activatedAt: Nullable(Iso),
  lastTest: Type.Union([Type.Object({ outcome: ProbeOutcomeSchema, at: Iso }), Type.Null()]),
  prescribersEnrolled: Type.Integer({
    description:
      "Roster prescribers already linked to DoseSpot. A fact for the screen; it does not gate activation.",
  }),
  queuedTransmissions: Type.Integer({
    description:
      "Signed orders waiting to transmit; they pause while the registration is not active.",
  }),
  version: Nullable(Type.Integer()),
  updatedAt: Nullable(Iso),
});

export const VerifyClinicResponseSchema = Type.Object({
  config: ClinicConfigViewSchema,
  test: Type.Object({ outcome: ProbeOutcomeSchema }),
});

/**
 * Enrolment takes NO identity from the caller: the NPI and the legal name come from the physician record the roster links the member to
 * (practitioner-profile.ts). The body is empty, and `additionalProperties: false` makes a typed `npi`, `firstName` or `lastName` a 422.
 */
export const EnrollPrescriberVendorBodySchema = Type.Object({}, { additionalProperties: false });
export type EnrollPrescriberVendorBody = Static<typeof EnrollPrescriberVendorBodySchema>;

export const PrescriberVendorEnrollmentViewSchema = Type.Object({
  membershipId: Type.String(),
  enrolledWithDoseSpot: Type.Literal(true),
});
