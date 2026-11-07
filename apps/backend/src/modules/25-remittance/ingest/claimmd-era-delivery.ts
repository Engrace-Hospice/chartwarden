import { createHash } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import { parseX12835AllSets } from "@chartwarden/x12-835-client";
import type { ParsedRemittanceAdvice } from "@chartwarden/x12-835-client";
import type { FoundationSiteReader } from "../../../bootstrap/foundation-site-reader";
import { createClaimMdProtectedPayloadCipher, type ClaimMdPayloadKeyRing } from "../../../bootstrap/claimmd-payload-cipher";
import { CLAIMMD_ERA_DELIVERY_JOB_ID, type createClaimMdEraStore } from "./claimmd-era-store";
import { m25ContentDigestOf } from "./service-drizzle";
import { finalizeClaimMdEraStage, stageVerifiedClaimMdEra, type VerifiedClaimMdEraSource } from "./claimmd-era-stage";

type Store = ReturnType<typeof createClaimMdEraStore>;
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export interface ClaimMdEraDeliverySummary {
  readonly examined: number; readonly delivered: number; readonly duplicates: number; readonly held: number; readonly failed: number;
}

/**
 * Recoverable M25 delivery. The central prepare/receipt transactions bracket a tenant-scoped stage transaction.
 * The tenant row is initially held; it becomes review-eligible only after the central receipt commits. This service
 * has no posting-capable port and never calls receiveAdvice, postAdvice, or an outbox publisher.
 */
