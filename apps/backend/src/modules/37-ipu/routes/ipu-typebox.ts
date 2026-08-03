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

// ── unit update / rooms / beds (§4.1 routes 3–8) ───────────────────────────────────────────────────────
export const UpdateUnitBodySchema = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  rnCoverageHorizonHours: Type.Optional(Type.Integer({ minimum: 8, maximum: 168 })),
  turnoverSlaMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
  gipReassessmentIntervalHours: Type.Optional(Type.Integer({ minimum: 4, maximum: 24 })),
  ircCapOverrideMaxDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
});
export type UpdateUnitBody = Static<typeof UpdateUnitBodySchema>;

const roomKind = Type.Union([
  Type.Literal("private"),
  Type.Literal("semi_private"),
  Type.Literal("family"),
  Type.Literal("shared_overflow"),
]);
export const CreateRoomBodySchema = Type.Object({
  roomNumber: Type.String({ minLength: 1, maxLength: 40 }),
  kind: roomKind,
  bedCount: Type.Integer({ minimum: 0, maximum: 16 }),
  hasWindow: Type.Optional(Type.Boolean()),
  hasPrivateBathroom: Type.Optional(Type.Boolean()),
  familyAmenitiesPresent: Type.Optional(Type.Boolean()),
});
export type CreateRoomBody = Static<typeof CreateRoomBodySchema>;
export const UpdateRoomBodySchema = Type.Object({
  roomNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  kind: Type.Optional(roomKind),
  hasWindow: Type.Optional(Type.Boolean()),
  hasPrivateBathroom: Type.Optional(Type.Boolean()),
  familyAmenitiesPresent: Type.Optional(Type.Boolean()),
  isActive: Type.Optional(Type.Boolean()),
});
export type UpdateRoomBody = Static<typeof UpdateRoomBodySchema>;
export const RoomViewSchema = Type.Object({
  id,
  unitId: id,
  roomNumber: Type.String(),
  kind: Type.String(),
  bedCount: Type.Integer(),
  isActive: Type.Boolean(),
  version: Type.Integer(),
});
export const RoomListSchema = Type.Object({ items: Type.Array(RoomViewSchema) });

export const CreateBedBodySchema = Type.Object({
  bedLabel: Type.String({ minLength: 1, maxLength: 40 }),
  geofenceLat: Type.Optional(Type.Number()),
  geofenceLon: Type.Optional(Type.Number()),
  geofenceRadiusMeters: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
});
export type CreateBedBody = Static<typeof CreateBedBodySchema>;
export const UpdateBedBodySchema = Type.Object({
  bedLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  geofenceLat: Type.Optional(Type.Number()),
  geofenceLon: Type.Optional(Type.Number()),
  geofenceRadiusMeters: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  isActive: Type.Optional(Type.Boolean()),
});
export type UpdateBedBody = Static<typeof UpdateBedBodySchema>;

// ── admission transitions (§4.1 routes 13–14, 18) ──────────────────────────────────────────────────────
export const RequestBedBodySchema = Type.Object({ unitId: id });
export type RequestBedBody = Static<typeof RequestBedBodySchema>;

export const AssignBedBodySchema = Type.Object({ bedId: id });
export type AssignBedBody = Static<typeof AssignBedBodySchema>;

export const DischargeBodySchema = Type.Object({
  reason: Type.Union([
    Type.Literal("to_home"),
    Type.Literal("to_facility"),
    Type.Literal("to_other_hospice"),
    Type.Literal("revocation"),
    Type.Literal("expired_benefit"),
  ]),
  /** The M6 discharge_event exists (resolved via the M6 DeathEventReader/discharge seam; injected here). */
  dischargeEventExists: Type.Boolean(),
});
export type DischargeBody = Static<typeof DischargeBodySchema>;

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
export const BedListSchema = Type.Object({ items: Type.Array(BedViewSchema) });

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

// ── restraint (§4.1 routes 22–24) ──────────────────────────────────────────────────────────────────────
export const ApplyRestraintBodySchema = Type.Object({
  restraintKind: Type.Union([
    Type.Literal("soft_limb"),
    Type.Literal("posey_vest"),
    Type.Literal("mitt"),
    Type.Literal("side_rail_4"),
  ]),
  restraintJustificationText: Type.String({ minLength: 100, maxLength: 4000 }),
  orderingPhysicianId: id,
  orderingOrderId: id,
  category: Type.Union([Type.Literal("behavioral"), Type.Literal("medical")]),
  reassessmentIntervalMinutes: Type.Integer({ minimum: 1, maximum: 240 }),
});
export type ApplyRestraintBody = Static<typeof ApplyRestraintBodySchema>;

export const ReassessRestraintBodySchema = Type.Object({
  outcome: Type.Union([Type.Literal("continue"), Type.Literal("modify"), Type.Literal("release")]),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
  nextDueAt: Type.String({ minLength: 1 }),
});
export type ReassessRestraintBody = Static<typeof ReassessRestraintBodySchema>;

export const RestraintViewSchema = Type.Object({
  id,
  ipuAdmissionId: id,
  restraintKind: Type.String(),
  state: Type.String(),
  reassessmentIntervalMinutes: Type.Integer(),
  version: Type.Integer(),
});

export const IdParamsSchema = Type.Object({ id });
export const DateParamsSchema = Type.Object({ date: Type.String({ minLength: 8, maxLength: 10 }) });
