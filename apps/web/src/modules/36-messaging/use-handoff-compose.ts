// M36 WP 3.5 - the calls behind the compose drawer: caseload, pre-fill (a pure read), the offer, and the expiry policy.
// Nothing here is stored client-side; the draft lives in component state until Offer.
import type { HandoffDto, HandoffItemKind } from "@chartwarden/types";
import { useApiClient } from "@chartwarden/ui";
import { useMemo } from "react";
import { type HandoffResult, NETWORK_FAILURE, toResult } from "./use-handoffs";

export interface CaseloadPatient {
  readonly patient_id: string;
  readonly display_name: string;
  readonly mrn_suffix: string | null;
}
export interface PrefillItem {
  readonly kind: HandoffItemKind;
  readonly ref_id: string;
  readonly status?: string | undefined;
  readonly occurred_at?: string | undefined;
}
export interface PrefillPatient {
  readonly patient_id: string;
  readonly items: readonly PrefillItem[];
  readonly unavailable_sources: readonly HandoffItemKind[];
}
export interface OfferItem {
  readonly kind: HandoffItemKind;
  readonly ref_id: string;
  readonly patient_id: string;
}
export interface HandoffPolicy {
  readonly expiry_minutes: number;
  readonly platform_max_minutes: number;
  readonly customised: boolean;
}

export interface HandoffComposeApi {
  readonly caseload: () => Promise<HandoffResult<{ patients: readonly CaseloadPatient[] }>>;
  readonly prefill: (
    patientIds: readonly string[],
  ) => Promise<HandoffResult<{ patients: readonly PrefillPatient[] }>>;
  readonly offer: (
    toUserId: string,
    items: readonly OfferItem[],
  ) => Promise<HandoffResult<{ handoff: HandoffDto; created: boolean }>>;
  readonly policy: () => Promise<HandoffResult<HandoffPolicy>>;
}

export function useHandoffComposeApi(): HandoffComposeApi {
  const client = useApiClient();
  return useMemo(
    () => ({
      caseload: () =>
        client.GET("/api/v1/messaging/handoffs/caseload").then(toResult, () => NETWORK_FAILURE),
      prefill: (patientIds) =>
        client
          .POST("/api/v1/messaging/handoffs/prefill", { body: { patient_ids: [...patientIds] } })
          .then(toResult, () => NETWORK_FAILURE),
      offer: (toUserId, items) =>
        client
          .POST("/api/v1/messaging/handoffs", {
            body: { to_user_id: toUserId, items: items.map((item) => ({ ...item })) },
          })
          .then(toResult, () => NETWORK_FAILURE),
      policy: () =>
        client.GET("/api/v1/messaging/handoffs/policy").then(toResult, () => NETWORK_FAILURE),
    }),
    [client],
  );
}
