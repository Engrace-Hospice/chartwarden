import type {
  AiActiveRoutingOverride,
  AiBackendRoutingRow,
  AiTokenBudget,
} from "@chartwarden/ai-platform";
// apps/backend/src/modules/32-ai-platform/invocation/store.ts — the data PORTS the M32-T04 invocation
// pipeline composes over, plus an in-memory implementation for the slice tests.
//
// FOUR PORTS, SPLIT BY CREDENTIAL AND BY WHO OWNS THE FACT — the M32-T03 posture, continued:
//
//   · `AiBackendRegistryStore`  — `ai_model_backend` is PLATFORM-SHARED and this port is READ-ONLY.
//     Migration 0116 grants `chartwarden_app` SELECT on it, so the routing gate takes the ordinary tenant
//     handle and needs no bypass. Registration/health writes are `chartwarden_admin` work and belong to the
//     §4.1 R14–R16 admin routes, not to a pipeline that runs on every clinician keystroke.
//   · `AiRoutingOverrideStore`  — `ai_routing_override` is TENANT-SCOPED; every method opens
//     `withOrgContext` and RLS on `app.org_id` is what keeps one agency's sovereignty decision out of
//     the next agency's routing.
//   · `AiInvocationLedgerStore` — `ai_invocation` + `ai_token_ledger`, both TENANT-SCOPED and both
//     partitioned. One port for the two because §1.1 makes them one write ("every `ai_invocation` row
//     drives one or more `ai_token_ledger` entries") and because the ledger row carries no FK to its
//     invocation (both parents are partitioned, §3.2.9's header) — the pairing is a transaction, and a
//     port that let a caller write them separately would make it an intention.
//   · `AiTokenBudgetResolver`   — the budget is M2's fact (`TenantConfiguration`), not M32's. A resolver
//     rather than a table read, because M32 owns no column that holds it.
//
// THE PORTS ARE NARROW: no `db` handle reaches the pipeline service, so every rule in
// `@chartwarden/ai-platform/invocation` is exercised against the in-memory store and the Drizzle
// implementation carries no branch a test cannot reach.
import type {
  AiBackendHealthStatus,
  AiInvocationHitlOutcome,
  AiInvocationStatus,
  AiModelBackendKind,
  AiModelModality,
  AiRoutingDecision,
  AiRoutingOverrideReason,
  AiRoutingReason,
  AiZdrStatus,
} from "@chartwarden/types";

// ── projections ────────────────────────────────────────────────────────────────────────────────────

/** An `ai_routing_override` row as the §5.3.2 panel and the routing gate read it. */
export interface AiRoutingOverrideRowProjection {
  readonly id: string;
  readonly organizationId: string;
  readonly capabilityId: string;
  readonly backendKeyPreference: string;
  readonly overrideReason: AiRoutingOverrideReason;
  readonly setByMembershipId: string;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
}

/** What R17 writes when a tenant admin sets a routing override (§5.3.2). */
export interface AiRoutingOverrideInsert {
  readonly organizationId: string;
  readonly capabilityId: string;
  readonly backendKeyPreference: string;
  readonly overrideReason: AiRoutingOverrideReason;
  readonly setByMembershipId: string;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
}

/**
 * One `ai_invocation` row, complete.
 *
 * THERE IS NO PATCH TYPE, AND THAT IS THE §3.5 CONTRACT SPEAKING. The 0116 immutability trigger freezes
 * `prompt_payload_cipher`, `response_payload_cipher`, `chart_context_cipher`, `input_token_count`,
 * `output_token_count`, `model_version_pin`, `prompt_template_version` and `zdr_confirmed` against every
 * UPDATE except §3.7's shred sentinel — so the row CANNOT be opened before dispatch and closed after it.
 * It is written ONCE, when the outcome is known, and the only later write is `hitl_outcome`.
 *
 * The cost of record-once is a real one and is stated rather than hidden: a process that dies between a
 * vendor answering and this insert leaves a disclosure with no ledger row. The pipeline narrows that
 * window to a single `await` by recording every terminal outcome — including a throw and a timeout — in
 * one place, but it cannot close it without a two-phase row, and a two-phase row is what §3.5 forbids.
 */
