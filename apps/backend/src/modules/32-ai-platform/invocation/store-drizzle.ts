import type { AiBackendRoutingRow } from "@wardenx/ai-platform";
// apps/backend/src/modules/32-ai-platform/invocation/store-drizzle.ts — the Drizzle implementations of
// M32-T04's invocation stores.
//
// THE CREDENTIAL SPLIT, CONTINUED (§3.3 / migration 0116):
//
//   · `ai_model_backend` is platform-shared and `ai_model_backend_read` is `USING (true)` for
//     `wardenx_app`, so the routing gate reads it on the ORDINARY tenant handle. It does NOT take
//     `withPlatformContext`: opening an audited cross-tenant credential for a read a tenant connection
//     can already perform is a `platform.bypass_invoked` row per AI call, which teaches operators to
//     ignore the alert that exists to be rare.
//   · `ai_routing_override`, `ai_invocation` and `ai_token_ledger` are org-scoped, so EVERY method
//     opens `withOrgContext` and RLS on `app.org_id` is what keeps one agency's disclosures out of the
//     next agency's ledger. No method takes an org id it does not also pin into the session variable.
//
// THE INVOCATION AND ITS ACCRUAL ARE ONE TRANSACTION. §1.1 makes them one write and §3.2.9 gives the
// ledger row no FK to its parent (both tables are partitioned; a real FK would have to carry the
// invocation's partition key into this table). The transaction is therefore the ONLY thing keeping an
// accrual from outliving a rolled-back invocation — which is why `recordInvocation` takes both and
// there is no method that writes an accrual alone.
//
// TIMESTAMPS CROSS THE PORT AS ISO STRINGS (the M32-T03 posture), so the in-memory store and this one
// stay structurally identical and the slice tests keep proving something about this file.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  AiBackendHealthStatus,
  AiInvocationHitlOutcome,
  AiModelBackendKind,
  AiModelModality,
  AiRoutingOverrideReason,
  AiZdrStatus,
} from "@wardenx/types";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { M32EventName } from "../event-names";
import { type M32EventEmitter, capabilityIdentity } from "../events";

import type { AiInvocationCapabilityStore } from "./service";
import type {
  AiBackendRegistryStore,
  AiInvocationInsert,
  AiInvocationLedgerStore,
  AiRoutingOverrideStore,
} from "./store";

type BackendSelect = typeof schema.aiModelBackend.$inferSelect;
type OverrideSelect = typeof schema.aiRoutingOverride.$inferSelect;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asModalities(value: unknown): readonly AiModelModality[] {
  return Array.isArray(value)
    ? value.filter(
        (v): v is AiModelModality =>
          v === "text" || v === "embedding" || v === "classification" || v === "vision",
      )
    : [];
}

function toBackendRow(row: BackendSelect): AiBackendRoutingRow {
  return {
    backendId: row.id,
    backendKey: row.backendKey,
    kind: row.kind as AiModelBackendKind,
    isActive: row.isActive,
    // The column is nullable with a `'unknown'` default; a NULL that read as `healthy` would route to a
    // backend nobody has ever probed. `unknown` is not routable, which is the fail-closed direction.
    lastHealthStatus: (row.lastHealthStatus ?? "unknown") as AiBackendHealthStatus,
    zdrStatus: row.zdrStatus as AiZdrStatus,
    modelVersionPin: row.modelVersionPin,
    supportedModalities: asModalities(row.supportedModalities),
  };
}

/** `ai_model_backend`, read-only on the ordinary tenant handle (see the header). */
export function createDrizzleAiBackendRegistryStore(db: DbClient): AiBackendRegistryStore {
  return {
    async findBackendsByKey(backendKeys) {
      const keys = [...new Set(backendKeys)];
      if (keys.length === 0) return new Map();
      const rows = await db
        .select()
        .from(schema.aiModelBackend)
        .where(inArray(schema.aiModelBackend.backendKey, keys));
      return new Map(rows.map((row) => [row.backendKey, toBackendRow(row)]));
    },
    async listActiveBackends() {
      const rows = await db
        .select()
        .from(schema.aiModelBackend)
        .where(eq(schema.aiModelBackend.isActive, true))
        .orderBy(asc(schema.aiModelBackend.backendKey));
      return rows.map(toBackendRow);
    },
  };
}

