// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/resolver.ts — the per-organization clearinghouse
// binding (ADR-0053 D3 amended 2026-11-06). Today's `ClearinghouseBinding` is one transport for the whole platform; this
// returns a binding whose `forOrg(orgId)` hands every consumer THAT ORGANIZATION'S transport, built from its own sealed
// credential:
//   a row, `active`, stedi | claimmd   the vendor's transport over the tenant's own credential and mode;
//   a row, `outside`                   UNBOUND (`unboundReason: outside`: the tenant bills elsewhere, nothing is ever sent);
//   a row, draft / verified            UNBOUND (`not_active`: not live yet; workers HOLD until the tenant finishes setup);
//   no row, named in the env fallback  the platform's own env binding (the demo tenant), exactly as before;
//   no row otherwise                   UNBOUND (`not_chosen`: workers HOLD until the tenant chooses).
// The top-level `vendor` / `transport` are UNBOUND on purpose: they say nothing about any organization, so a consumer that
// forgot to resolve per org fails closed (CH_NOT_WIRED), never sends through someone else's account.
//
// Every call re-reads the org's row (one indexed lookup, RLS-scoped by `withOrgContext`) and rebuilds the transport only
// when the row's `version` moved, so a changed credential or vendor takes effect on the next call and a decrypt happens
// once per change. Relay ticks and workers are not requests: this never reads a request context. A transport whose
// credential cannot be opened THROWS (the job fails and retries, loudly) rather than going unbound silently.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, type TenantClearinghouseMode } from "@chartwarden/types";
import {
  type ClaimMdAnomaly,
  type ClaimMdRequestCounter,
  type ClearinghouseBinding,
  NOT_WIRED_TRANSPORT,
  type StediAnomaly,
  type SubmissionAttemptStore,
  UNBOUND_NOT_ACTIVE,
  UNBOUND_NOT_CHOSEN,
  UNBOUND_OUTSIDE,
  createClaimMdTransportFromEnv,
  createStediTransportFromEnv,
} from "@chartwarden/x12-837-client";
import { eq } from "drizzle-orm";
import type { ConfigRow } from "./config-store";
import { bindTransportToOrg } from "./org-bound-transport";
import type { ClearinghouseSecretCipher } from "./secret-cipher";

/** The one typed refusal for a stored credential that cannot be used: a route surfaces it as 503, never a bare 500. */
const credentialUnreadable = (): ChartWardenError =>
  new ChartWardenError(
    "CLEARINGHOUSE_CREDENTIAL_UNREADABLE",
    "this organization's clearinghouse credential could not be opened; it must be entered again",
    503,
  );

export interface TenantBindingDeps {
  /** The TENANT pool (NOBYPASSRLS): the read is bound by the org's own RLS scope. */
  readonly db: DbClient;
  readonly cipher?: ClearinghouseSecretCipher | undefined;
  /** The durable attempt store the transports front the vendor with (scoped per org / provider entity / usage). */
  readonly attempts: SubmissionAttemptStore;
  /** The platform's env binding that serves the orgs named in `fallbackOrgIds`; unbound when none is configured. */
  readonly platformBinding: ClearinghouseBinding;
  readonly fallbackOrgIds: ReadonlySet<string>;
  /** A transport signal (ids and codes only) with the organization whose account raised it. */
  readonly onAnomaly?: (
    anomaly: StediAnomaly | ClaimMdAnomaly,
    context: { readonly organizationId: string },
  ) => void;
  /** Claim.MD's request budget (shared Valkey counter); each tenant's account spends its own budget. */
  readonly claimMdRequestCounter?: ClaimMdRequestCounter | null;
  /** Test seam: replaces the RLS-scoped Drizzle read of the org's row. */
  readonly readRow?: (organizationId: string) => Promise<ConfigRow | null>;
}

export interface TenantClearinghouseRuntime {
  readonly binding: ClearinghouseBinding;
  /** The vendor mode of an org's live config, or null when it has none (env usage then applies). */
  readonly usageFor: (organizationId: string) => Promise<TenantClearinghouseMode | null>;
}

