// apps/backend/src/modules/05-patient/routes/patient-typebox.ts — M5-T09 TypeBox route schemas
// (§4.2, §4.4). Named `patient-typebox` (NOT `*schema*`) so the table-ownership import heuristic
// never mistakes a TypeBox import for a Drizzle one. Validation runs through TypeBox `Value` → M1's
// VALIDATION_FAILED envelope.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import type {
  AdmitResult as ServiceAdmitResult,
  AmendmentView as ServiceAmendmentView,
} from "./service";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set(
    "date",
    (v) => typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)),
  );
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}

const ADDRESS_KINDS = ["home", "facility", "mailing", "temporary", "prior"] as const;

const AddressSchema = Type.Object({
  line1: Type.String({ minLength: 1, maxLength: 200 }),
  line2: Type.Optional(Type.String({ maxLength: 200 })),
  city: Type.String({ minLength: 1, maxLength: 120 }),
  state: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
  postalCode: Type.String({ minLength: 3, maxLength: 12 }),
  kind: Type.Optional(Type.Union(ADDRESS_KINDS.map((k) => Type.Literal(k)))),
  isPrimary: Type.Optional(Type.Boolean()),
});

export const IdParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });
// The slice service uses non-uuid synthetic ids (pat_1); routes accept a loose id param.
export const LooseIdParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});

// POST /api/v1/patients (§4.2 capture contract)
export const AdmitBodySchema = Type.Object({
  lastName: Type.String({ minLength: 1, maxLength: 120 }),
  firstName: Type.String({ minLength: 1, maxLength: 120 }),
  dob: Type.String({ format: "date" }),
  administrativeSex: Type.String({ minLength: 1, maxLength: 16 }),
  mbi: Type.Optional(Type.Union([Type.String({ maxLength: 16 }), Type.Null()])),
  ssn: Type.Optional(Type.Union([Type.String({ maxLength: 16 }), Type.Null()])),
  primaryAddress: Type.Optional(
    Type.Union([
      Type.Object({
        line1: Type.String(),
        city: Type.String(),
        postalCode: Type.String(),
      }),
      Type.Null(),
    ]),
  ),
  phone: Type.Optional(Type.Union([Type.String({ maxLength: 32 }), Type.Null()])),
  email: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  bypassMatchReview: Type.Optional(Type.Boolean()),
});

// POST /api/v1/patients/:id/addresses (§4.2; §7.4 cascade)
export const AddressBodySchema = AddressSchema;

// POST /api/v1/patients/:id/amendments (§4.2; §7.7)
export const AmendmentBodySchema = Type.Object({
  scope: Type.Union([
    Type.Literal("demographic"),
    Type.Literal("clinical"),
    Type.Literal("narrative"),
  ]),
  rationale: Type.String({ minLength: 1, maxLength: 2000 }),
});

// POST /api/v1/amendments/:id/deny
export const DenyBodySchema = Type.Object({
  denialReason: Type.String({ minLength: 1, maxLength: 500 }),
});

// GET /api/v1/patients (§4.2 census/list — cursor-paginated). A patient summary row.
export const PatientSummarySchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  mrn: Type.String(),
  lastName: Type.String(),
  firstName: Type.String(),
  dob: Type.String(),
  status: Type.String(),
});