export interface AiInvocationInsert {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly capabilityId: string;
  readonly capabilityKey: string;
  readonly promptTemplateId: string | null;
  readonly promptTemplateVersion: string | null;
  readonly backendId: string;
  readonly backendKey: string;
  readonly modelVersionPin: string;
  readonly actorMembershipId: string;
  readonly actorRole: string;
  readonly patientId: string | null;
  readonly consumerCorrelationId: string | null;
  readonly consumerContextRef: Record<string, unknown>;
  readonly routingDecision: AiRoutingDecision;
  readonly routingReason: AiRoutingReason;
  /** DEK-encrypted before it reaches this port (§3.6). Empty for a call that built no prompt. */
  readonly promptPayloadCipher: Buffer;
  readonly responsePayloadCipher: Buffer | null;
  readonly chartContextCipher: Buffer | null;
  readonly inputTokenCount: number;
  readonly outputTokenCount: number;
  readonly durationMs: number;
  readonly status: AiInvocationStatus;
  /** The gate or the failure class. Never PHI: it is a code, not a message. */
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
  readonly zdrConfirmed: boolean;
  readonly invokedAt: string;
  readonly completedAt: string | null;
}

/** One `ai_token_ledger` accrual (§3.2.9). Written in the same transaction as its invocation. */
export interface AiTokenLedgerInsert {
  readonly organizationId: string;
  readonly capabilityId: string;
  readonly backendId: string;
  readonly vendorRateAtInvocation: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cloudCostUsd: string | null;
  readonly localComputeAttribution: string | null;
  readonly accruedAt: string;
}

/** What a recorded invocation reports back. */
export interface AiInvocationRecordResult {
  readonly invocationId: string;
  readonly invokedAt: string;
}

// ── ports ──────────────────────────────────────────────────────────────────────────────────────────

/** `ai_model_backend`, read-only (see the header). */
export interface AiBackendRegistryStore {
  /** Rows for the requested keys. A key with NO registered row is ABSENT from the map — never
   *  defaulted, because a defaulted `local` kind would let a `local_only` tenant route to a backend
   *  nobody registered. */
  findBackendsByKey(
    backendKeys: readonly string[],
  ): Promise<ReadonlyMap<string, AiBackendRoutingRow>>;
  listActiveBackends(): Promise<readonly AiBackendRoutingRow[]>;
}

/** `ai_routing_override`, tenant-scoped. */
export interface AiRoutingOverrideStore {
  /** The override in force AT `at` — §3.2.13's window as a QUERY predicate. The 0113 EXCLUDE governs
   *  which rows may coexist, not which one is current, so currency is decided here and only here. */
  findActiveOverride(
    organizationId: string,
    capabilityId: string,
    at: string,
  ): Promise<AiActiveRoutingOverride | null>;
  listOverrides(organizationId: string): Promise<readonly AiRoutingOverrideRowProjection[]>;
  insertOverride(insert: AiRoutingOverrideInsert): Promise<AiRoutingOverrideRowProjection>;
}