const C = schema.tenantClearinghouseConfig;

/** The anomaly sink of ONE organization's transport: every signal arrives with that organization's id (undefined when none is set). */
export function withOrgOnAnomaly(
  sink: TenantBindingDeps["onAnomaly"],
  organizationId: string,
): ((anomaly: StediAnomaly | ClaimMdAnomaly) => void) | undefined {
  return sink ? (anomaly) => sink(anomaly, { organizationId }) : undefined;
}

/** One account's own counter: Claim.MD limits a request rate per ACCOUNT, and every tenant now has its own. */
function scopedCounter(
  counter: ClaimMdRequestCounter,
  organizationId: string,
): ClaimMdRequestCounter {
  return {
    increment: (key, windowMs) => counter.increment(`${key}:org:${organizationId}`, windowMs),
  };
}

export function createTenantClearinghouseRuntime(
  deps: TenantBindingDeps,
): TenantClearinghouseRuntime {
  const built = new Map<
    string,
    { readonly version: number; readonly binding: ClearinghouseBinding }
  >();

  const readRow = (organizationId: string): Promise<ConfigRow | null> =>
    deps.readRow?.(organizationId) ??
    withOrgContext(deps.db, { organizationId, userId: "" }, async (tx) => {
      const [row] = await (tx as unknown as DbClient)
        .select()
        .from(C)
        .where(eq(C.organizationId, organizationId))
        .limit(1);
      return row ?? null;
    });

  async function build(row: ConfigRow): Promise<ClearinghouseBinding> {
    const vendor = row.vendor;
    const mode = row.mode;
    if (
      (vendor !== "stedi" && vendor !== "claimmd") ||
      (mode !== "test" && mode !== "production")
    ) {
      return UNBOUND_OUTSIDE;
    }
    if (!deps.cipher || !row.secretCipher) throw credentialUnreadable();
    let secret: string;
    try {
      secret = await deps.cipher.decrypt(row.organizationId, { vendor, mode }, row.secretCipher);
    } catch {
      throw credentialUnreadable(); // the cause is the cipher's generic refusal; nothing about the key leaks
    }
    const sink = withOrgOnAnomaly(deps.onAnomaly, row.organizationId);
    const onAnomaly = sink ? { onAnomaly: sink } : {};
    const transport =
      vendor === "stedi"
        ? createStediTransportFromEnv({ STEDI_API_KEY: secret }, deps.attempts, onAnomaly)
        : createClaimMdTransportFromEnv(
            { CLAIMMD_ACCOUNT_KEY: secret, CLAIMMD_ACCOUNT_USAGE: mode },
            deps.attempts,
            {
              ...onAnomaly,
              ...(deps.claimMdRequestCounter
                ? { requestCounter: scopedCounter(deps.claimMdRequestCounter, row.organizationId) }
                : {}),
            },
          );
    // Bound to this organization: a call naming another one is refused before it reaches the vendor.
    return { vendor, transport: bindTransportToOrg(transport, row.organizationId) };
  }

  async function forOrg(organizationId: string): Promise<ClearinghouseBinding> {
    const row = await readRow(organizationId);
    if (!row) {
      built.delete(organizationId);
      return deps.fallbackOrgIds.has(organizationId.toLowerCase())
        ? deps.platformBinding
        : UNBOUND_NOT_CHOSEN;
    }
    if (row.status !== "active") {
      built.delete(organizationId);
      return UNBOUND_NOT_ACTIVE;
    }
    const cached = built.get(organizationId);
    if (cached && cached.version === row.version) return cached.binding;
    const binding = await build(row);
    built.set(organizationId, { version: row.version, binding });
    return binding;
  }

  return {
    // The top level is deliberately unbound: only `forOrg` names an organization's transport.
    binding: { vendor: null, transport: NOT_WIRED_TRANSPORT, forOrg },
    async usageFor(organizationId) {
      const row = await readRow(organizationId);
      return row?.status === "active" && (row.mode === "test" || row.mode === "production")
        ? row.mode
        : null;
    },
  };
}