/**
 * `ai_capability`, read-only on the ordinary tenant handle (`ai_capability_read` is `USING (true)`).
 *
 * `requiredModality` is ALWAYS `null` here, and that is a schema fact rather than an oversight: §3.2.1
 * declares no modality column, so the registry cannot state one. The routing gate's modality filter is
 * therefore inert on this path — it exists because §3.2.4 gives every BACKEND a
 * `supported_modalities` array, and the day a capability declares what it needs, this is the one line
 * that changes. Returning a guessed `'text'` instead would silently exclude the embedding and
 * classification backends from every chain.
 */
export function createDrizzleAiInvocationCapabilityStore(
  db: DbClient,
): AiInvocationCapabilityStore {
  return {
    async findByKey(capabilityKey) {
      const rows = await db
        .select()
        .from(schema.aiCapability)
        .where(eq(schema.aiCapability.capabilityKey, capabilityKey))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        id: row.id,
        capabilityKey: row.capabilityKey,
        lifecycleState: row.lifecycleState,
        defaultBackendKey: row.defaultBackendKey,
        allowedBackendKeys: asStringArray(row.allowedBackendKeys),
        fallbackChainKeys: asStringArray(row.fallbackChainKeys),
        tenantOverrideAllowed: row.tenantOverrideAllowed,
        tenantOptInRequired: row.tenantOptInRequired,
        currentPromptTemplateKey: row.currentPromptTemplateKey,
        requiredModality: null,
      };
    },
  };
}

/** `ai_routing_override`, tenant-scoped. */
export function createDrizzleAiRoutingOverrideStore(deps: {
  readonly db: DbClient;
  /** `app.user_id` for the session; the M4 write-audit trigger reads it. */
  readonly userId: string;
  /** GAP-161 - same-tx `m32.routing_override.set` emit. */
  readonly events?: M32EventEmitter;
}): AiRoutingOverrideStore {
  const db = deps.db;
  const ctx = (organizationId: string) => ({ organizationId, userId: deps.userId });

  function toOverrideRow(row: OverrideSelect) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      capabilityId: row.capabilityId,
      backendKeyPreference: row.backendKeyPreference,
      overrideReason: row.overrideReason as AiRoutingOverrideReason,
      setByMembershipId: row.setByMembershipId,
      effectiveAt: iso(row.effectiveAt),
      expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
    };
  }

  return {
    async findActiveOverride(organizationId, capabilityId, at) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const when = new Date(at);
        const rows = await tx
          .select()
          .from(schema.aiRoutingOverride)
          .where(
            and(
              eq(schema.aiRoutingOverride.organizationId, organizationId),
              eq(schema.aiRoutingOverride.capabilityId, capabilityId),
              lte(schema.aiRoutingOverride.effectiveAt, when),
              // Expiry is a QUERY predicate, not an index predicate: 0113's EXCLUDE governs which rows
              // may COEXIST, and an index predicate is evaluated at write time, so a row that expired
              // yesterday would still look current to it (M32-T02's finding).
              or(
                isNull(schema.aiRoutingOverride.expiresAt),
                gt(schema.aiRoutingOverride.expiresAt, when),
              ),
            ),
          )
          .orderBy(desc(schema.aiRoutingOverride.effectiveAt))
          .limit(1);
        const row = rows[0];
        if (row === undefined) return null;
        return {
          backendKeyPreference: row.backendKeyPreference,
          effectiveAt: iso(row.effectiveAt),
          expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
        };
      });
    },

    async listOverrides(organizationId) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select()
          .from(schema.aiRoutingOverride)
          .where(eq(schema.aiRoutingOverride.organizationId, organizationId))
          .orderBy(desc(schema.aiRoutingOverride.effectiveAt));
        return rows.map(toOverrideRow);
      });
    },

    async insertOverride(insert) {
      return withOrgContext(db, ctx(insert.organizationId), async (tx) => {
        const [row] = await tx
          .insert(schema.aiRoutingOverride)
          .values({
            organizationId: insert.organizationId,
            capabilityId: insert.capabilityId,
            backendKeyPreference: insert.backendKeyPreference,
            overrideReason: insert.overrideReason,
            setByMembershipId: insert.setByMembershipId,
            effectiveAt: new Date(insert.effectiveAt),
            expiresAt: insert.expiresAt === null ? null : new Date(insert.expiresAt),
          })
          .returning();
        if (row === undefined) {
          throw new Error("ai_routing_override insert returned no row");
        }
        if (deps.events) {
          await deps.events.emitInTx(tx, {
            name: "m32.routing_override.set",
            organizationId: insert.organizationId,
            aggregate: { kind: "ai_routing_override", id: row.id },
            payload: {
              ...(await capabilityIdentity(tx, { id: insert.capabilityId })),
              overrideId: row.id,
              backendKeyPreference: insert.backendKeyPreference,
              overrideReason: insert.overrideReason,
              setByMembershipId: insert.setByMembershipId,
              active: true,
            },
          });
        }
        return toOverrideRow(row);
      });
    },
  };
}

