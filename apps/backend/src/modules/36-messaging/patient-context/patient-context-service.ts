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
} from "@chartwarden/types";

export const PATIENT_CONTEXT_TILES = [
  "status",
  "care_team",
  "allergies",
  "medications",
  "open_tasks",
] as const;
export type PatientContextTile = (typeof PATIENT_CONTEXT_TILES)[number];

/** Where the tile leads: the Tasks tab of the notifications screen. */
const OPEN_TASKS_LINK = "/notifications?tab=tasks";

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
  /** WP 3.4: the CALLER'S OWN active tasks on the patient (assigned to or created by them, channel visible to them). */
  openTaskCount(organizationId: string, patientId: string, userId: string): Promise<number>;
  now(): Date;
  /** Called with the tile name only (never the error text, which may carry PHI) when a tile degrades to unavailable. */
  onTileUnavailable?(tile: PatientContextTile): void;
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
  readonly care_team?: TileResult<{ member_count: number }>;
  readonly allergies?: TileResult<{
    entries: ReadonlyArray<{ allergen: string; severity: PatientAllergyEntry["severity"] }>;
  }>;
  readonly medications?: TileResult<{ active_count: number }>;
  readonly open_tasks?: TileResult<{ count: number }>;
}

export interface PatientContext {
  readonly patient_id: string;
  readonly tiles: PatientContextTiles;
}

export interface PatientContextRequest {
  readonly organizationId: string;
  readonly patientId: string;
  /** The caller (server-side request context): open tasks are counted per user, never team-wide. */
  readonly userId: string;
  readonly allowed: ReadonlySet<PatientContextTile>;
}

/** Null when the patient is not in the org. An empty `allowed` returns no tiles without touching any source. */
export async function buildPatientContext(
  req: PatientContextRequest,
  ports: PatientContextPorts,
): Promise<PatientContext | null> {
  const { organizationId: org, patientId, userId, allowed } = req;
  if (allowed.size === 0) return { patient_id: patientId, tiles: {} };

  // A failing lookup (DB error, unbound deny-stub) costs only the status tile; the other tiles read their own seams.
  let patient: PatientIdentity | null | undefined;
  try {
    patient = await ports.findPatient(org, patientId);
  } catch {
    patient = undefined;
  }
  if (patient === null) return null;

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
      ports.onTileUnavailable?.(tile);
      return [tile, { state: "unavailable", link: tileLink }];
    }
  };

  const results = await Promise.all([
    settle("status", link, async () => {
      if (!patient) throw new Error("patient unreadable");
      return { status: patient.status ?? null };
    }),
    settle("care_team", link, async () => {
      const ids = await ports.careTeamMembers(org, patientId);
      return { member_count: ids.length };
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
    settle("open_tasks", OPEN_TASKS_LINK, async () => ({
      count: await ports.openTaskCount(org, patientId, userId),
    })),
  ]);

  return { patient_id: patientId, tiles: Object.fromEntries(results.filter((r) => r !== null)) };
}
