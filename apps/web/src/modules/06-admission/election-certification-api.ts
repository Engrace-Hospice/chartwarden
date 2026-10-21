import type { ApiClient } from "@chartwarden/ui";

/** The three existing detail routes currently publish the same OpenAPI summary response. */
export interface ElectionCertificationResourceDetail {
  id: string;
  state: string;
  version: number;
  patientId?: string | null;
}

export type ElectionStatementDetail = ElectionCertificationResourceDetail;
export type CtiDetail = ElectionCertificationResourceDetail;
export type FaceToFaceDetail = ElectionCertificationResourceDetail;

/** The §3.2 `f2f_encounter_location` alphabet (R-F2F-05). */
export type F2fEncounterLocation =
  | "patient_home"
  | "alf"
  | "snf"
  | "ipu"
  | "hospital"
  | "telehealth";

/** The § 418.22(a)(4)(ii)(A)–(C) facts the completing clinician attests for a telehealth F2F. */
export interface TelehealthEligibility {
  patientInMoratoriumArea: boolean;
  hospiceUnderEnhancedOversight: boolean;
  performerMedicareEnrolledOrOptedOut: boolean;
}

export interface CompleteFaceToFaceInput {
  encounterDate: string;
  encounterLocation: F2fEncounterLocation;
  telehealthEligibility?: TelehealthEligibility;
  ifVersion: number;
}

/** Exactly one source (§ 418.22(b)(4)): a written narrative or a linked signed visit note. */
export type AttestFaceToFaceInput =
  | { attestationNarrative: string; ifVersion: number }
  | { signedNoteEncounterId: string; ifVersion: number };

/** A signed M8 visit note that could serve as the F2F attestation (R-F2F-06). */
export interface SignedVisitNote {
  id: string;
  encounterType: string;
  discipline: string;
  serviceDate: string;
  status: string;
  authoredByUserId: string;
  signedAt: string | null;
}

const PRIMARY_SIGNED = ["signed", "cosign_pending", "cosigned"];

/** POST /admissions/:id/face-to-face body (R-F2F schedule). */
export interface ScheduleFaceToFaceInput {
  electionPeriodId: string;
  scheduledDate: string;
  windowStart: string;
  windowEnd: string;
  clinicianRole: "hospice_np" | "hospice_md";
  scheduledClinicianId: string;
}

export interface ElectionCertificationApi {
  scheduleFaceToFace(admissionId: string, input: ScheduleFaceToFaceInput): Promise<void>;
  overrideFaceToFaceWindow(id: string, input: { reason: string; ifVersion: number }): Promise<void>;
  getElectionStatement(id: string): Promise<ElectionStatementDetail>;
  getCti(id: string): Promise<CtiDetail>;
  getFaceToFace(id: string): Promise<FaceToFaceDetail>;
  completeFaceToFace(id: string, input: CompleteFaceToFaceInput): Promise<void>;
  attestFaceToFace(id: string, input: AttestFaceToFaceInput): Promise<void>;
  /** The patient's notes signed on `serviceDate` (optionally by `authorUserId`) — the R-F2F-06 candidates. */
  signedNotesOn(
    patientId: string,
    serviceDate: string,
    authorUserId?: string | null,
  ): Promise<SignedVisitNote[]>;
}

/** The server's machine-readable error code, when the envelope carries one. */
export class FaceToFaceWriteError extends Error {
  constructor(readonly code: string | null) {
    super(code ?? "F2F_WRITE_FAILED");
  }
}

function errorCode(error: unknown): string | null {
  const code = (error as { error?: { code?: unknown } } | undefined)?.error?.code;
  return typeof code === "string" ? code : null;
}

function detailOrThrow<T extends ElectionCertificationResourceDetail>(
  data: T | undefined,
  error: unknown,
): T {
  if (error || !data) throw new Error("DETAIL_LOAD_FAILED");
  return data;
}

/** Centralized, typed read API for the patient Election & Certification workspace. */
export function createElectionCertificationApi(client: ApiClient): ElectionCertificationApi {
  return {
    async getElectionStatement(id) {
      const { data, error } = await client.GET("/api/v1/election-statements/{id}", {
        params: { path: { id } },
      });
      return detailOrThrow(data, error);
    },

    async getCti(id) {
      const { data, error } = await client.GET("/api/v1/cti/{id}", {
        params: { path: { id } },
      });
      return detailOrThrow(data, error);
    },

    async getFaceToFace(id) {
      const { data, error } = await client.GET("/api/v1/face-to-face/{id}", {
        params: { path: { id } },
      });
      return detailOrThrow(data, error);
    },

    async completeFaceToFace(id, input) {
      const { error } = await client.POST("/api/v1/face-to-face/{id}/complete", {
        params: { path: { id } },
        body: input,
      });
      if (error) throw new FaceToFaceWriteError(errorCode(error));
    },

    async attestFaceToFace(id, input) {
      const { error } = await client.POST("/api/v1/face-to-face/{id}/attest", {
        params: { path: { id } },
        body: input,
      });
      if (error) throw new FaceToFaceWriteError(errorCode(error));
    },

    async scheduleFaceToFace(admissionId, input) {
      const { error } = await client.POST("/api/v1/admissions/{id}/face-to-face", {
        params: { path: { id: admissionId } },
        body: input,
      });
      if (error) throw new FaceToFaceWriteError(errorCode(error));
    },

    async overrideFaceToFaceWindow(id, input) {
      const { error } = await client.POST("/api/v1/face-to-face/{id}/override-window", {
        params: { path: { id } },
        body: input,
      });
      if (error) throw new FaceToFaceWriteError(errorCode(error));
    },

    async signedNotesOn(patientId, serviceDate, authorUserId) {
      const { data, error } = await client.GET("/api/v1/encounters", {
        params: { query: { patientId, from: serviceDate, to: serviceDate, limit: 50 } },
      });
      if (error || !data) throw new Error("NOTES_LOAD_FAILED");
      const rows = (data as { encounters?: SignedVisitNote[] }).encounters ?? [];
      return rows.filter(
        (n) =>
          PRIMARY_SIGNED.includes(n.status) &&
          n.signedAt !== null &&
          n.serviceDate === serviceDate &&
          (!authorUserId || n.authoredByUserId === authorUserId),
      );
    },
  };
}