const HITL_EVENT: Partial<Record<AiInvocationHitlOutcome, M32EventName>> = {
  accepted: "m32.output.accepted",
  edited: "m32.output.edited",
  rejected: "m32.output.rejected",
};

/**
 * GAP-161 - the invocation's events, same tx as the ledger row. `invoked` always; a CLOUD call also emits
 * `phi.disclosed` (the section 164.528 feeder - a refusal that never reached a vendor does not), a LOCAL one
 * `local_inference.recorded`. The backend kind is read from the registry row, never inferred from the accrual.
 */
async function emitInvocationEvents(
  events: M32EventEmitter,
  tx: DbClient,
  invocation: AiInvocationInsert,
  invocationId: string,
): Promise<void> {
  const aggregate = { kind: "ai_invocation", id: invocationId } as const;
  const capability = {
    capabilityId: invocation.capabilityId,
    capabilityKey: invocation.capabilityKey,
  };
  await events.emitInTx(tx, {
    name: "m32.capability.invoked",
    organizationId: invocation.organizationId,
    aggregate,
    payload: {
      ...capability,
      invocationId,
      modelBackendId: invocation.backendId,
      backendKey: invocation.backendKey,
      inputTokens: invocation.inputTokenCount,
      outputTokens: invocation.outputTokenCount,
      latencyMs: invocation.durationMs,
      status: invocation.status,
      routingDecision: invocation.routingDecision,
    },
  });
  if (invocation.status === "capability_unavailable") return;
  const [backend] = await tx
    .select({ kind: schema.aiModelBackend.kind })
    .from(schema.aiModelBackend)
    .where(eq(schema.aiModelBackend.id, invocation.backendId))
    .limit(1);
  if (backend?.kind === "cloud") {
    await events.emitInTx(tx, {
      name: "m32.phi.disclosed",
      organizationId: invocation.organizationId,
      aggregate,
      payload: {
        ...capability,
        invocationId,
        patientId: invocation.patientId,
        recipient: invocation.backendKey,
        purpose: invocation.capabilityKey,
        modelBackendId: invocation.backendId,
        zdrConfirmed: invocation.zdrConfirmed,
        disclosedAt: invocation.invokedAt,
      },
    });
  } else if (backend?.kind === "local") {
    await events.emitInTx(tx, {
      name: "m32.local_inference.recorded",
      organizationId: invocation.organizationId,
      aggregate,
      payload: {
        ...capability,
        invocationId,
        modelBackendId: invocation.backendId,
        latencyMs: invocation.durationMs,
      },
    });
  }
}

