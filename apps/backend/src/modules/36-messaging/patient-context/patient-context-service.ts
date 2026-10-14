// apps/backend/src/modules/36-messaging/patient-context/patient-context-service.ts — WP 3.1 patient context panel.
//
// A READ-ONLY PROJECTION through the owning modules' seams; M36 stores nothing. Each tile is a separate, independently
// authorised read: the route decides which tiles the caller may see (`allowed`) and this service never calls the source
// of a tile that is not in that set, so a denied tile is ABSENT (not null, not 403) and its data never leaves the seam.
//
// A seam that throws (an unbound deny-stub, a DB error) degrades only its own tile to `unavailable`; it never fails the
// panel and never reads as "none". `as_of` is when this projection read the source — the seams carry no source-side
// timestamp, so the panel says when it looked, not when the clinician last edited.
import type {
  MedicationOrderDto,
  PatientAllergyEntry,
  PatientIdentity,
  PatientLifecycleStatus,
} from "@wardenx/types";

export const PATIENT_CONTEXT_TILES = ["status", "care_team", "allergies", "medications"] as const;
export type PatientContextTile = (typeof PATIENT_CONTEXT_TILES)[number];

export interface PatientContextPorts {
  findPatient(organizationId: string, patientId: string): Promise<PatientIdentity | null>;
  careTeamMembers(organizationId: string, patientId: string): Promise<readonly string[]>;
  activeAllergies(
    organizationId: string,
    patientId: string,
  ): Promise<readonly PatientAllergyEntry[] | null>;
  activeMedications(
    organizationId: string,
    patientId: string,
  ): Promise<readonly MedicationOrderDto[]>;
  now(): Date;
}

interface TileBase {
  /** Deep link to the owning module's screen. */
  readonly link: string;
}
export type TileResult<T> =
  | (TileBase & { readonly state: "ok"; readonly as_of: string; readonly data: T })
  | (TileBase & { readonly state: "unavailable" });

export interface PatientContextTiles {
  readonly status?: TileResult<{ status: PatientLifecycleStatus | null }>;
  readonly care_team?: TileResult<{ member_count: number; member_user_ids: readonly string[] }>;
  readonly allergies?: TileResult<{
    entries: ReadonlyArray<{ allergen: string; severity: PatientAllergyEntry["severity"] }>;
  }>;
  readonly medications?: TileResult<{ active_count: number }>;
}

export interface PatientContext {
  readonly patient_id: string;
  readonly tiles: PatientContextTiles;
}

export interface PatientContextRequest {
  readonly organizationId: string;
  readonly patientId: string;
  readonly allowed: ReadonlySet<PatientContextTile>;
}

/** Null when the patient is not in the org. An empty `allowed` returns no tiles without touching any source. */
export async function buildPatientContext(
  req: PatientContextRequest,
  ports: PatientContextPorts,
): Promise<PatientContext | null> {
  const { organizationId: org, patientId, allowed } = req;
  if (allowed.size === 0) return { patient_id: patientId, tiles: {} };

  const patient = await ports.findPatient(org, patientId);
  if (!patient) return null;

  const link = `/patients/${patientId}`;
  const settle = async <T>(
    tile: PatientContextTile,
    tileLink: string,
    read: () => Promise<T>,
  ): Promise<readonly [PatientContextTile, TileResult<T>] | null> => {
    if (!allowed.has(tile)) return null;
    try {
      const data = await read();
      return [tile, { state: "ok", as_of: ports.now().toISOString(), data, link: tileLink }];
    } catch {
      return [tile, { state: "unavailable", link: tileLink }];
    }
  };

  const results = await Promise.all([
    settle("status", link, async () => ({ status: patient.status ?? null })),
    settle("care_team", link, async () => {
      const ids = await ports.careTeamMembers(org, patientId);
      return { member_count: ids.length, member_user_ids: ids };
    }),
    settle("allergies", link, async () => {
      const list = await ports.activeAllergies(org, patientId);
      // null = patient unreadable: "cannot check", never "no allergies".
      if (list === null) throw new Error("allergy list unreadable");
      return { entries: list.map((a) => ({ allergen: a.allergenText, severity: a.severity })) };
    }),
    settle("medications", `${link}/medications`, async () => ({
      active_count: (await ports.activeMedications(org, patientId)).length,
    })),
  ]);

  return { patient_id: patientId, tiles: Object.fromEntries(results.filter((r) => r !== null)) };
}
