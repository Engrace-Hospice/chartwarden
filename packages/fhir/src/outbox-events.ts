// @wardenx/fhir — §4.10 M28 outbox event catalog (M28-T07).
//
// The typed union of every outbox event M28 emits onto the M1 dispatcher (architecture §25). T07's
// bulk-export and inbound-proposal cores return these as PLAN descriptors; T08's routes/workers hand them
// to the real outbox. The `m28.` prefix keeps the event-catalog fitness convention (M01 D8 / M03 D9); the
// owner-module consumers are wired in T08's `events-by-m28.ts` registry (§4.10 subscription table).
//
// Note the `type:` discriminant (not `name:`) — the events-by-mN.ts REGISTRY that declares the
// `{ name, consumers }` rows the fitness scanner validates is a separate T08 artifact; this file is the
// payload-shape contract the cores build against.

import type {
  FhirBulkExportJobId,
  FhirBulkExportRequestKind,
  FhirClientId,
  FhirInboundOwnerModule,
  FhirInboundResourceId,
  FhirVersion,
} from "@wardenx/types";

export type M28OutboxEvent =
  | {
      type: "m28.fhir.client.pending_approval";
      payload: {
        clientId: FhirClientId;
        proposedByMembershipId: string;
        tier: string;
        allowedScopes: string[];
      };
    }
  | {
      type: "m28.fhir.client.activated";
      payload: {
        clientId: FhirClientId;
        approvedByAdminMembershipId: string;
        approvedByComplianceMembershipId: string;
        approvedAt: string;
      };
    }
  | { type: "m28.fhir.client.revoked"; payload: { clientId: FhirClientId; revokedAt: string; rationale: string } }
  | { type: "m28.fhir.client.suspended"; payload: { clientId: FhirClientId; reason: string } }
  | {
      type: "m28.fhir.bulk_export.accepted";
      payload: {
        jobId: FhirBulkExportJobId;
        clientId: FhirClientId;
        resourceTypes: string[];
        requestKind: FhirBulkExportRequestKind;
      };
    }
  | {
      type: "m28.fhir.bulk_export.completed";
      payload: {
        jobId: FhirBulkExportJobId;
        clientId: FhirClientId;
        completedAt: string;
        totalResources: number;
        artifactCount: number;
      };
    }
  | {
      type: "m28.fhir.bulk_export.failed";
      payload: { jobId: FhirBulkExportJobId; clientId: FhirClientId; failedAt: string; failureReason: string };
    }
  | {
      type: "m28.fhir.bulk_export.cancelled";
      payload: {
        jobId: FhirBulkExportJobId;
        clientId: FhirClientId;
        cancelledByMembershipId: string | null;
        cancelledAt: string;
      };
    }
  | {
      type: "m28.fhir.inbound.proposed";
      payload: {
        proposalId: FhirInboundResourceId;
        ownerModule: FhirInboundOwnerModule;
        resourceType: string;
        sourceClientId: FhirClientId;
        proposedAt: string;
        payloadSha256: string;
      };
    }
  | {
      type: "m28.fhir.inbound.accepted";
      payload: {
        proposalId: FhirInboundResourceId;
        ownerModule: FhirInboundOwnerModule;
        acceptedAggregateId: string;
        decidedByMembershipId: string;
        decidedAt: string;
      };
    }
  | {
      type: "m28.fhir.inbound.rejected";
      payload: {
        proposalId: FhirInboundResourceId;
        ownerModule: FhirInboundOwnerModule;
        decidedByMembershipId: string;
        decidedAt: string;
        rationale: string;
      };
    }
  | {
      type: "m28.fhir.inbound.expired";
      payload: { proposalId: FhirInboundResourceId; ownerModule: FhirInboundOwnerModule; expiredAt: string };
    }
  | {
      type: "m28.fhir.capability.regenerated";
      payload: { releaseTag: string; fhirVersion: FhirVersion; checksumSha256: string };
    };

export type M28OutboxEventType = M28OutboxEvent["type"];