/** `ai_invocation` + `ai_token_ledger`, tenant-scoped and partitioned. */
export function createDrizzleAiInvocationLedgerStore(deps: {
  readonly db: DbClient;
  /** `app.user_id` for the session; the M4 write-audit trigger reads it. */
  readonly userId: string;
  /** GAP-161 - same-tx `m32.capability.invoked` / `phi.disclosed` / `local_inference.recorded` / `output.*` emits. */
  readonly events?: M32EventEmitter;
}): AiInvocationLedgerStore {
  const db = deps.db;
  const ctx = (organizationId: string) => ({ organizationId, userId: deps.userId });

  return {
    async recordInvocation(invocation, accrual) {
      return withOrgContext(db, ctx(invocation.organizationId), async (tx) => {
        const [row] = await tx
          .insert(schema.aiInvocation)
          .values({
            organizationId: invocation.organizationId,
            providerEntityId: invocation.providerEntityId,
            locationId: invocation.locationId,
            capabilityId: invocation.capabilityId,
            capabilityKey: invocation.capabilityKey,
            promptTemplateId: invocation.promptTemplateId,
            promptTemplateVersion: invocation.promptTemplateVersion,
            backendId: invocation.backendId,
            backendKey: invocation.backendKey,
            modelVersionPin: invocation.modelVersionPin,
            actorMembershipId: invocation.actorMembershipId,
            actorRole: invocation.actorRole,
            patientId: invocation.patientId,
            consumerCorrelationId: invocation.consumerCorrelationId,
            consumerContextRef: invocation.consumerContextRef,
            routingDecision: invocation.routingDecision,
            routingReason: invocation.routingReason,
            promptPayloadCipher: invocation.promptPayloadCipher,
            responsePayloadCipher: invocation.responsePayloadCipher,
            chartContextCipher: invocation.chartContextCipher,
            inputTokenCount: invocation.inputTokenCount,
            outputTokenCount: invocation.outputTokenCount,
            durationMs: invocation.durationMs,
            status: invocation.status,
            errorClass: invocation.errorClass,
            errorMessage: invocation.errorMessage,
            zdrConfirmed: invocation.zdrConfirmed,
            invokedAt: new Date(invocation.invokedAt),
            completedAt: invocation.completedAt === null ? null : new Date(invocation.completedAt),
          })
          .returning({
            id: schema.aiInvocation.id,
            invokedAt: schema.aiInvocation.invokedAt,
          });
        if (row === undefined) {
          throw new Error("ai_invocation insert returned no row");
        }

        if (accrual !== null) {
          await tx.insert(schema.aiTokenLedger).values({
            organizationId: invocation.organizationId,
            invocationId: row.id,
            capabilityId: accrual.capabilityId,
            backendId: accrual.backendId,
            vendorRateAtInvocation: accrual.vendorRateAtInvocation,
            inputTokens: accrual.inputTokens,
            outputTokens: accrual.outputTokens,
            cloudCostUsd: accrual.cloudCostUsd,
            localComputeAttribution: accrual.localComputeAttribution,
            accruedAt: new Date(accrual.accruedAt),
          });
        }

        if (deps.events) await emitInvocationEvents(deps.events, tx, invocation, row.id);

        return { invocationId: row.id, invokedAt: iso(row.invokedAt) };
      });
    },

    async sumTokensInWindow(organizationId, capabilityId, window) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select({
            // COALESCE, because SUM over no rows is NULL and an org with no accruals has spent zero —
            // a number. A NULL that reached `aiTokenCapStateFor` as `NaN` would compare false against
            // every cap and quietly disable the guardrail for exactly the orgs with no history.
            spent: sql<string>`coalesce(sum(${schema.aiTokenLedger.inputTokens} + ${schema.aiTokenLedger.outputTokens}), 0)`,
          })
          .from(schema.aiTokenLedger)
          .where(
            and(
              eq(schema.aiTokenLedger.organizationId, organizationId),
              eq(schema.aiTokenLedger.capabilityId, capabilityId),
              gte(schema.aiTokenLedger.accruedAt, new Date(window.start)),
              // Half-open: the accrual that lands exactly on the next month's first instant belongs to
              // that month's window and that month's partition (`token-cap.ts`).
              sql`${schema.aiTokenLedger.accruedAt} < ${new Date(window.end)}`,
            ),
          );
        return Number(rows[0]?.spent ?? 0);
      });
    },

    async recordHitlOutcome(
      organizationId,
      invocationId,
      invokedAt,
      outcome: AiInvocationHitlOutcome,
    ) {
      await withOrgContext(db, ctx(organizationId), async (tx) => {
        const updated = await tx
          .update(schema.aiInvocation)
          .set({ hitlOutcome: outcome })
          .where(
            and(
              eq(schema.aiInvocation.id, invocationId),
              eq(schema.aiInvocation.organizationId, organizationId),
              // The partition key is part of the composite PK and is NOT derivable from the id; without
              // it this UPDATE scans every monthly partition.
              eq(schema.aiInvocation.invokedAt, new Date(invokedAt)),
            ),
          )
          .returning({
            actorMembershipId: schema.aiInvocation.actorMembershipId,
            capabilityId: schema.aiInvocation.capabilityId,
            capabilityKey: schema.aiInvocation.capabilityKey,
          });
        // An UPDATE that matched nothing is a lost HITL outcome, not a success (the invoked_at partition key
        // must match the stored value exactly).
        const row = updated[0];
        if (!row) throw new Error(`ai_invocation ${invocationId} not found for the HITL outcome`);
        const name = HITL_EVENT[outcome];
        if (deps.events && name) {
          await deps.events.emitInTx(tx, {
            name,
            organizationId,
            aggregate: { kind: "ai_invocation", id: invocationId },
            payload: {
              invocationId,
              capabilityId: row.capabilityId,
              capabilityKey: row.capabilityKey,
              recordedByMembershipId: row.actorMembershipId,
            },
          });
        }
      });
    },
  };
}