/** `ai_invocation` + `ai_token_ledger`, tenant-scoped and partitioned. */
export interface AiInvocationLedgerStore {
  /** Insert the invocation and, when the call spent tokens, its accrual — in ONE transaction. */
  recordInvocation(
    invocation: AiInvocationInsert,
    accrual: Omit<AiTokenLedgerInsert, "organizationId"> | null,
  ): Promise<AiInvocationRecordResult>;
  /** `SUM(input_tokens + output_tokens)` over `[start, end)` for one capability. Zero when empty —
   *  an org with no accruals has spent nothing, which is a number, not an absence. */
  sumTokensInWindow(
    organizationId: string,
    capabilityId: string,
    window: { readonly start: string; readonly end: string },
  ): Promise<number>;
  /** The ONE legal UPDATE to an invocation (§3.5): the consumer records the human's decision. Needs
   *  `invokedAt` because the composite PK is `(id, invoked_at)` and the partition key is not derivable
   *  from the id — an UPDATE without it scans every partition. */
  recordHitlOutcome(
    organizationId: string,
    invocationId: string,
    invokedAt: string,
    outcome: AiInvocationHitlOutcome,
    guard?: AiHitlOutcomeGuard,
  ): Promise<void>;
}

/**
 * Narrows the one legal UPDATE to the rows a consumer is entitled to decide on (ADR-0095): the row must be THIS actor's call, one of THESE
 * capabilities, about THIS entity, and still open (`pending`, or `accepted` so a later edit can refine it). Without a guard the update is
 * unchanged. A guarded update that matches nothing throws like an unguarded one, so the caller cannot tell "not yours" from "not there".
 */
export interface AiHitlOutcomeGuard {
  readonly actorMembershipId: string;
  readonly capabilityKeys: readonly string[];
  readonly consumerEntityId: string;
}

/**
 * The monthly token budget for one (org, capability) — M2's fact.
 *
 * `null` is NOT "unlimited". It is `budget_unconfigured`, which the cap gate refuses: see
 * `token-cap.ts`'s header for why an absent bound must not become an unbounded one.
 */
export interface AiTokenBudgetResolver {
  budgetFor(organizationId: string, capabilityKey: string): Promise<AiTokenBudget | null>;
}

/**
 * The Phase-1 resolver: answers `null` for everything.
 *
 * No authority states a default token budget — §1.1 says the figure lives on M2's `TenantConfiguration`
 * and calls the Phase-1 defaults "platform constants" without naming one. So the honest binding is the
 * one that refuses, and the dishonest one would be a number invented here that real vendor spend then
 * ran against. When M2 grows the column, this is the single site that changes.
 */
export function createUnconfiguredAiTokenBudgetResolver(): AiTokenBudgetResolver {
  return { budgetFor: async () => null };
}

// ── in-memory implementation (slice tests) ─────────────────────────────────────────────────────────

/** Seed for {@link createInMemoryAiInvocationStores}. */
export interface InMemoryAiInvocationSeed {
  readonly backends?: readonly AiBackendRoutingRow[];
  readonly overrides?: readonly AiRoutingOverrideRowProjection[];
  readonly invocations?: readonly (AiInvocationInsert & { readonly id: string })[];
  readonly accruals?: readonly (AiTokenLedgerInsert & { readonly id: string })[];
}

let inMemorySequence = 0;
function nextId(prefix: string): string {
  inMemorySequence += 1;
  return `${prefix}-${String(inMemorySequence).padStart(6, "0")}`;
}

/**
 * In-memory stores for the slice tests.
 *
 * Holds the two invariants a fake would otherwise silently break and then "pass" on: the invocation
 * ledger is APPEND-ONLY apart from `hitl_outcome` (0116's trigger), and an accrual only ever exists
 * alongside the invocation written in the same call. A fake that let a test mutate a recorded row would
 * prove nothing about the real table.
 */