export const PatientListQuerySchema = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 120 })), // name or MRN substring
  status: Type.Optional(Type.String({ maxLength: 32 })),
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const PatientListResponseSchema = Type.Object({
  items: Type.Array(PatientSummarySchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

// GET /api/v1/patients/census-metrics (§4.2 census KPI strip) — the true active census, org-scoped.
// `total` is the count of all patients in the org; `byStatus` is the count per lifecycle status
// (prospective / active / on_hold / discharged / deceased). Cross-module KPIs the census frame also
// shows (admissions/discharges today, GIP, recerts due) are NOT here — they belong to M6/billing and
// are surfaced as honest placeholders client-side until those reads land.
export const CensusMetricsResponseSchema = Type.Object({
  total: Type.Integer(),
  byStatus: Type.Record(Type.String(), Type.Integer()),
});

// GET /api/v1/patients/:id/demographics (§3.3) — name parts + USCDI SOGI/race/ethnicity codes +
// preferred language + aliases. No encrypted fields (ssn/state_id live on /identifiers, masked).
const NameAliasSchema = Type.Object({
  kind: Type.String(),
  fullName: Type.Union([Type.String(), Type.Null()]),
  firstName: Type.Union([Type.String(), Type.Null()]),
  middleName: Type.Union([Type.String(), Type.Null()]),
  lastName: Type.Union([Type.String(), Type.Null()]),
});

export const PatientDemographicsSchema = Type.Object({
  id: Type.String(),
  mrn: Type.String(),
  legalFirstName: Type.String(),
  legalMiddleName: Type.Union([Type.String(), Type.Null()]),
  legalLastName: Type.String(),
  legalNameSuffix: Type.Union([Type.String(), Type.Null()]),
  dob: Type.String(),
  status: Type.String(),
  sexAssignedAtBirth: Type.String(),
  genderIdentityCode: Type.Union([Type.String(), Type.Null()]),
  sexualOrientationCode: Type.Union([Type.String(), Type.Null()]),
  pronounsCode: Type.Union([Type.String(), Type.Null()]),
  maritalStatusCode: Type.Union([Type.String(), Type.Null()]),
  raceCodes: Type.Array(Type.String()),
  ethnicityCodes: Type.Array(Type.String()),
  preferredLanguageCode: Type.Union([Type.String(), Type.Null()]),
  aliases: Type.Array(NameAliasSchema),
});

// GET /api/v1/patients/:id/identifiers (§3.3/§2.2) — ssn/state_id are `sensitive`: `value` is null,
// only `last4` is returned (the ciphertext is never serialized).
const PatientIdentifierSchema = Type.Object({
  id: Type.String(),
  kind: Type.String(),
  value: Type.Union([Type.String(), Type.Null()]),
  last4: Type.Union([Type.String(), Type.Null()]),
  sensitive: Type.Boolean(),
  issuer: Type.Union([Type.String(), Type.Null()]),
  effectiveFrom: Type.String(),
  effectiveTo: Type.Union([Type.String(), Type.Null()]),
});

export const PatientIdentifiersResponseSchema = Type.Object({
  identifiers: Type.Array(PatientIdentifierSchema),
});

// GET /api/v1/patients/:id/addresses (§3.3, D5 append-only history). `current` (effectiveTo null) rows
// are the live addresses; closed rows are history. At most one `current && isPrimary` per patient.
const PatientAddressSchema = Type.Object({
  id: Type.String(),
  kind: Type.String(),
  line1: Type.String(),
  line2: Type.Union([Type.String(), Type.Null()]),
  city: Type.String(),
  state: Type.Union([Type.String(), Type.Null()]),
  postalCode: Type.String(),
  country: Type.String(),
  county: Type.Union([Type.String(), Type.Null()]),
  isPrimary: Type.Boolean(),
  current: Type.Boolean(),
  effectiveFrom: Type.String(),
  effectiveTo: Type.Union([Type.String(), Type.Null()]),
  geocodeLat: Type.Union([Type.String(), Type.Null()]),
  geocodeLng: Type.Union([Type.String(), Type.Null()]),
});

export const PatientAddressesResponseSchema = Type.Object({
  addresses: Type.Array(PatientAddressSchema),
});

// GET /api/v1/patients/:id/payers (§3.4) — ranked coverages; `payerId` resolves an M40 canonical
// Payer whose display name is fetched client-side via the MDM client (no cross-module schema import).
const PatientPayerSchema = Type.Object({
  id: Type.String(),
  payerId: Type.String(),
  rank: Type.Integer(),
  coverageKind: Type.String(),
  subscriberId: Type.String(),
  groupNumber: Type.Union([Type.String(), Type.Null()]),
  binPcn: Type.Union([Type.String(), Type.Null()]),
  current: Type.Boolean(),
  effectiveFrom: Type.String(),
  effectiveTo: Type.Union([Type.String(), Type.Null()]),
});

export const PatientPayersResponseSchema = Type.Object({
  payers: Type.Array(PatientPayerSchema),
});

export const AddPatientPayerBodySchema = Type.Object({
  payerId: Type.String({ minLength: 1 }),

  rank: Type.Integer({
    minimum: 1,
  }),

  coverageKind: Type.String({
    minLength: 1,
  }),

  subscriberId: Type.String({
    minLength: 1,
  }),

  groupNumber: Type.Optional(
    Type.Union([Type.String(), Type.Null()]),
  ),

  binPcn: Type.Optional(
    Type.Union([Type.String(), Type.Null()]),
  ),

  effectiveFrom: Type.String({
    minLength: 1,
  }),
});

export const AddPatientPayerResponseSchema = PatientPayerSchema;

// GET /api/v1/patients/:id/care-team (§3.4/§3.5) — assignment roster + caregivers + emergency contacts.
// `clinicianUserId` names an M2 user whose display name is resolved client-side via the M2 roster
// (no cross-module schema import); `current` rows render above closed ones.
const PatientAssignmentSchema = Type.Object({
  id: Type.String(),
  clinicianUserId: Type.String(),
  role: Type.String(),
  assignedAt: Type.String(),
  unassignedAt: Type.Union([Type.String(), Type.Null()]),
  current: Type.Boolean(),
});

const PatientCaregiverSchema = Type.Object({
  id: Type.String(),
  caregiverId: Type.String(),
  firstName: Type.String(),
  lastName: Type.String(),
  relationship: Type.String(),
  isPrimary: Type.Boolean(),
  isLegalRepresentative: Type.Boolean(),
  lrAuthority: Type.String(),
  phone: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()]),
  current: Type.Boolean(),
});

const PatientEmergencyContactSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  relationship: Type.String(),
  phone: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  priority: Type.Integer(),
});

