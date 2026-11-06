// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/service.ts — the rules of a tenant's clearinghouse
// config (ADR-0053 amendment 2026-11-06). Pure of transport and HTTP: every method takes a `ConfigStore` bound to one open
// org-scoped transaction, so the tenant's own routes and a platform operator's onboarding writes run the SAME code under
// the tenant's own RLS, and a rule is tested without a database.
//
//   put        choose stedi | claimmd | outside, its mode and its credential. ANY change (a vendor or mode change, a first
//              choice, or a credential rotation) starts the config at `draft` for the new key (owner decision D6): what the old
//              key earned (the connection test, the activation) is cleared, and claims work holds until it is re-verified and
//              re-activated. A change of VENDOR also voids the vendor BAA (a new agreement); a same-vendor change keeps it.
//              `outside` is stored `active`: nothing to verify. Once a PRODUCTION submission exists for the org, vendor and mode
//              are locked (409), and a switch away from a vendor is refused while claims or submissions are queued.
//   recordBaa  the TENANT records its own vendor BAA (effective date, a screened document reference; owner decision D2).
//   verifyBaa  a platform OPERATOR verifies that record; activation refuses (409 CLEARINGHOUSE_BAA_NOT_VERIFIED) until then.
//   verify     draft -> verified, in three steps that never hold a transaction across the vendor call: `prepareVerify` reads and
//              decrypts (read-only, no lock), `runProbe` calls the vendor with no transaction open, `completeVerify` locks the
//              row and compare-and-sets on the version it read (409 when the config moved meanwhile). Where the vendor has a
//              safe no-PHI probe (Claim.MD `uploadlist`) the probe runs; where it has none (Stedi) the caller attests with an
//              evidence note and the confirmation that it names no patient. Recorded as `connection_test` / `attested`.
//   activate   verified -> active, only with a verified BAA: claims and eligibility work is allowed (the gate reads this).
//
// The credential is write-only: no view carries it (a `hasSecret` flag is derived). Nothing here logs or audits a value; the
// row's M4 write-audit trigger records that the secret changed, never what it was.
import { medicareReceiptDay } from "@chartwarden/billing";
import {
  ChartWardenError,
  type TenantClearinghouseMode,
  type TenantClearinghouseStatus,
  type TenantClearinghouseVendor,
  type TransmittingClearinghouseVendor,
} from "@chartwarden/types";
import type { ConnectionProbeOutcome } from "@chartwarden/x12-837-client";
import {
  BAA_CLEARED,
  BAA_VERIFICATION_CLEARED,
  type BaaPin,
  type BaaView,
  type RecordBaaInput,
  baaMatchesPin,
  baaViewOf,
  normalizeBaaInput,
  sameBaa,
} from "./baa";
import type { ConfigPatch, ConfigRow, ConfigStore } from "./config-store";
import { isUniqueViolation } from "./config-store";
import { invalid, screenedText } from "./screening";
import type { ClearinghouseSecretCipher } from "./secret-cipher";

export type { BaaPin, RecordBaaInput } from "./baa";

export const EVIDENCE_MIN = 8;
export const EVIDENCE_MAX = 500;
const SECRET_SHAPE = /^[\x21-\x7e]{8,512}$/; // printable ASCII, no whitespace (Claim.MD keys hold # and *)

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

/**
 * The verify flow across its two transactions: read and decrypt, probe with NO transaction open, then lock and write. A
 * probe is a network call to the vendor: it must never run while a row lock or a pooled connection is held.
 */
export async function verifyConnection(
  service: TenantClearinghouseService,
  tx: ConfigTx,
  actor: ClearinghouseActor,
  input: VerifyClearinghouseInput,
): Promise<{
  readonly view: ClearinghouseConfigView;
  readonly test: { readonly outcome: ConnectionProbeOutcome } | null;
}> {
  const plan = await tx((store) => service.prepareVerify(store, actor, input));
  const outcome = await service.runProbe(plan);
  return tx((store) => service.completeVerify(store, actor, plan, outcome));
}

const conflict = (code: string, message: string): ChartWardenError =>
  new ChartWardenError(code, message, 409);
const versionConflict = (message: string): ChartWardenError =>
  new ChartWardenError("VERSION_CONFLICT", message, 412);

const isTransmitting = (vendor: string): vendor is TransmittingClearinghouseVendor =>
  vendor === "stedi" || vendor === "claimmd";

