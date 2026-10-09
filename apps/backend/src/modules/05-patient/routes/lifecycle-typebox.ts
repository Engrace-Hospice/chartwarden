// apps/backend/src/modules/05-patient/routes/lifecycle-typebox.ts — TypeBox request schemas for the
// GAP-018 / GAP-019 / GAP-012 routes (`lifecycle-routes.ts`). Named `*-typebox` (not `*schema*`) for the
// same table-ownership heuristic reason as `patient-typebox.ts`.
import { Type } from "@sinclair/typebox";

const NullableText = (max: number) => Type.Union([Type.String({ maxLength: max }), Type.Null()]);
const NullableCodes = Type.Union([
  Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 20 }),
  Type.Null(),
]);

/** PATCH /patients/:id — demographics only. `mrn`, `status`, `ssn` are deliberately absent (additional
 *  properties are refused): the MRN is immutable, status moves through `/status`, SSN through the
 *  envelope-encrypted identifier path. */
export const PatchPatientBodySchema = Type.Object(
  {
    legalFirstName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    legalMiddleName: Type.Optional(NullableText(120)),
    legalLastName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    legalNameSuffix: Type.Optional(NullableText(32)),
    dob: Type.Optional(Type.String({ format: "date" })),
    sexAssignedAtBirth: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    genderIdentityCode: Type.Optional(NullableText(64)),
    sexualOrientationCode: Type.Optional(NullableText(64)),
    pronounsCode: Type.Optional(NullableText(64)),
    maritalStatusCode: Type.Optional(NullableText(16)),
    raceCodes: Type.Optional(NullableCodes),
    ethnicityCodes: Type.Optional(NullableCodes),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const StatusBodySchema = Type.Object(
  {
    toStatus: Type.Union([
      Type.Literal("active"),
      Type.Literal("on_hold"),
      Type.Literal("discharged"),
    ]),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { additionalProperties: false },
);

export const DeceasedBodySchema = Type.Object(
  { deceasedDate: Type.String({ format: "date" }) },
  { additionalProperties: false },
);

export const IdentifierBodySchema = Type.Object(
  {
    // `mrn` is refused in the handler (immutable). `ssn` / `state_id` are envelope-encrypted by the handler
    // (GAP-010), behind `phi.write_ssn` + a fresh step-up; their value is never echoed back.
    kind: Type.Union([
      Type.Literal("mbi"),
      Type.Literal("prior_mrn"),
      Type.Literal("hospice_external"),
      Type.Literal("partner_mrn"),
      Type.Literal("ssn"),
      Type.Literal("state_id"),
      Type.Literal("mrn"),
    ]),
    value: Type.String({ minLength: 1, maxLength: 64 }),
    issuer: Type.Optional(NullableText(120)),
    effectiveFrom: Type.Optional(Type.String({ format: "date" })),
  },
  { additionalProperties: false },
);

// POST /api/v1/patients/:id/identifiers/:identifierId/reveal (GAP-010)
export const RevealParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  identifierId: Type.String({ format: "uuid" }),
});

export const CaregiverBodySchema = Type.Object(
  {
    firstName: Type.String({ minLength: 1, maxLength: 120 }),
    lastName: Type.String({ minLength: 1, maxLength: 120 }),
    email: Type.Optional(NullableText(200)),
    phone: Type.Optional(NullableText(32)),
    relationship: Type.Union([
      Type.Literal("spouse"),
      Type.Literal("child"),
      Type.Literal("parent"),
      Type.Literal("sibling"),
      Type.Literal("other_family"),
      Type.Literal("friend"),
      Type.Literal("guardian"),
      Type.Literal("paid_caregiver"),
    ]),
    isPrimary: Type.Optional(Type.Boolean()),
    isLegalRepresentative: Type.Optional(Type.Boolean()),
    lrAuthority: Type.Optional(
      Type.Union([
        Type.Literal("dpoa_healthcare"),
        Type.Literal("guardian"),
        Type.Literal("next_of_kin"),
        Type.Literal("none"),
      ]),
    ),
    lrProofDocRef: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
    portalInvitationConsented: Type.Optional(Type.Boolean()),
    involvementFrom: Type.Optional(Type.String({ format: "date" })),
    notes: Type.Optional(NullableText(1000)),
  },
  { additionalProperties: false },
);

export const MatchQueueQuerySchema = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal("open"),
      Type.Literal("merged"),
      Type.Literal("not_a_match"),
      Type.Literal("cancelled"),
    ]),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const MatchMergeBodySchema = Type.Object(
  {
    fieldResolutions: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object({
          keep: Type.Union([
            Type.Literal("source"),
            Type.Literal("target"),
            Type.Literal("custom"),
          ]),
          customValue: Type.Optional(Type.Unknown()),
        }),
      ),
    ),
    reason: Type.String({ minLength: 10, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

export const NotAMatchBodySchema = Type.Object(
  { reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })) },
  { additionalProperties: false },
);

export const UnmergeBodySchema = Type.Object(
  { reason: Type.String({ minLength: 10, maxLength: 2000 }) },
  { additionalProperties: false },
);

export const AmendmentInboxQuerySchema = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("accepted"),
      Type.Literal("denied"),
      Type.Literal("withdrawn"),
    ]),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const StatementBodySchema = Type.Object(
  { statement: Type.String({ minLength: 1, maxLength: 5000 }) },
  { additionalProperties: false },
);

export const UuidIdParamsSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });
