import type { ApiClient } from "@wardenx/ui";

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

export interface ElectionCertificationApi {
  getElectionStatement(id: string): Promise<ElectionStatementDetail>;
  getCti(id: string): Promise<CtiDetail>;
  getFaceToFace(id: string): Promise<FaceToFaceDetail>;
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
  };
}
