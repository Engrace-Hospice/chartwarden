// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/service-types.ts — the shapes of the tenant clearinghouse service
// (`service.ts`): who acts, what a put / verify carries, the config view, the service's dependencies and its surface. Types only; the
// rules live in the service.
import type {
  TenantClearinghouseMode,
  TenantClearinghouseStatus,
  TenantClearinghouseVendor,
  TransmittingClearinghouseVendor,
} from "@chartwarden/types";
import type { ConnectionProbeOutcome } from "@chartwarden/x12-837-client";
import type { BaaPin, BaaView, RecordBaaInput } from "./baa";
import type { ConfigStore } from "./config-store";
import type { ClearinghouseSecretCipher } from "./secret-cipher";

/** Who acts: server-assembled from the session (a tenant admin, or the platform operator acting for the tenant). */
export interface ClearinghouseActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
  /**
   * `platform` only for the platform-ops lane (it records a reason and is the only lane that may set test mode in production).
   * Absent = the tenant's own lane: the safe default for anything that did not say.
   */
  readonly lane?: "platform";
}

export interface PutClearinghouseInput {
  readonly vendor: TenantClearinghouseVendor;
  readonly mode?: TenantClearinghouseMode;
  /** The vendor credential, write-only. Required with a first choice and with any vendor or mode change. */
  readonly secret?: string;
}

/** The env vendor serving an organization the operator named in `CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS`. */
export interface PlatformFallback {
  readonly vendor: "stedi" | "claimmd" | "direct_mac" | "in_memory";
  readonly mode: TenantClearinghouseMode;
}

/** A vendor's safe connection test: given the credential, an outcome. A vendor with none is verified by attestation. */
export type ConnectionProbe = (
  secret: string,
  mode: TenantClearinghouseMode,
) => Promise<ConnectionProbeOutcome>;
export type ClearinghouseProbes = Readonly<
  Partial<Record<TransmittingClearinghouseVendor, ConnectionProbe>>
>;

/** Work an org still has waiting on its current vendor. A switch is refused while any of it is queued. */
export interface WaitingWork {
  readonly claims: number;
  readonly commercialSubmissions: number;
}

export interface VerifyClearinghouseInput {
  readonly evidenceNote?: string;
  /** Required with an attestation: the person confirms the evidence note names no patient information. */
  readonly confirmNoPatientInformation?: boolean;
}

export interface ClearinghouseConfigView {
  readonly vendor: TenantClearinghouseVendor | PlatformFallback["vendor"] | null;
  readonly mode: TenantClearinghouseMode | null;
  readonly status: TenantClearinghouseStatus | null;
  readonly source: "tenant" | "platform_env" | "none";
  readonly hasSecret: boolean;
  /** How `verify` works for this vendor: a connection test, or an attestation with evidence. */
  readonly verifiableBy: "connection_test" | "attestation" | null;
  readonly verification: {
    readonly kind: "connection_test" | "attested";
    readonly evidence: string | null;
    readonly verifiedAt: string;
  } | null;
  readonly lastTest: {
    readonly outcome: "ok" | "credential_rejected" | "unreachable";
    readonly at: string;
  } | null;
  /** True for a tenant-held vendor account: it needs a recorded and operator-verified BAA before it may go active. */
  readonly baaRequired: boolean;
  readonly baa: BaaView | null;
  readonly activatedAt: string | null;
  readonly version: number | null;
  readonly updatedAt: string | null;
}

export interface TenantClearinghouseServiceDeps {
  readonly cipher?: ClearinghouseSecretCipher;
  readonly probes: ClearinghouseProbes;
  readonly now?: () => Date;
  /** The env binding that serves this org when it has no row, or null (the org is not named in the fallback list). */
  readonly platformFallback?: (organizationId: string) => PlatformFallback | null;
  /** NODE_ENV is production: the tenant lane may not choose test mode (only platform ops may, with a recorded reason). */
  readonly isProduction?: boolean;
  /**
   * Queued work the org still has on its vendor (M23 claims, M41 submissions); absent = nothing is checked. `tx` is the store's open
   * transaction (undefined for the in-memory store): the count reads on it, so a switch holds ONE pooled connection while the config
   * row is locked. Only an ACTIVE config is asked: nothing else can drain the work, so counting it would strand the tenant. Queued
   * NOE / NOTR / transfer notices are deliberately not counted: a worker re-resolves the org's transport when it runs, so a notice
   * transmits through the new vendor (or parks for `outside`), and holding a switch could cost the 5-day filing deadline.
   */
  readonly waitingWork?: (organizationId: string, tx: ConfigStore["tx"]) => Promise<WaitingWork>;
  /**
   * Whether the org holds a pricing contract that is not canceled, live or PAUSED (M35; absent = a deployment without pricing, so none; a
   * paused contract is still the tenant's and bills again on resume). A tenant that bills outside
   * ChartWarden is on billing mode none, so leaving `outside` also means choosing the billing mode the vendor billing calls for: only a
   * platform operator may do that (the operator's flow sets the mode with the vendor), so the tenant's own switch is refused while a
   * contract exists. `tx` is the store's open transaction (undefined for the in-memory store): read on it, not on a second connection.
   */
  readonly hasPricingContract?: (organizationId: string, tx: ConfigStore["tx"]) => Promise<boolean>;
  /** Cause logging for a failure the caller is told about only in general terms (`err` goes to the redacting logger). */
  readonly warn?: (message: string, context: Record<string, unknown>) => void;
}

