import type { PacketSnapshot } from "@chartwarden/types";

export interface SeedSnapshotFacts {
  readonly meetingId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly locationId: string;
  readonly builtAtIso: string;
  readonly fullNameRedacted: string; // "First L."
  readonly age: number;
  readonly lastSignedVersionId: string | null;
}

/**
 * A full, schema-valid `PacketSnapshot` for a DB-direct seeded packet (no worker runs on this seed path). The
 * reader (`routes/packet-content.ts`) rejects a snapshot missing `patientCover`/`carePlanSummary`, which made the
 * packet page say "Packet snapshot unavailable". Digest lists stay empty. Name, age and care-plan version id are the patient's own;
 * the diagnosis (C34.90), care-plan counts and review dates are DEMO PLACEHOLDERS, not read from the DB.
 */
export function buildSeedPacketSnapshot(f: SeedSnapshotFacts): PacketSnapshot {
  return {
    schemaVersion: "2026-01-v1",
    meta: {
      meetingId: f.meetingId,
      patientId: f.patientId,
      admissionId: f.admissionId,
      locationId: f.locationId,
      builtAt: f.builtAtIso,
      sinceCursorIso: f.builtAtIso,
      sinceContext: "first_idg",
      builderJobId: "seed-scenario-orders-meds-idg",
      appliedSudRedaction: false,
    },
    patientCover: {
      fullNameRedacted: f.fullNameRedacted,
      age: f.age,
      primaryDiagnosisIcd10: "C34.90",
      primaryDiagnosisLabel: "Malignant neoplasm of unspecified part of bronchus or lung",
      daysOnService: 0,
      levelOfCare: "routine",
      nextRecertDueAt: null,
      f2fWindowState: null,
      activeDpoa: null,
      activeSudFlag: false,
    },
    sinceLastIdg: {
      encounters: [],
      significantAssessmentChanges: [],
      j2051Triggers: [],
      ordersChanged: [],
      medicationsChanged: [],
      flaggedEvents: [],
    },
    carePlanSummary: {
      activeProblemCount: 0,
      activeGoalCount: 0,
      activeInterventionCount: 0,
      lastSignedVersionId: f.lastSignedVersionId ?? "00000000-0000-4000-8000-000000000000",
      lastSignedAt: f.builtAtIso,
      nextReviewDueAt: f.builtAtIso,
      isReviewOverdue: false,
    },
    hopeContext: null,
    medicationHistory: null,
    capProjection: null,
    carryForwardActionItems: [],
    flagsForDiscussion: [],
  } as unknown as PacketSnapshot;
}
