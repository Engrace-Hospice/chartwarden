// apps/backend/src/modules/08-encounters/cosignature/subject.ts — what a cosignature request is ABOUT (ADR-0114 VN-D30). Pure.
//
// The §2.4 workflow (acknowledge, escalate, hard cap, release, sign; the 12h/24h/48h clock) is one machine, `transitionCosignature`, and it does
// not care what is being cosigned. There are two subjects: the NOTE (the request an LPN/CHHA primary sign opens, in `cosignature_request`, which
// moves the encounter to `cosigned`) and an AMENDMENT (the request an amending addendum opens, in `addendum_cosignature_request`, which leaves the
// encounter as it is). Everything that reads or acts on a request takes a `CosignSubject` instead of being written twice.
import type { CosignatureStatus } from "@chartwarden/types";

export type CosignSubject =
  | { readonly kind: "note"; readonly encounterId: string }
  | { readonly kind: "addendum"; readonly encounterId: string; readonly addendumId: string };

/** The subject a route or a caller names: the encounter's own request, or the one of `addendumId` under it. */
export const cosignSubjectOf = (encounterId: string, addendumId?: string): CosignSubject =>
  addendumId === undefined
    ? { kind: "note", encounterId }
    : { kind: "addendum", encounterId, addendumId };

/** The requests that still await a signature: what the cosignature queue lists (`signed` is terminal, `pending` is never routed past). */
export const COSIGN_OPEN_STATUSES = [
  "routed",
  "acknowledged",
  "escalated",
  "hard_cap_reached",
  "supervisor_released",
] as const satisfies readonly CosignatureStatus[];

/** Where an amendment's cosignature stands, for a screen: the SLA stages are alerts, not different answers. */
export type CosignDisplayStatus = "not_required" | "pending" | "cosigned" | "released";

export function cosignDisplayStatus(status: CosignatureStatus | null): CosignDisplayStatus {
  if (status === null) return "not_required";
  if (status === "signed") return "cosigned";
  if (status === "supervisor_released") return "released";
  return "pending";
}

/**
 * The RN a cosignature request is routed to: the patient's case-management RN, unless that RN may not cosign THIS subject, in which case there is
 * none (the caller's 422 `NO_ELIGIBLE_COSIGNER`, before any write). `excluded` are the members the cosignature service refuses at acknowledge and
 * sign: whoever signed what is being cosigned, and for an amendment the author of the note it amends as well. Routing to one of them would raise
 * the request, its alerts and its escalations at someone who cannot act on it, and the eligible-cosigner check would never fire.
 */
export const eligibleCosigner = (
  candidate: string | null,
  excluded: readonly string[],
): string | null => (candidate !== null && excluded.includes(candidate) ? null : candidate);
