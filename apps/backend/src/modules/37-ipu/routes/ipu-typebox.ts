// apps/backend/src/modules/37-ipu/routes/ipu-typebox.ts — M37 §4.2 request/response DTOs for the T11b core
// route spine (unit list/create, admission list/read/open, bed cleaning-status, census read). PHI-lean:
// ids + enum lifecycle codes + counts. The route layer validates the body against these before the service
// touches Drizzle; the enrichment registry points at the same schemas so openapi.json carries the contract.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";

const id = Type.String({ minLength: 1 });

/** Parse+validate a request body/params against a TypeBox schema, raising a 422 ValidationError on mismatch. */
export function parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    const first = [...Value.Errors(schema, value)][0];
    throw new ValidationError(`Invalid request${first ? ` at '${first.path}': ${first.message}` : ""}`, []);
  }
  return value as Static<T>;
}

// ── units (§4.1 routes 1–2) ──────────────────────────────────────────────────────────────────────────
export const CreateUnitBodySchema = Type.Object({
  facilityId: id,
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  bedCount: Type.Integer({ minimum: 0, maximum: 512 }),
  rnCoverageHorizonHours: Type.Optional(Type.Integer({ minimum: 8, maximum: 168 })),
  turnoverSlaMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
});
export type CreateUnitBody = Static<typeof CreateUnitBodySchema>;

export const UnitViewSchema = Type.Object({
  id,
  facilityId: id,
  displayName: Type.String(),
  bedCount: Type.Integer(),
  isActive: Type.Boolean(),
  rnCoverageHorizonHours: Type.Integer(),
  turnoverSlaMinutes: Type.Integer(),
  version: Type.Integer(),
});
export const UnitListSchema = Type.Object({ items: Type.Array(UnitViewSchema) });

// ── admissions (§4.1 routes 10–12) ───────────────────────────────────────────────────────────────────
export const OpenAdmissionBodySchema = Type.Object({
  patientId: id,
  admissionId: id,
  levelOfCarePeriodId: id,
  providerEntityId: id,
  locationId: Type.Optional(id),
  unitId: Type.Optional(id),
  remoteFacilityId: Type.Optional(id),
  kind: Type.Union([Type.Literal("gip"), Type.Literal("irc"), Type.Literal("arranged")]),
});
export type OpenAdmissionBody = Static<typeof OpenAdmissionBodySchema>;

export const AdmissionViewSchema = Type.Object({
  id,
  patientId: id,
  kind: Type.String(),
  state: Type.String(),
  unitId: Type.Union([id, Type.Null()]),
  remoteFacilityId: Type.Union([id, Type.Null()]),
  openedAt: Type.String(),
  version: Type.Integer(),
});
export const AdmissionListSchema = Type.Object({ items: Type.Array(AdmissionViewSchema) });

// ── bed cleaning-status (§4.1 route 9) ─────────────────────────────────────────────────────────────────
export const BedCleaningBodySchema = Type.Object({
  event: Type.Union([
    Type.Literal("reserve"),
    Type.Literal("occupy"),
    Type.Literal("dischargeDirty"),
    Type.Literal("startCleaning"),
    Type.Literal("completeCleaning"),
    Type.Literal("retire"),
    Type.Literal("expireReservation"),
  ]),
  notes: Type.Optional(Type.String({ maxLength: 1000 })),
});
export type BedCleaningBody = Static<typeof BedCleaningBodySchema>;

export const BedViewSchema = Type.Object({
  id,
  roomId: id,
  unitId: id,
  bedLabel: Type.String(),
  cleaningStatus: Type.String(),
  version: Type.Integer(),
});

// ── census (§4.1 route 38) ───────────────────────────────────────────────────────────────────────────
export const CensusListSchema = Type.Object({
  serviceDate: Type.String(),
  items: Type.Array(
    Type.Object({
      unitId: Type.Union([id, Type.Null()]),
      remoteFacilityId: Type.Union([id, Type.Null()]),
      censusCountGip: Type.Integer(),
      censusCountIrc: Type.Integer(),
      bedDaysGip: Type.Integer(),
      bedDaysIrc: Type.Integer(),
      roomTurnoverCount: Type.Integer(),
      restraintIncidentCount: Type.Integer(),
    }),
  ),
});

export const IdParamsSchema = Type.Object({ id });
export const DateParamsSchema = Type.Object({ date: Type.String({ minLength: 8, maxLength: 10 }) });