export function createClaimMdEraDeliveryService(input: {
  readonly store: Store; readonly tenantDb: DbClient; readonly siteReader: Pick<FoundationSiteReader, "providerEntityOwners" | "locationOwners">;
  readonly keyRing: ClaimMdPayloadKeyRing; readonly accountReference: string; readonly usage: "test" | "production";
  readonly stageComponent?: typeof stageVerifiedClaimMdEra; readonly finalizeStage?: typeof finalizeClaimMdEraStage;
  readonly log?: (summary: ClaimMdEraDeliverySummary) => void;
}) {
  const protectedCipher = createClaimMdProtectedPayloadCipher(input.keyRing, "claimmd-era-stage:v1");
  const stageComponent = input.stageComponent ?? stageVerifiedClaimMdEra;
  const finalizeStage = input.finalizeStage ?? finalizeClaimMdEraStage;

  async function finalizeExisting(delivery: { readonly outcome: string; readonly deliveryId?: string; readonly stageIds?: readonly string[];
    readonly tenantFinalized?: boolean; readonly organizationId?: string; readonly safeReasonCode?: string | null }) {
    if (!delivery.deliveryId || !["delivered", "possible_duplicate", "exact_duplicate", "held"].includes(delivery.outcome))
      return delivery.outcome;
    if (delivery.tenantFinalized) return delivery.outcome;
    const disposition = delivery.outcome as "delivered" | "possible_duplicate" | "exact_duplicate" | "held";
    if (!delivery.organizationId) throw new Error("CLAIMMD_ERA_DELIVERY_OWNER_MISSING");
    await finalizeStage({ tenantDb: input.tenantDb, organizationId: delivery.organizationId,
      stageIds: delivery.stageIds ?? [], disposition, safeReasonCode: delivery.safeReasonCode, forceHold: disposition === "held" });
    await input.store.confirmDeliveryTenantFinalized(delivery.deliveryId);
    return disposition;
  }

  async function deliver(inboxId: string): Promise<"delivered" | "possible_duplicate" | "exact_duplicate" | "held"> {
    let source: Awaited<ReturnType<Store["readCapturedEra"]>>;
    let resolution: Awaited<ReturnType<Store["readVerifiedResolution"]>>;
    try {
      source = await input.store.readCapturedEra({ inboxId, accountReference: input.accountReference,
        usage: input.usage, executionJobId: CLAIMMD_ERA_DELIVERY_JOB_ID });
      resolution = await input.store.readVerifiedResolution({ inboxId, accountReference: input.accountReference, usage: input.usage });
    } catch {
      const held = await input.store.holdDelivery({ inboxId, accountReference: input.accountReference, usage: input.usage,
        reason: "SOURCE_REVALIDATION_FAILED" });
      if (held) {
        if (held.state === "delivered" || held.state === "exact_duplicate" || held.state === "possible_duplicate") {
          if (!held.tenantFinalized) {
            await finalizeStage({ tenantDb: input.tenantDb, organizationId: held.organizationId,
              stageIds: held.stageIds, disposition: held.state, safeReasonCode: held.safeErrorCode });
            await input.store.confirmDeliveryTenantFinalized(held.id);
          }
          return held.state;
        }
        await finalizeStage({ tenantDb: input.tenantDb, organizationId: held.organizationId,
          stageIds: held.stageIds, disposition: "held", safeReasonCode: held.safeErrorCode, forceHold: true });
        if (!held.tenantFinalized) await input.store.confirmDeliveryTenantFinalized(held.id);
      }
      return "held";
    }
    const prepared = await input.store.prepareDelivery({ inboxId, accountReference: input.accountReference, usage: input.usage,
      resolutionId: resolution.resolutionId, resolutionVersion: resolution.version, originalDigest: source.originalDigest,
      eraId: source.eraId, organizationId: resolution.organizationId, providerEntityId: resolution.providerEntityId,
      locationId: resolution.locationId });
    if (prepared.outcome !== "prepared") {
      if ("deliveryId" in prepared) return finalizeExisting(prepared) as Promise<"delivered" | "possible_duplicate" | "exact_duplicate" | "held">;
      return "held";
    }
    const stageIds: string[] = [];
    let heldReason: string | null = null;
    let sawPossible = false;
    let sawExact = false;
    let existingAdviceId: string | null = null;
    const parsedSets: { fileIndex: number; raw: string; advice: ParsedRemittanceAdvice }[] = [];
    for (const [fileIndex, raw] of source.files.entries()) {
      const parsed = parseX12835AllSets(raw, "commercial", { allowTestFiles: input.usage === "test" });
      if (!parsed.ok) { heldReason = "X12_PARSE_INVALID"; break; }
      for (const advice of parsed.value) parsedSets.push({ fileIndex, raw, advice });
    }
    const components = (resolution.decision as { transactionSets?: readonly Record<string, unknown>[] }).transactionSets;
    if (!heldReason && (!parsedSets.length || !Array.isArray(components))) heldReason = "RESOLUTION_COMPONENTS_INVALID";
    if (!heldReason) for (const component of parsedSets) {
      const componentId = sha256(`${prepared.idempotencyKey}\0${component.fileIndex}\0${component.advice.transactionSetControlNumber}`);
      const rawDigest = sha256(component.raw);
      const trace = component.advice.checkOrEftTraceNumber ?? null;
      const traceDigest = trace ? sha256(trace) : null;
      const resolutionComponent = (components as readonly Record<string, unknown>[]).find((entry) =>
        entry.fileIndex === component.fileIndex && entry.transactionSetControlNumber === component.advice.transactionSetControlNumber);
      const claimEvidence = (resolution.decision as { claims?: readonly Record<string, unknown>[] }).claims?.filter((entry) =>
        entry.fileIndex === component.fileIndex && entry.transactionSetControlNumber === component.advice.transactionSetControlNumber) ?? [];
      if (!resolutionComponent || claimEvidence.some((claim) => claim.outcome === "conflict" || claim.outcome === "ambiguous")) {
        heldReason = "RESOLUTION_COMPONENT_UNSAFE"; break;
      }
      const hasTin = component.advice.payee?.taxId != null;
      const evidenceCodes: VerifiedClaimMdEraSource["evidenceCodes"] = hasTin ?
        ["EXACT_PAYEE_NPI", "SINGLE_PROVIDER_ARTIFACT", "PAYEE_TIN_CONFIRMED"] : ["EXACT_PAYEE_NPI", "SINGLE_PROVIDER_ARTIFACT"];
      const staged = await stageComponent({ tenantDb: input.tenantDb,
        owner: { organizationId: resolution.organizationId, providerEntityId: resolution.providerEntityId, locationId: resolution.locationId },
        source: { inboxId, accountReference: input.accountReference, usage: input.usage, eraId: source.eraId, fileIndex: component.fileIndex,
          digest: source.originalDigest, fileDigest: rawDigest, resolutionId: resolution.resolutionId, resolutionVersion: resolution.version,
          idempotencyKey: componentId, contentDigest: m25ContentDigestOf(component.advice), paymentTraceDigest: traceDigest,
          interchangeControlNumber: component.advice.interchangeControlNumber,
          transactionSetControlNumber: component.advice.transactionSetControlNumber, evidenceCodes },
        duplicateFacts: { paymentTrace: trace, paymentAmount: component.advice.totalPaymentAmount.toFixed(2),
          contentDigest: m25ContentDigestOf(component.advice) },
        protectedDetails: { source: { inboxId, vendor: "claimmd", accountReference: input.accountReference, usage: input.usage,
          eraId: source.eraId, fileIndex: component.fileIndex, originalDigest: source.originalDigest, resolutionId: resolution.resolutionId,
          resolutionVersion: resolution.version, algorithmVersion: resolution.algorithmVersion }, transactionSet: component.advice,
          claimOutcomes: claimEvidence }, protectedCipher, protectedKeyId: input.keyRing.activeId,
        verifyCapturedSource: async (candidate) => {
          const currentSource = await input.store.readCapturedEra({ inboxId, accountReference: input.accountReference,
            usage: input.usage, executionJobId: CLAIMMD_ERA_DELIVERY_JOB_ID });
          const currentResolution = await input.store.readVerifiedResolution({ inboxId, accountReference: input.accountReference, usage: input.usage });
          return currentSource.originalDigest === candidate.digest && currentSource.eraId === candidate.eraId &&
            currentResolution.version === candidate.resolutionVersion && currentResolution.resolutionId === candidate.resolutionId &&
            currentResolution.organizationId === resolution.organizationId && currentResolution.providerEntityId === resolution.providerEntityId;
        },
        verifyProviderAndLocation: async (tx: Tx, owner) => {
          const provider = await input.siteReader.providerEntityOwners(tx as unknown as DbClient, [owner.providerEntityId]);
          if (!provider.some((row) => row.id === owner.providerEntityId && row.organizationId === owner.organizationId)) return false;
          if (!owner.locationId) return true;
          const location = await input.siteReader.locationOwners(tx as unknown as DbClient, [owner.locationId]);
          return location.some((row) => row.id === owner.locationId && row.providerEntityId === owner.providerEntityId);
        },
      });
      if (staged.outcome === "held") { heldReason = staged.reason; break; }
      stageIds.push(staged.stageId);
      if (staged.outcome === "possible_duplicate") sawPossible = true;
      if (staged.outcome === "exact_duplicate") sawExact = true;
      if (staged.existingAdviceId) existingAdviceId ??= staged.existingAdviceId;
    }
    const disposition = heldReason ? "held" : sawPossible ? "possible_duplicate" : sawExact ? "exact_duplicate" : "delivered";
    const receipt = await input.store.finishDelivery({ deliveryId: prepared.deliveryId, inboxId,
      resolutionId: resolution.resolutionId, resolutionVersion: resolution.version, originalDigest: source.originalDigest,
      organizationId: resolution.organizationId, providerEntityId: resolution.providerEntityId, locationId: resolution.locationId,
      state: disposition,
      stageIds, existingAdviceId, safeErrorCode: heldReason ?? (sawPossible ? "POSSIBLE_CROSS_SOURCE_DUPLICATE" :
        sawExact ? "EXACT_DUPLICATE_FROM_M25" : null) });
    const finalState = receipt.outcome as "delivered" | "possible_duplicate" | "exact_duplicate" | "held";
    await finalizeStage({ tenantDb: input.tenantDb, organizationId: resolution.organizationId, stageIds,
      disposition: finalState, safeReasonCode: receipt.reason });
    await input.store.confirmDeliveryTenantFinalized(prepared.deliveryId);
    return finalState;
  }

  return {
    async deliver(inboxId: string) { return deliver(inboxId); },
    async runOnce(limit = 25): Promise<ClaimMdEraDeliverySummary> {
      const inboxIds = await input.store.pendingDelivery(input.accountReference, input.usage, limit);
      let delivered = 0, duplicates = 0, held = 0, failed = 0;
      for (const inboxId of inboxIds) {
        try {
          const result = await deliver(inboxId);
          if (result === "delivered") delivered++;
          else if (result === "possible_duplicate" || result === "exact_duplicate") duplicates++;
          else held++;
        } catch {
          failed++;
        }
      }
      const summary = { examined: inboxIds.length, delivered, duplicates, held, failed };
      input.log?.(summary);
      return summary;
    },
  };
}