/** What `prepareVerify` read: everything `completeVerify` needs, so no store call is open while the vendor is called. */
export interface VerifyPlan {
  /** The row version the plan was read at; `completeVerify` compare-and-sets on it. */
  readonly version: number;
  readonly vendor: TransmittingClearinghouseVendor;
  readonly mode: TenantClearinghouseMode;
  /** Attestation (the vendor has no safe probe): the normalised evidence note. Null when a probe runs. */
  readonly evidence: string | null;
  /** Probe: the unsealed credential. Held in memory for the one call; never logged, audited or returned. */
  readonly secret: string | null;
}

export interface PutResult {
  readonly created: boolean;
  readonly view: ClearinghouseConfigView;
  /** Names of the fields the put changed (never values), for the field-level audit row. */
  readonly changedFields: readonly string[];
}

export interface TenantClearinghouseService {
  view(store: ConfigStore, organizationId: string): Promise<ClearinghouseConfigView>;
  /**
   * Every refusal `put` would make before it writes, WITHOUT writing: the body's own rules, the If-Match, the switch's locks and a
   * missing credential, read on `store` with no row lock. A caller that must do something else FIRST (an operator's switch out of
   * outside sets the billing mode before the vendor) asks this first, so a plain input error writes nothing. `put` still judges all of
   * it again under the row lock: this is the early refusal, not the authority.
   */
  checkPut(
    store: ConfigStore,
    actor: ClearinghouseActor,
    input: PutClearinghouseInput,
    expectedVersion: number | undefined,
  ): Promise<void>;
  put(
    store: ConfigStore,
    actor: ClearinghouseActor,
    input: PutClearinghouseInput,
    expectedVersion: number | undefined,
  ): Promise<PutResult>;
  recordBaa(
    store: ConfigStore,
    actor: ClearinghouseActor,
    input: RecordBaaInput,
  ): Promise<{ readonly view: ClearinghouseConfigView; readonly changedFields: readonly string[] }>;
  /** The platform operator verifies the tenant's recorded BAA. */
  /**
   * `expected.recordedAt` is the `baa.recordedAt` of the record the operator READ: the verification applies to that record or
   * to nothing (409 CLEARINGHOUSE_BAA_CHANGED when the tenant has since recorded another).
   */
  verifyBaa(
    store: ConfigStore,
    actor: ClearinghouseActor,
    expected: BaaPin,
  ): Promise<ClearinghouseConfigView>;
  /** Step 1: read-only, no lock. */
  prepareVerify(
    store: ConfigStore,
    actor: ClearinghouseActor,
    input: VerifyClearinghouseInput,
  ): Promise<VerifyPlan>;
  /** Step 2: the vendor call (no store, no transaction). Null when the plan is an attestation. */
  runProbe(plan: VerifyPlan): Promise<ConnectionProbeOutcome | null>;
  /** Step 3: lock, compare-and-set on the plan's version, record. */
  completeVerify(
    store: ConfigStore,
    actor: ClearinghouseActor,
    plan: VerifyPlan,
    outcome: ConnectionProbeOutcome | null,
  ): Promise<{
    readonly view: ClearinghouseConfigView;
    readonly test: { readonly outcome: ConnectionProbeOutcome } | null;
  }>;
  activate(store: ConfigStore, actor: ClearinghouseActor): Promise<ClearinghouseConfigView>;
}

/** Opens one transaction and hands the callback a store bound to it (each call is its own transaction). */
export type ConfigTx = <T>(fn: (store: ConfigStore) => Promise<T>) => Promise<T>;