export const PatientCareTeamResponseSchema = Type.Object({
  assignments: Type.Array(PatientAssignmentSchema),
  caregivers: Type.Array(PatientCaregiverSchema),
  emergencyContacts: Type.Array(PatientEmergencyContactSchema),
});

// GET /api/v1/patients/:id/privacy-flags (§3.5, D10) — the active privacy RESTRICTIONS from the
// `patient_privacy_flag_snapshot`. A flag present = restricted; `sudDisclosable` is the §7.6 SUD read
// gate, FAIL-CLOSED (a SUD-flagged patient is non-disclosable until a Part-2 consent lifts the flag).
export const PatientPrivacyFlagsResponseSchema = Type.Object({
  flags: Type.Array(Type.String()),
  capturedAt: Type.Union([Type.String(), Type.Null()]),
  sudRestricted: Type.Boolean(),
  sudDisclosable: Type.Boolean(),
});

// ── §4.2 WRITE-ROUTE RESPONSE DTOs (F0 enrichment) ──────────────────────────────────────────────────
// The write routes (`POST /patients`, `.../addresses`, `.../amendments`, `amendments/:id/accept|deny`)
// returned typed service shapes but published NO response contract, so `client:gen` typed those bodies as
// `never`. These DTOs mirror the service return types 1:1 and are pinned by the compile-time `Conforms`
// aliases below — a service view field renamed or a union arm added breaks `bun run build` rather than
// silently drifting the generated client.

// POST /api/v1/patients — the §7.1 admit outcome the route returns on 201 (`hard_block` is thrown as a
// 409, never a success body, so the response union is `created | soft_review` only).
export const AdmitResultResponseSchema = Type.Union([
  Type.Object({
    outcome: Type.Literal("created"),
    patientId: Type.String(),
  }),
  Type.Object({
    outcome: Type.Literal("soft_review"),
    patientId: Type.String(),
    matchReviewIds: Type.Array(Type.String()),
  }),
]);

// POST /api/v1/patients/:id/addresses — the §7.4 append-address ack + the cascade event it emitted.
export const AddAddressResponseSchema = Type.Object({
  addressId: Type.String(),
  cascadeEmitted: Type.Literal("m5.patient.address_changed"),
});

// POST /api/v1/patients/:id/amendments + amendments/:id/accept|deny — the §7.7 amendment record view.
export const AmendmentResponseSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("accepted"),
    Type.Literal("denied"),
    Type.Literal("withdrawn"),
  ]),
  slaDueAt: Type.String(),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _AdmitResult = Conforms<Static<typeof AdmitResultResponseSchema>, ServiceAdmitResult>;
type _AddAddress = Conforms<
  Static<typeof AddAddressResponseSchema>,
  { readonly addressId: string; readonly cascadeEmitted: "m5.patient.address_changed" }
>;
type _Amendment = Conforms<Static<typeof AmendmentResponseSchema>, ServiceAmendmentView>;

export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    const first = [...Value.Errors(schema, converted)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}