export function createInMemoryAiInvocationStores(seed: InMemoryAiInvocationSeed = {}): {
  backends: AiBackendRegistryStore;
  overrides: AiRoutingOverrideStore;
  ledger: AiInvocationLedgerStore;
  invocationRows: (AiInvocationInsert & {
    readonly id: string;
    hitlOutcome: AiInvocationHitlOutcome;
  })[];
  accrualRows: (AiTokenLedgerInsert & { readonly id: string })[];
  overrideRows: AiRoutingOverrideRowProjection[];
} {
  const backendRows: AiBackendRoutingRow[] = [...(seed.backends ?? [])];
  const overrideRows: AiRoutingOverrideRowProjection[] = [...(seed.overrides ?? [])];
  const invocationRows: (AiInvocationInsert & {
    readonly id: string;
    hitlOutcome: AiInvocationHitlOutcome;
  })[] = (seed.invocations ?? []).map((row) => ({ ...row, hitlOutcome: "pending" }));
  const accrualRows: (AiTokenLedgerInsert & { readonly id: string })[] = [...(seed.accruals ?? [])];

  const backends: AiBackendRegistryStore = {
    findBackendsByKey: async (keys) => {
      const wanted = new Set(keys);
      const out = new Map<string, AiBackendRoutingRow>();
      for (const row of backendRows) if (wanted.has(row.backendKey)) out.set(row.backendKey, row);
      return out;
    },
    listActiveBackends: async () => backendRows.filter((b) => b.isActive),
  };

  const overrides: AiRoutingOverrideStore = {
    findActiveOverride: async (organizationId, capabilityId, at) => {
      const t = Date.parse(at);
      const hit = overrideRows.find(
        (o) =>
          o.organizationId === organizationId &&
          o.capabilityId === capabilityId &&
          Date.parse(o.effectiveAt) <= t &&
          (o.expiresAt === null || Date.parse(o.expiresAt) > t),
      );
      return hit === undefined
        ? null
        : {
            backendKeyPreference: hit.backendKeyPreference,
            effectiveAt: hit.effectiveAt,
            expiresAt: hit.expiresAt,
          };
    },
    listOverrides: async (organizationId) =>
      overrideRows.filter((o) => o.organizationId === organizationId),
    insertOverride: async (insert) => {
      const row: AiRoutingOverrideRowProjection = { ...insert, id: nextId("aro") };
      overrideRows.push(row);
      return row;
    },
  };

  const ledger: AiInvocationLedgerStore = {
    recordInvocation: async (invocation, accrual) => {
      const id = nextId("ainv");
      invocationRows.push({ ...invocation, id, hitlOutcome: "pending" });
      if (accrual !== null) {
        accrualRows.push({
          ...accrual,
          organizationId: invocation.organizationId,
          id: nextId("atl"),
        });
      }
      return { invocationId: id, invokedAt: invocation.invokedAt };
    },
    sumTokensInWindow: async (organizationId, capabilityId, window) => {
      const start = Date.parse(window.start);
      const end = Date.parse(window.end);
      return accrualRows
        .filter(
          (a) =>
            a.organizationId === organizationId &&
            a.capabilityId === capabilityId &&
            Date.parse(a.accruedAt) >= start &&
            Date.parse(a.accruedAt) < end,
        )
        .reduce((sum, a) => sum + a.inputTokens + a.outputTokens, 0);
    },
    recordHitlOutcome: async (organizationId, invocationId, invokedAt, outcome, guard) => {
      const row = invocationRows.find(
        (r) =>
          r.id === invocationId &&
          r.organizationId === organizationId &&
          r.invokedAt === invokedAt &&
          (guard === undefined ||
            (r.actorMembershipId === guard.actorMembershipId &&
              guard.capabilityKeys.includes(r.capabilityKey) &&
              r.consumerContextRef.entityId === guard.consumerEntityId &&
              (r.hitlOutcome === "pending" || r.hitlOutcome === "accepted"))),
      );
      if (row === undefined) {
        throw new Error(
          `in-memory ai_invocation ${invocationId} not found for org ${organizationId}`,
        );
      }
      row.hitlOutcome = outcome;
    },
  };

  return { backends, overrides, ledger, invocationRows, accrualRows, overrideRows };
}

/** Re-exported so a test seeding the registry needs one import. */
export type {
  AiActiveRoutingOverride,
  AiBackendRoutingRow,
  AiBackendHealthStatus,
  AiModelBackendKind,
  AiModelModality,
  AiTokenBudget,
  AiZdrStatus,
};