/** Evidence the operator typed: whitespace folded, control characters dropped, length-bounded, never a patient identifier. */
export function normalizeEvidence(raw: unknown): string {
  return screenedText(raw, {
    field: "evidenceNote",
    min: EVIDENCE_MIN,
    max: EVIDENCE_MAX,
    lengthCode: "CLEARINGHOUSE_EVIDENCE_REQUIRED",
    lengthMessage: `evidenceNote must be ${EVIDENCE_MIN}-${EVIDENCE_MAX} characters: say what was checked and by whom`,
    phiMessage:
      "evidenceNote looks like it contains a patient identifier; describe what was checked without naming a patient",
  });
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
/** What a put changed, by field name. */
function changedFieldsOf(existing: ConfigRow | null, input: PutClearinghouseInput): string[] {
  const changed: string[] = [];
  if (!existing || existing.vendor !== input.vendor) changed.push("vendor");
  const mode = input.vendor === "outside" ? null : (input.mode ?? null);
  if ((existing?.mode ?? null) !== mode) changed.push("mode");
  if (input.secret !== undefined) changed.push("secret");
  return changed;
}

/** Everything a credential the vendor has not been shown yet has NOT earned: back to draft, verification and activation gone. */
const BACK_TO_DRAFT = {
  status: "draft",
  verificationKind: null,
  verificationEvidence: null,
  verifiedAt: null,
  verifiedByMembershipId: null,
  lastTestAt: null,
  lastTestOutcome: null,
  activatedAt: null,
  activatedByMembershipId: null,
} as const satisfies ConfigPatch;

export function createTenantClearinghouseService(
  deps: TenantClearinghouseServiceDeps,
): TenantClearinghouseService {
  const now = deps.now ?? (() => new Date());

  const verifiableBy = (vendor: string | null): ClearinghouseConfigView["verifiableBy"] => {
    if (vendor === null || !isTransmitting(vendor)) return null;
    return deps.probes[vendor] ? "connection_test" : "attestation";
  };

  function viewOf(row: ConfigRow | null, organizationId: string): ClearinghouseConfigView {
    if (!row) {
      const fb = deps.platformFallback?.(organizationId) ?? null;
      return {
        vendor: fb?.vendor ?? null,
        mode: fb?.mode ?? null,
        status: fb ? "active" : null,
        source: fb ? "platform_env" : "none",
        hasSecret: false,
        verifiableBy: null,
        verification: null,
        lastTest: null,
        baaRequired: false,
        baa: null,
        activatedAt: null,
        version: null,
        updatedAt: null,
      };
    }
    return {
      vendor: row.vendor as TenantClearinghouseVendor,
      mode: row.mode as TenantClearinghouseMode | null,
      status: row.status as TenantClearinghouseStatus,
      source: "tenant",
      hasSecret: row.secretCipher !== null,
      verifiableBy: verifiableBy(row.vendor),
      verification:
        row.verificationKind && row.verifiedAt
          ? {
              kind: row.verificationKind as "connection_test" | "attested",
              evidence: row.verificationEvidence,
              verifiedAt: row.verifiedAt.toISOString(),
            }
          : null,
      lastTest:
        row.lastTestOutcome && row.lastTestAt
          ? {
              outcome: row.lastTestOutcome as "ok" | "credential_rejected" | "unreachable",
              at: row.lastTestAt.toISOString(),
            }
          : null,
      baaRequired: isTransmitting(row.vendor),
      baa: baaViewOf(row),
      activatedAt: iso(row.activatedAt),
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  const requireCipher = (): ClearinghouseSecretCipher => {
    if (!deps.cipher) {
      throw new ChartWardenError(
        "CLEARINGHOUSE_CIPHER_UNBOUND",
        "clearinghouse credentials cannot be stored: no encryption key is configured in this deployment",
        503,
      );
    }
    return deps.cipher;
  };

  function validatePut(actor: ClearinghouseActor, input: PutClearinghouseInput): void {
    if (input.vendor === "outside") {
      if (input.mode !== undefined || input.secret !== undefined) {
        throw invalid(
          "vendor",
          "CLEARINGHOUSE_OUTSIDE_TAKES_NO_SETTINGS",
          "billing outside ChartWarden takes no mode and no credential",
        );
      }
      return;
    }
    if (input.mode === undefined) {
      throw invalid("mode", "CLEARINGHOUSE_MODE_REQUIRED", "mode (test or production) is required");
    }
    if (deps.isProduction && actor.lane !== "platform" && input.mode === "test") {
      throw invalid(
        "mode",
        "CLEARINGHOUSE_TEST_MODE_NOT_ALLOWED",
        "test mode is not available on a production deployment; choose production, or ask platform support",
      );
    }
    if (input.secret !== undefined && !SECRET_SHAPE.test(input.secret)) {
      throw invalid(
        "secret",
        "CLEARINGHOUSE_SECRET_INVALID",
        "the credential must be 8-512 printable characters with no spaces",
      );
    }
  }

  /** The patch that puts a row on `input`: a draft for a transmitting vendor, active for `outside`. */
  async function patchFor(
    actor: ClearinghouseActor,
    existing: ConfigRow | null,
    input: PutClearinghouseInput,
  ): Promise<ConfigPatch> {
    const base = { vendor: input.vendor, setByMembershipId: actor.membershipId, updatedAt: now() };
    if (input.vendor === "outside") {
      return {
        ...base,
        ...BACK_TO_DRAFT,
        ...BAA_CLEARED,
        mode: null,
        status: "active",
        secretCipher: null,
        secretDekVersion: null,
      };
    }
    const mode = input.mode as TenantClearinghouseMode;
    const sealed = input.secret
      ? await requireCipher().encrypt(actor.organizationId, input.secret, {
          vendor: input.vendor,
          mode,
        })
      : null;
    return {
      ...base,
      ...BACK_TO_DRAFT,
      // the vendor BAA survives anything but a change of vendor
      ...(existing?.vendor === input.vendor ? {} : BAA_CLEARED),
      mode,
      secretCipher: sealed?.cipher ?? null,
      secretDekVersion: sealed?.dekVersion ?? null,
    };
  }

  async function save(store: ConfigStore, row: ConfigRow, patch: ConfigPatch): Promise<ConfigRow> {
    const updated = await store.update(row.organizationId, row.version, {
      ...patch,
      updatedAt: now(),
    });
    if (!updated)
      throw versionConflict("the clearinghouse config changed while it was being updated");
    return updated;
  }

  async function lockedRow(store: ConfigStore, organizationId: string): Promise<ConfigRow> {
    const row = await store.findForUpdate(organizationId);
    if (!row) {
      throw conflict(
        "CLEARINGHOUSE_NOT_CONFIGURED",
        "no clearinghouse has been chosen for this organization yet",
      );
    }
    return row;
  }

  /** A transmitting config only: `outside` has no vendor account, so no BAA to record or verify. */
  function requireVendorAccount(row: ConfigRow): void {
    if (isTransmitting(row.vendor)) return;
    throw new ChartWardenError(
      "CLEARINGHOUSE_BAA_NOT_APPLICABLE",
      "billing outside ChartWarden has no vendor account, so there is no vendor BAA to record",
      422,
    );
  }

  /** The first choice: no row yet, so no If-Match, and the credential is required. */
  async function createFirst(
    store: ConfigStore,
    actor: ClearinghouseActor,
    input: PutClearinghouseInput,
    expectedVersion: number | undefined,
  ): Promise<PutResult> {
    const { organizationId } = actor;
    if (expectedVersion !== undefined) {
      throw versionConflict(
        "no clearinghouse config exists for this organization; omit If-Match to create it",
      );
    }
    if (input.vendor !== "outside" && input.secret === undefined) {
      throw invalid(
        "secret",
        "CLEARINGHOUSE_SECRET_REQUIRED",
        "the vendor credential is required with a first choice",
      );
    }
    const patch = await patchFor(actor, null, input);
    try {
      const row = await store.insert({
        organizationId,
        vendor: input.vendor,
        setByMembershipId: actor.membershipId,
        ...patch,
        version: 1,
      });
      return {
        created: true,
        view: viewOf(row, organizationId),
        changedFields: changedFieldsOf(null, input),
      };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      throw versionConflict(
        "a clearinghouse config was created concurrently; read it and send its version in If-Match",
      );
    }
  }

  /** The locks on a switch: production submissions in flight, and claims or submissions still queued on the old vendor. */
  async function assertSwitchAllowed(
    store: ConfigStore,
    existing: ConfigRow,
    organizationId: string,
  ): Promise<void> {
    if (existing.vendor === "outside") return; // nothing was ever sent through a vendor
    if (await store.hasProductionAttempts(organizationId)) {
      throw conflict(
        "CLEARINGHOUSE_VENDOR_LOCKED",
        "this organization has production submissions in flight; its vendor and mode cannot change until an operator migrates them",
      );
    }
    // A config that is not active sends nothing and cannot drain what waits (the workers hold it), so the queue does not lock it:
    // refusing the switch would leave the tenant with no way out (re-review M3).
    if (existing.status !== "active") return;
    const waiting = await deps.waitingWork?.(organizationId, store.tx);
    if (waiting && waiting.claims + waiting.commercialSubmissions > 0) {
      throw new ChartWardenError(
        "CLEARINGHOUSE_WORK_WAITING",
        "claims or submissions are still queued on the current clearinghouse; let them finish before changing it",
        409,
        [
          { field: "claims", code: "COUNT", message: String(waiting.claims) },
          {
            field: "commercialSubmissions",
            code: "COUNT",
            message: String(waiting.commercialSubmissions),
          },
        ],
      );
    }
  }

  async function changeExisting(
    store: ConfigStore,
    actor: ClearinghouseActor,
    existing: ConfigRow,
    input: PutClearinghouseInput,
    expectedVersion: number | undefined,
  ): Promise<PutResult> {
    const { organizationId } = actor;
    if (expectedVersion === undefined) {
      throw new ChartWardenError(
        "IF_MATCH_REQUIRED",
        "an If-Match header is required on this route",
        428,
      );
    }
    if (expectedVersion !== existing.version) {
      throw versionConflict("the clearinghouse config changed since it was read");
    }
    const target = input.vendor === "outside" ? null : (input.mode ?? null);
    const retargeted = existing.vendor !== input.vendor || existing.mode !== target;
    if (!retargeted && input.secret === undefined) {
      return { created: false, view: viewOf(existing, organizationId), changedFields: [] }; // nothing changes
    }
    if (retargeted) await assertSwitchAllowed(store, existing, organizationId);
    if (retargeted && input.vendor !== "outside" && input.secret === undefined) {
      throw invalid(
        "secret",
        "CLEARINGHOUSE_SECRET_REQUIRED",
        "a new vendor or mode needs its own credential",
      );
    }
    const row = await save(store, existing, await patchFor(actor, existing, input));
    return {
      created: false,
      view: viewOf(row, organizationId),
      changedFields: changedFieldsOf(existing, input),
    };
  }

  return {
    async view(store, organizationId) {
      return viewOf(await store.find(organizationId), organizationId);
    },

    async put(store, actor, input, expectedVersion) {
      validatePut(actor, input);
      const existing = await store.findForUpdate(actor.organizationId);
      return existing
        ? changeExisting(store, actor, existing, input, expectedVersion)
        : createFirst(store, actor, input, expectedVersion);
    },

    async recordBaa(store, actor, input) {
      const record = normalizeBaaInput(input, medicareReceiptDay(now()));
      const row = await lockedRow(store, actor.organizationId);
      requireVendorAccount(row);
      if (sameBaa(row, record)) {
        return { view: viewOf(row, actor.organizationId), changedFields: [] };
      }
      const saved = await save(store, row, {
        // the vendor the record is for: the table keeps a live config on a BAA for ITS vendor (requireVendorAccount: not `outside`)
        baaVendor: row.vendor,
        baaEffectiveDate: record.effectiveDate,
        baaDocumentRef: record.documentRef,
        baaRecordedAt: now(),
        baaRecordedByMembershipId: actor.membershipId,
        // a changed record has not been looked at: the operator verifies it again
        ...BAA_VERIFICATION_CLEARED,
        // a live config cannot rest on an unverified BAA: it waits at `verified` until the operator re-verifies
        ...(row.status === "active"
          ? { status: "verified", activatedAt: null, activatedByMembershipId: null }
          : {}),
      });
      return { view: viewOf(saved, actor.organizationId), changedFields: ["baa"] };
    },

    async verifyBaa(store, actor, expected) {
      const row = await lockedRow(store, actor.organizationId);
      requireVendorAccount(row);
      if (!row.baaRecordedAt) {
        throw conflict(
          "CLEARINGHOUSE_BAA_NOT_RECORDED",
          "the tenant has not recorded its vendor BAA yet",
        );
      }
      if (!baaMatchesPin(row, expected)) {
        throw conflict(
          "CLEARINGHOUSE_BAA_CHANGED",
          "the tenant's BAA record changed since it was read; read it again and verify what it now says",
        );
      }
      if (row.baaVerifiedAt) return viewOf(row, actor.organizationId); // idempotent
      const saved = await save(store, row, {
        baaVerifiedAt: now(),
        baaVerifiedByMembershipId: actor.membershipId,
      });
      return viewOf(saved, actor.organizationId);
    },

    async prepareVerify(store, actor, input) {
      const { organizationId } = actor;
      const row = await store.find(organizationId);
      if (!row) {
        throw conflict(
          "CLEARINGHOUSE_NOT_CONFIGURED",
          "no clearinghouse has been chosen for this organization yet",
        );
      }
      if (!isTransmitting(row.vendor)) {
        throw new ChartWardenError(
          "CLEARINGHOUSE_OUTSIDE_NOT_VERIFIABLE",
          "billing outside ChartWarden has no clearinghouse connection to verify",
          422,
        );
      }
      if (!row.secretCipher || (row.mode !== "test" && row.mode !== "production")) {
        throw conflict(
          "CLEARINGHOUSE_SECRET_REQUIRED",
          "the vendor credential has not been entered yet",
        );
      }
      const vendor = row.vendor;
      const mode = row.mode;
      if (!deps.probes[vendor]) {
        if (input.confirmNoPatientInformation !== true) {
          throw invalid(
            "confirmNoPatientInformation",
            "CLEARINGHOUSE_NO_PHI_CONFIRMATION_REQUIRED",
            "confirm that the evidence note names no patient information",
          );
        }
        const evidence = normalizeEvidence(input.evidenceNote);
        return { version: row.version, vendor, mode, evidence, secret: null };
      }
      try {
        const secret = await requireCipher().decrypt(
          organizationId,
          { vendor, mode },
          row.secretCipher,
        );
        return { version: row.version, vendor, mode, evidence: null, secret };
      } catch (err) {
        if (err instanceof ChartWardenError) throw err;
        throw conflict(
          "CLEARINGHOUSE_SECRET_UNREADABLE",
          "the stored credential could not be opened; enter it again",
        );
      }
    },

    async runProbe(plan) {
      if (plan.secret === null) return null;
      const probe = deps.probes[plan.vendor];
      if (!probe) return null;
      try {
        return await probe(plan.secret, plan.mode);
      } catch {
        return "unreachable"; // a probe that throws is a vendor we could not reach, not a failed request
      }
    },

    async completeVerify(store, actor, plan, outcome) {
      const { organizationId } = actor;
      const row = await store.findForUpdate(organizationId);
      if (!row || row.version !== plan.version) {
        throw conflict(
          "CLEARINGHOUSE_CHANGED_DURING_VERIFY",
          "the clearinghouse config changed while it was being verified; verify it again",
        );
      }
      const at = now();
      const keepStatus = row.status === "active" ? "active" : "verified";
      if (outcome === null) {
        const saved = await save(store, row, {
          status: keepStatus,
          verificationKind: "attested",
          verificationEvidence: plan.evidence,
          verifiedAt: at,
          verifiedByMembershipId: actor.membershipId,
        });
        return { view: viewOf(saved, organizationId), test: null };
      }
      const tested = { lastTestAt: at, lastTestOutcome: outcome };
      if (outcome !== "ok") {
        const saved = await save(store, row, tested);
        return { view: viewOf(saved, organizationId), test: { outcome } };
      }
      const saved = await save(store, row, {
        ...tested,
        status: keepStatus,
        verificationKind: "connection_test",
        verificationEvidence: null,
        verifiedAt: at,
        verifiedByMembershipId: actor.membershipId,
      });
      return { view: viewOf(saved, organizationId), test: { outcome } };
    },

    async activate(store, actor) {
      const { organizationId } = actor;
      const row = await lockedRow(store, organizationId);
      if (row.status === "active") return viewOf(row, organizationId); // idempotent; `outside` is always here
      if (row.status !== "verified") {
        throw conflict(
          "CLEARINGHOUSE_NOT_VERIFIED",
          "verify the clearinghouse connection before activating it",
        );
      }
      if (!row.baaVerifiedAt) {
        throw conflict(
          "CLEARINGHOUSE_BAA_NOT_VERIFIED",
          "record the vendor BAA and have a platform operator verify it before activating the clearinghouse",
        );
      }
      const saved = await save(store, row, {
        status: "active",
        activatedAt: now(),
        activatedByMembershipId: actor.membershipId,
      });
      return viewOf(saved, organizationId);
    },
  };
}
