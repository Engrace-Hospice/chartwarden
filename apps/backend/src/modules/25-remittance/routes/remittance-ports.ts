// apps/backend/src/modules/25-remittance/routes/remittance-ports.ts — the two ports the manual-match /
// adjustment-override commands depend on (GAP-073), with their live defaults.
//
// {@link ClaimFactsPort} is the by-id claim lookup the §4.2 rule requires ("the proposed claim id is
// server-validated against M23 … must exist; must belong to the same provider_entity"). The runtime M23
// seams expose no by-id read for M25 (`ClaimReader` is the FHIR projection; `ClaimSubmissionReader` matches
// on control numbers only), so the default reads M23's claim repository on the CALLER'S tx — the same
// legality `resolveDenial` and `outbox-consumers/m23-claim-rejected.ts` already rely on (M25's manifest
// `dependsOn` includes 23). Tests inject a stub.
//
// {@link RemittanceAuditPort} persists the operator's free-text rationale. `remittance_line` and
// `remittance_adjustment` carry no reason column, so the rationale lands in the M4 audit trail (`audit_event`,
// written atomically on the same tx through the `@chartwarden/audit` helper) and NEVER in an outbox payload.
import { randomUUID } from "node:crypto";
import { audit } from "@chartwarden/audit";
import { repositories } from "@chartwarden/billing";
import type { M25WriteActor } from "./actor";

/** The three claim facts the commands read. */
export interface ClaimFacts {
  readonly id: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  /** The claim's admission (a document linked to an admission must be this one); absent on a stub. */
  readonly admissionId?: string;
  /** The claim control number (for display); absent on a stub. */
  readonly claimControlNumber?: string;
}

export interface ClaimFactsPort {
  /** `null` when the claim does not exist (or RLS hides it). */
  byId(tx: unknown, claimId: string): Promise<ClaimFacts | null>;
}

export interface RemittanceAuditEvent {
  readonly eventType: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly context: Record<string, unknown>;
}

export interface RemittanceAuditPort {
  record(tx: unknown, actor: M25WriteActor, event: RemittanceAuditEvent): Promise<void>;
}

/** The live claim lookup: M23's claim repository on the caller's RLS-scoped tx. */
export const m23ClaimFactsPort: ClaimFactsPort = {
  async byId(tx, claimId) {
    const claim = await new repositories.ClaimRepository(
      tx as ConstructorParameters<typeof repositories.ClaimRepository>[0],
    ).findById(claimId);
    return claim
      ? {
          id: claim.id,
          providerEntityId: claim.providerEntityId,
          patientId: claim.patientId,
          admissionId: claim.admissionId,
          claimControlNumber: claim.claimControlNumber,
        }
      : null;
  },
};

/** The live audit sink: one `audit_event` row on the caller's tx. */
export const m4RemittanceAuditPort: RemittanceAuditPort = {
  async record(tx, actor, event) {
    await audit(
      tx as Parameters<typeof audit>[0],
      {
        organizationId: actor.organizationId,
        userId: actor.userId,
        actorKind: "user",
        actorRole: actor.roles[0],
        correlationId: randomUUID(),
      },
      { ...event, outcome: "success" },
    );
  },
};
