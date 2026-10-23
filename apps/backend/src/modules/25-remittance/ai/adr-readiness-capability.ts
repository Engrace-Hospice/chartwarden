// apps/backend/src/modules/25-remittance/ai/adr-readiness-capability.ts - M25 milestone 8a-1: the DENY-STUBBED port
// through which an AI documentation-readiness assistant could one day be consulted (the `22-documents/extraction/
// doclens-capability.ts` precedent).
//
// M25 `dependsOn` is `[1, 23, 36]`: it does NOT depend on M32 (AI Platform), so this file declares the port
// STRUCTURALLY and imports nothing from `@chartwarden/ai-platform` (that would be a dependency-cruiser edge). Phase 1:
// `resolveAdrReadinessAssist()` returns the deny-stub, so no code path can reach a model. Binding a real capability is
// milestone 8b (vendor/BAA/ZDR, M32 pipeline bindings, the AI approval workflow and SME facts) and is then a single
// edit in this resolver.
//
// What crosses the port is IDS and the requirement KEYS only. Document text is never handled by M25: whatever reads it
// does so inside the M32 / M22 boundary under the caller's tenant scope. What comes back is untrusted: the service runs
// every finding through `acceptAiFindings` (domain/readiness.ts) before anything is stored or shown.
import type { AdrChecklistKey } from "../domain";

/** Ids and requirement keys, no free text, no PHI. */
export interface AdrReadinessAssistInput {
  readonly organizationId: string;
  readonly adrCaseId: string;
  readonly documents: readonly {
    readonly documentId: string;
    readonly checklistKey: string | null;
  }[];
  /** The SME-owned requirement keys (today the unconfirmed ADR_CHECKLIST_KEYS), passed as data. */
  readonly requirementKeys: readonly AdrChecklistKey[];
}

export type AdrReadinessUnavailableReason =
  | "capability_unavailable"
  | "kill_switch_active"
  | "tenant_not_opted_in"
  | "budget_exhausted"
  | "timeout"
  | "schema_invalid"
  /** The port threw: recorded as a failed review. Set by the service, never by an implementation. */
  | "assistant_error";

/** The assistant either answered (with UNTRUSTED findings) or is absent. Absence is a value, never a throw. */
export type AdrReadinessAssistResult =
  | {
      readonly available: true;
      /** Unvalidated on purpose: `acceptAiFindings` is the only door. */
      readonly findings: unknown;
      readonly invocationId: string;
      readonly modelVersionPin: string;
      readonly promptTemplateVersion: string;
    }
  | { readonly available: false; readonly reason: AdrReadinessUnavailableReason };

export interface AdrReadinessAssistPort {
  review(input: AdrReadinessAssistInput): Promise<AdrReadinessAssistResult>;
}

/** The only implementation in 8a-1: every call reports the capability as unavailable. */
export const denyStubAdrReadinessAssist: AdrReadinessAssistPort = {
  review: async () => ({ available: false, reason: "capability_unavailable" }),
};

/** The seam key M32 will publish the capability under (forward reference; not a member of the typed M1 union). */
export const ADR_READINESS_CAPABILITY_SEAM = "AdrReadinessAssist" as const;

/**
 * Resolve the readiness assistant. 8a-1: always the deny-stub. 8b flips this to read the M32 seam opaquely (one edit,
 * mirroring `resolveDocLensCapability`), with no M25 -> M32 dependency edge.
 */
export function resolveAdrReadinessAssist(): AdrReadinessAssistPort {
  return denyStubAdrReadinessAssist;
}
