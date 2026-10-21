// M36 WP 3.2 - the DEFAULT candidate source: the owning modules' EXISTING patient-scoped list routes, read through the
// typed client (GET only). A kind is enabled only where a typed list route exists today:
//   assessment  GET /patients/{patientId}/assessments
//   medication  GET /medication-orders?patientId=
//   care_plan   GET /patients/{patientId}/care-plan   (one aggregate; 404 = no plan yet)
// order, visit, document and idg_meeting have no patient-scoped typed list route yet, so they are hidden. Add a kind by
// adding a branch here once its route exists; nothing else changes.
import { type ApiClient, useApiClient } from "@chartwarden/ui";
import { useMemo } from "react";
import type { ClinicalLinkCandidate, ClinicalLinkCandidateSource } from "./clinical-link-kinds";

const SCALE_LABEL = (scale: string): string => scale.replaceAll("_", " ").toUpperCase();
const readable = (value: string): string => value.replaceAll("_", " ");
const day = (iso: string): string | undefined => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleDateString();
};

class ListFailed extends Error {}

async function listAssessments(
  client: ApiClient,
  patientId: string,
  signal: AbortSignal,
): Promise<readonly ClinicalLinkCandidate[]> {
  const { data } = await client.GET("/api/v1/patients/{patientId}/assessments", {
    params: { path: { patientId } },
    signal,
  });
  if (!data) throw new ListFailed();
  return data.assessments.map((a) => ({
    kind: "assessment" as const,
    entityId: a.id,
    label: SCALE_LABEL(a.scaleType),
    detail: day(a.capturedAt),
  }));
}

async function listMedications(
  client: ApiClient,
  patientId: string,
  signal: AbortSignal,
): Promise<readonly ClinicalLinkCandidate[]> {
  const { data } = await client.GET("/api/v1/medication-orders", {
    params: { query: { patientId } },
    signal,
  });
  if (!data) throw new ListFailed();
  return data.orders.map((o) => ({
    kind: "medication" as const,
    entityId: o.id,
    label: `${o.drugName} ${o.strength}`.trim(),
    detail: readable(o.status),
  }));
}

async function listCarePlan(
  client: ApiClient,
  patientId: string,
  signal: AbortSignal,
): Promise<readonly ClinicalLinkCandidate[]> {
  const { data, response } = await client.GET("/api/v1/patients/{patientId}/care-plan", {
    params: { path: { patientId } },
    signal,
  });
  if (response?.status === 404) return [];
  if (!data) throw new ListFailed();
  if ("carePlan" in data) return [];
  return [
    { kind: "care_plan", entityId: data.id, label: "Care plan", detail: readable(data.status) },
  ];
}

export function useDefaultClinicalLinkSource(): ClinicalLinkCandidateSource {
  const client = useApiClient();
  return useMemo<ClinicalLinkCandidateSource>(
    () => ({
      kinds: ["assessment", "medication", "care_plan"],
      list: (kind, patientId, signal) => {
        if (kind === "assessment") return listAssessments(client, patientId, signal);
        if (kind === "medication") return listMedications(client, patientId, signal);
        if (kind === "care_plan") return listCarePlan(client, patientId, signal);
        return Promise.resolve([]);
      },
    }),
    [client],
  );
}
