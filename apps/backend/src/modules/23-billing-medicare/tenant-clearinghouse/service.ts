// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/service.ts — the rules of a tenant's clearinghouse
// config (ADR-0053 amendment 2026-11-06). Pure of transport and HTTP: every method takes a `ConfigStore` bound to one open
// org-scoped transaction, so the tenant's own routes and a platform operator's onboarding writes run the SAME code under
// the tenant's own RLS, and a rule is tested without a database.
//
//   put        choose stedi | claimmd | outside, its mode and its credential. ANY change (a vendor or mode change, a first
//              choice, or a credential rotation) starts the config at `draft` for the new key (owner decision D6): what the old
//              key earned (the connection test, the activation) is cleared, and claims work holds until it is re-verified and
//              re-activated. A change of VENDOR also voids the vendor BAA (a new agreement); a same-vendor change keeps it.
//              `outside` is stored `active`: nothing to verify. While a PRODUCTION submission is in flight or was sent within the
//              last RELEASE_QUIET_DAYS (credential-reservation.ts), vendor and mode are locked (409; the window is the one the
//              credential release uses), and a switch away from a vendor is refused while claims or submissions are queued. The ONE
//              exception: while the config's BAA is REVOKED (below) the TENANT lane may change vendor or mode or switch to `outside`
//              though production traffic is recent: the vendor that owed the responses has no BAA left to send them under, so holding
//              the tenant on it is the harm. The platform lane gets no exception (its choice write stays onboarding-only); the lane is a
//              REQUIRED `tenant | platform` and the exception is granted on a positive `tenant`. It is not one-shot: leaving the revoked
//              vendor is remembered (`revokedVendorLeftAt`) and the lock then counts only attempts reserved after it, so the vendor
//              the tenant left no longer locks the next one (A -> B -> C, A -> B -> outside); the new config's own traffic locks as ever.
//   recordBaa  the TENANT records its own vendor BAA (effective date, a screened document reference; owner decision D2). It is a new
//              agreement: it clears a revocation and starts again at unverified (the HISTORY of the revocation survives).
//   verifyBaa  a platform OPERATOR verifies that record; activation refuses (409 CLEARINGHOUSE_BAA_NOT_VERIFIED) until then. A record
//              whose document is the one revoked before needs `acknowledgePreviousRevocation` (409 ..._PREVIOUSLY_REVOKED otherwise).
//   revokeBaa  a platform OPERATOR revokes the record (the vendor ended the BAA) with a CLOSED reason code and a ticket reference (no free
//              text is stored anywhere): the verification is voided and a live config leaves `active` (to `verified`, as a re-recorded
//              BAA does), so its claims, NOE, NOTR and transfer notices are held and its acknowledgment and 835 pulls skip (the resolver
//              binds only an active config). It writes the BAA and status columns ONLY (`saveBaaOnly`), never the credential, so it does
//              not depend on the KEK or the credential reservation. While revoked, the BAA cannot be verified and the config cannot be
//              activated (409 CLEARINGHOUSE_BAA_REVOKED). A revoke is not an expiry: nothing here ends a BAA by itself, and no
//              vendor-side signal reaches ChartWarden.
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
  BAA_REVOCATION_CLEARED,
  BAA_VERIFICATION_CLEARED,
  type BaaPin,
  type BaaRevokeReasonCode,
  type BaaView,
  type RecordBaaInput,
  baaMatchesPin,
  baaViewOf,
  isPreviouslyRevokedDocument,
  normalizeBaaInput,
  normalizeRevokeInput,
  sameBaa,
} from "./baa";
import type { ConfigPatch, ConfigRow, ConfigStore } from "./config-store";
import { isUniqueViolation } from "./config-store";
import {
  RELEASE_QUIET_DAYS,
  accountInUse,
  assertReleasable,
  backfillFingerprint,
  hasRecentProductionTraffic,
  isFingerprintViolation,
  reserveCredential,
  responseWindowStart,
} from "./credential-reservation";
import { invalid, screenedText } from "./screening";
import type { ClearinghouseSecretCipher, CredentialFingerprint } from "./secret-cipher";
import type {
  ClearinghouseActor,
  ClearinghouseConfigView,
  ConfigTx,
  PutClearinghouseInput,
  PutResult,
  RevokeBaaInput,
  RevokeBaaResult,
  TenantClearinghouseService,
  TenantClearinghouseServiceDeps,
  VerifyClearinghouseInput,
} from "./service-types";

export type { BaaPin, RecordBaaInput } from "./baa";
export type {
  ClearinghouseActor,
  PutClearinghouseInput,
  PlatformFallback,
  ConnectionProbe,
  ClearinghouseProbes,
  WaitingWork,
  VerifyClearinghouseInput,
  ClearinghouseConfigView,
  TenantClearinghouseServiceDeps,
  VerifyPlan,
  PutResult,
  RevokeBaaInput,
  RevokeBaaResult,
  VerifyBaaOptions,
  TenantClearinghouseService,
  ConfigTx,
} from "./service-types";
export { accountInUse } from "./credential-reservation";

export const EVIDENCE_MIN = 8;
export const EVIDENCE_MAX = 500;
const SECRET_SHAPE = /^[\x21-\x7e]{8,512}$/; // printable ASCII, no whitespace (Claim.MD keys hold # and *)

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
/** The one refusal for anything asked of a BAA a platform operator revoked: only a new record (the tenant's) clears it. */
const baaRevoked = (consequence: string): ChartWardenError =>
  conflict(
    "CLEARINGHOUSE_BAA_REVOKED",
    `the vendor BAA was revoked by a platform operator, so ${consequence}; the tenant records a new BAA, which a platform operator then verifies`,
  );

const isTransmitting = (vendor: string): vendor is TransmittingClearinghouseVendor =>
  vendor === "stedi" || vendor === "claimmd";

/** The platform operator's lane. */
const isOperator = (actor: ClearinghouseActor): boolean => actor.lane === "platform";
/** The tenant's own lane: what a rule that is the tenant's alone (the vendor-lock exception, recording a BAA, activation) checks. */
const isTenant = (actor: ClearinghouseActor): boolean => actor.lane === "tenant";

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

/**
 * A row sealed before migration 1434 has a credential and no fingerprint, and 1435's CHECK refuses any write that keeps it that way.
 * A revoke must not need the KEK to repair that, so it drops the credential WITH the BAA (back to draft, nothing sealed): the tenant
 * enters it again, which it must for any new agreement anyway. Only that legacy shape ever takes this path.
 */
const CREDENTIAL_DROPPED = {
  ...BACK_TO_DRAFT,
  secretCipher: null,
  secretDekVersion: null,
  credentialFingerprint: null,
  credentialFingerprintKeyId: null,
} as const satisfies ConfigPatch;

export function createTenantClearinghouseService(
  deps: TenantClearinghouseServiceDeps,
): TenantClearinghouseService {
  const now = deps.now ?? (() => new Date());
  /** Row and BAA timestamps must advance even when the clock stalls or moves backward; `recordedAt` is an If-Match token. */
  const nextRowTimestamp = (
    row: Pick<ConfigRow, "baaRecordedAt" | "updatedAt">,
    patch: ConfigPatch = {},
  ): Date => {
    const candidate = now();
    let patchFloor = 0;
    for (const value of Object.values(patch)) {
      if (value instanceof Date) patchFloor = Math.max(patchFloor, value.getTime());
    }
    const floor = Math.max(row.baaRecordedAt?.getTime() ?? 0, row.updatedAt.getTime(), patchFloor);
    return candidate.getTime() <= floor ? new Date(floor + 1) : candidate;
  };

  const verifiableBy = (vendor: string | null): ClearinghouseConfigView["verifiableBy"] => {
    if (vendor === null || !isTransmitting(vendor)) return null;
    return deps.probes[vendor] ? "connection_test" : "attestation";
  };

  /** `operator`: the platform lane's view, which also shows a revoked BAA's reason. */
  function viewOf(
    row: ConfigRow | null,
    organizationId: string,
    operator = false,
  ): ClearinghouseConfigView {
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
      baa: baaViewOf(row, operator),
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
    if (deps.isProduction && isTenant(actor) && input.mode === "test") {
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

  /**
   * The patch that puts a row on `input`: a draft for a transmitting vendor, active for `outside`. With a new credential, also its
   * fingerprints under every configured key (the patch carries the current one; `reserveFor` reserves them all).
   */
  async function patchFor(
    actor: ClearinghouseActor,
    existing: ConfigRow | null,
    input: PutClearinghouseInput,
  ): Promise<{
    readonly patch: ConfigPatch;
    readonly credential: readonly CredentialFingerprint[];
  }> {
    const base = { vendor: input.vendor, setByMembershipId: actor.membershipId, updatedAt: now() };
    // Leaving a revoked vendor (a vendor change or `outside`) voids the record and the revocation, so the departure is remembered: the
    // vendor lock then ignores that vendor's traffic (assertSwitchAllowed). A same-vendor mode change keeps the revocation instead.
    const leavingRevokedVendor =
      existing !== null && Boolean(existing.baaRevokedAt) && existing.vendor !== input.vendor;
    const departure = leavingRevokedVendor ? { revokedVendorLeftAt: now() } : {};
    if (input.vendor === "outside") {
      const patch: ConfigPatch = {
        ...base,
        ...BACK_TO_DRAFT,
        ...BAA_CLEARED,
        ...departure,
        mode: null,
        status: "active",
        secretCipher: null,
        secretDekVersion: null,
        // no current credential; the reservation of the old one stays held until a platform operator releases it
        credentialFingerprint: null,
        credentialFingerprintKeyId: null,
      };
      return { patch, credential: [] };
    }
    const mode = input.mode as TenantClearinghouseMode;
    if (input.secret) await deps.assertFingerprintKeysComplete?.();
    const credential = input.secret ? requireCipher().fingerprints(input.vendor, input.secret) : [];
    // a pure check before anything is sealed or written (the reservation in `reserveFor` checks it again)
    if (credential.some((f) => deps.platformCredentialFingerprints?.has(f.fingerprint)))
      throw accountInUse();
    const sealed = input.secret
      ? await requireCipher().encrypt(actor.organizationId, input.secret, {
          vendor: input.vendor,
          mode,
        })
      : null;
    const current = credential[0];
    const patch: ConfigPatch = {
      ...base,
      ...BACK_TO_DRAFT,
      // the vendor BAA survives anything but a change of vendor
      ...(existing?.vendor === input.vendor ? {} : BAA_CLEARED),
      ...departure,
      mode,
      secretCipher: sealed?.cipher ?? null,
      secretDekVersion: sealed?.dekVersion ?? null,
      credentialFingerprint: current?.fingerprint ?? null,
      credentialFingerprintKeyId: current?.keyId ?? null,
    };
    return { patch, credential };
  }

  /** Reserve the new credential to the org under every key (the cross-organization index refuses one another org holds). */
  async function reserveFor(
    store: ConfigStore,
    organizationId: string,
    patch: ConfigPatch,
    credential: readonly CredentialFingerprint[],
  ): Promise<void> {
    if (credential.length === 0 || !patch.vendor) return;
    await reserveCredential(
      store,
      organizationId,
      patch.vendor,
      credential,
      deps.platformCredentialFingerprints,
    );
  }

  async function save(store: ConfigStore, row: ConfigRow, patch: ConfigPatch): Promise<ConfigRow> {
    const full = await backfillFingerprint(store, row, patch, {
      cipher: deps.cipher,
      requireCipher,
      platformFingerprints: deps.platformCredentialFingerprints,
    });
    let updated: ConfigRow | null;
    try {
      updated = await store.update(row.organizationId, row.version, {
        ...full,
        updatedAt: nextRowTimestamp(row, full),
      });
    } catch (err) {
      if (isFingerprintViolation(err)) throw accountInUse();
      throw err;
    }
    if (!updated)
      throw versionConflict("the clearinghouse config changed while it was being updated");
    return updated;
  }

  /**
   * A write of BAA and status columns only: no credential repair (`backfillFingerprint`), so it never depends on the KEK, the cipher
   * or the credential reservation (the revoke is a kill switch: an unreadable or contested credential must not stop it).
   */
  async function saveBaaOnly(
    store: ConfigStore,
    row: ConfigRow,
    patch: ConfigPatch,
  ): Promise<ConfigRow> {
    const updated = await store.update(row.organizationId, row.version, {
      ...patch,
      updatedAt: nextRowTimestamp(row, patch),
    });
    if (!updated)
      throw versionConflict("the clearinghouse config changed while it was being updated");
    return updated;
  }

  /**
   * The fingerprints a release never frees: the current credential's, under every configured key. Unsealing it finds the
   * fingerprints under the other keys; when it cannot be opened (no cipher, or a KEK it was not sealed under), the stored current
   * fingerprint alone stays held, which still blocks it for as long as that fingerprint's key is configured.
   */
  async function keepOf(row: ConfigRow): Promise<string[]> {
    if (row.credentialFingerprint === null) return [];
    const keep = new Set([row.credentialFingerprint]);
    const { vendor, mode, secretCipher } = row;
    if (
      deps.cipher &&
      secretCipher &&
      isTransmitting(vendor) &&
      (mode === "test" || mode === "production")
    ) {
      try {
        const secret = await deps.cipher.decrypt(
          row.organizationId,
          { vendor, mode },
          secretCipher,
        );
        for (const f of deps.cipher.fingerprints(vendor, secret)) keep.add(f.fingerprint);
      } catch {
        // unopenable: the stored fingerprint alone stays held (above)
      }
    }
    return [...keep];
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

  /** What a FIRST choice refuses before it writes: an If-Match (there is no row to match), and a missing vendor credential. */
  function checkCreate(input: PutClearinghouseInput, expectedVersion: number | undefined): void {
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
  }

  /** The first choice: no row yet, so no If-Match, and the credential is required. */
  async function createFirst(
    store: ConfigStore,
    actor: ClearinghouseActor,
    input: PutClearinghouseInput,
    expectedVersion: number | undefined,
  ): Promise<PutResult> {
    const { organizationId } = actor;
    checkCreate(input, expectedVersion);
    const { patch, credential } = await patchFor(actor, null, input);
    await reserveFor(store, organizationId, patch, credential);
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
        view: viewOf(row, organizationId, isOperator(actor)),
        changedFields: changedFieldsOf(null, input),
      };
    } catch (err) {
      if (isFingerprintViolation(err)) throw accountInUse();
      if (!isUniqueViolation(err)) throw err;
      throw versionConflict(
        "a clearinghouse config was created concurrently; read it and send its version in If-Match",
      );
    }
  }

  /** The locks on a switch: production submissions in flight, and claims or submissions still queued on the old vendor. */
  async function assertSwitchAllowed(
    store: ConfigStore,
    actor: ClearinghouseActor,
    existing: ConfigRow,
  ): Promise<boolean> {
    const { organizationId } = actor;
    if (existing.vendor === "outside") {
      if (actor.lane !== "platform") await refuseOutsideSwitchWithContract(store, organizationId);
      return false;
    }
    const lockSuspended = Boolean(existing.baaRevokedAt) && isTenant(actor);
    // Owner decision needed (CH-1): the lock lasts as long as the old vendor can still owe this org responses, the credential
    // release's own window (RELEASE_QUIET_DAYS), not forever: a lock with no end and no operator path would strand the tenant.
    let lockExceptionUsed = false;
    // Once the tenant has LEFT a revoked vendor the exception is spent, but so is that vendor's traffic: the lock counts only attempts
    // reserved after the departure (`revokedVendorLeftAt`), so a tenant that picked the wrong next vendor is not locked for 90 days by
    // the vendor it already left, while the new config's own traffic locks it as it always did.
    if (
      await hasRecentProductionTraffic(store, organizationId, now(), existing.revokedVendorLeftAt)
    ) {
      if (!lockSuspended) {
        throw conflict(
          "CLEARINGHOUSE_VENDOR_LOCKED",
          `this organization has production submissions in flight or sent in the last ${RELEASE_QUIET_DAYS} days; its vendor and mode cannot change until its vendor's responses have had time to arrive`,
        );
      }
      lockExceptionUsed = true; // the tenant's own audit row says the lock was set aside, and why
    }
    // A config that is not active sends nothing and cannot drain what waits (the workers hold it), so the queue does not lock it:
    // refusing the switch would leave the tenant with no way out (re-review M3).
    if (existing.status !== "active") return lockExceptionUsed;
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
    return lockExceptionUsed;
  }

  async function refuseOutsideSwitchWithContract(
    store: ConfigStore,
    organizationId: string,
  ): Promise<void> {
    if (!deps.hasPricingContract) return;
    let hasContract: boolean;
    try {
      hasContract = await deps.hasPricingContract(organizationId, store.tx);
    } catch (cause) {
      // A switch that cannot be judged is not allowed: answering "no contract" could put a vendor in front of billing mode none. The
      // caller gets the typed 503; the CAUSE goes to the log (a database or wiring fault would otherwise vanish behind it).
      deps.warn?.(
        "m23 clearinghouse: the tenant's contract could not be read for a switch away from outside",
        {
          organizationId,
          err: cause,
        },
      );
      throw new ChartWardenError(
        "CLEARINGHOUSE_CONTRACT_UNAVAILABLE",
        "this organization's contract could not be read, so the switch away from outside ChartWarden was not made",
        503,
      );
    }
    if (!hasContract) return;
    throw conflict(
      "CLEARINGHOUSE_OUTSIDE_SWITCH_REQUIRES_OPERATOR",
      "this organization bills outside ChartWarden and has a contract, so moving to a clearinghouse also sets its billing service mode: ask ChartWarden support to make the switch",
    );
  }

  /**
   * Everything a change to an EXISTING choice refuses before it writes, read-only: the If-Match (428 none, 412 stale), the switch's locks,
   * and a new vendor or mode's credential. `unchanged` when the body changes nothing (the write is then a no-op).
   */
  async function checkChange(
    store: ConfigStore,
    actor: ClearinghouseActor,
    existing: ConfigRow,
    input: PutClearinghouseInput,
    expectedVersion: number | undefined,
  ): Promise<boolean | "unchanged"> {
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
    if (!retargeted && input.secret === undefined) return "unchanged";
    const lockExceptionUsed = retargeted
      ? await assertSwitchAllowed(store, actor, existing)
      : false;
    if (retargeted && input.vendor !== "outside" && input.secret === undefined) {
      throw invalid(
        "secret",
        "CLEARINGHOUSE_SECRET_REQUIRED",
        "a new vendor or mode needs its own credential",
      );
    }
    return lockExceptionUsed;
  }

  async function changeExisting(
    store: ConfigStore,
    actor: ClearinghouseActor,
    existing: ConfigRow,
    input: PutClearinghouseInput,
    expectedVersion: number | undefined,
  ): Promise<PutResult> {
    const { organizationId } = actor;
    const checked = await checkChange(store, actor, existing, input, expectedVersion);
    if (checked === "unchanged") {
      return {
        created: false,
        view: viewOf(existing, organizationId, isOperator(actor)),
        changedFields: [],
      };
    }
    const lockExceptionUsed = checked;
    const { patch, credential } = await patchFor(actor, existing, input);
    await reserveFor(store, organizationId, patch, credential);
    const row = await save(store, existing, patch);
    return {
      created: false,
      view: viewOf(row, organizationId, isOperator(actor)),
      changedFields: changedFieldsOf(existing, input),
      ...(lockExceptionUsed ? { lockExceptionUsed } : {}),
    };
  }

  return {
    async view(store, organizationId, options) {
      return viewOf(await store.find(organizationId), organizationId, options?.operator === true);
    },

    async checkPut(store, actor, input, expectedVersion) {
      validatePut(actor, input);
      // A credential that would have to be sealed needs the cipher: a deployment without one refuses (503) HERE, before the caller
      // writes anything else, instead of after it.
      if (input.vendor !== "outside" && input.secret !== undefined) {
        // the platform's own key is refused here too, a pure check (security review LOW-3): the operator's switch out of `outside`
        // writes the billing mode first, so a refusal it can see coming must come before that write
        const credential = requireCipher().fingerprints(input.vendor, input.secret);
        if (credential.some((f) => deps.platformCredentialFingerprints?.has(f.fingerprint)))
          throw accountInUse();
      }
      const existing = await store.find(actor.organizationId);
      if (existing) await checkChange(store, actor, existing, input, expectedVersion);
      else checkCreate(input, expectedVersion);
    },

    async put(store, actor, input, expectedVersion) {
      validatePut(actor, input);
      const existing = await store.findForUpdate(actor.organizationId);
      return existing
        ? changeExisting(store, actor, existing, input, expectedVersion)
        : createFirst(store, actor, input, expectedVersion);
    },

    async recordBaa(store, actor, input) {
      // The tenant records the BAA it holds with its own vendor; a platform operator only verifies it (separate keys, one role). The
      // route lane already enforces this: the service says it too, so a new caller cannot record a BAA on the tenant's behalf.
      if (!isTenant(actor)) {
        throw new ChartWardenError(
          "CLEARINGHOUSE_BAA_TENANT_ONLY",
          "only the organization's own billing administrator may record its vendor BAA",
          403,
        );
      }
      const record = normalizeBaaInput(input, medicareReceiptDay(now()));
      const row = await lockedRow(store, actor.organizationId);
      requireVendorAccount(row);
      if (sameBaa(row, record)) {
        return { view: viewOf(row, actor.organizationId, isOperator(actor)), changedFields: [] };
      }
      const saved = await save(store, row, {
        // the vendor the record is for: the table keeps a live config on a BAA for ITS vendor (requireVendorAccount: not `outside`)
        baaVendor: row.vendor,
        baaEffectiveDate: record.effectiveDate,
        baaDocumentRef: record.documentRef,
        baaRecordedAt: nextRowTimestamp(row),
        baaRecordedByMembershipId: actor.membershipId,
        // a changed record has not been looked at: the operator verifies it again
        ...BAA_VERIFICATION_CLEARED,
        // a new record is a new agreement: a revocation of the old one does not carry over
        ...BAA_REVOCATION_CLEARED,
        // a live config cannot rest on an unverified BAA: it waits at `verified` until the operator re-verifies
        ...(row.status === "active"
          ? { status: "verified", activatedAt: null, activatedByMembershipId: null }
          : {}),
      });
      return {
        view: viewOf(saved, actor.organizationId, isOperator(actor)),
        // names only: the audit row says the tenant's new record also cleared a revocation
        changedFields: row.baaRevokedAt !== null ? ["baa", "baaRevocation"] : ["baa"],
      };
    },

    async verifyBaa(store, actor, expected, options) {
      if (!isOperator(actor)) {
        throw new ChartWardenError(
          "FORBIDDEN",
          "only a platform operator may verify a clearinghouse vendor BAA",
          403,
        );
      }
      const row = await lockedRow(store, actor.organizationId);
      requireVendorAccount(row);
      if (!row.baaRecordedAt) {
        throw conflict(
          "CLEARINGHOUSE_BAA_NOT_RECORDED",
          "the tenant has not recorded its vendor BAA yet",
        );
      }
      // A revoked record is not verified again: the tenant records a new BAA (a new agreement) and the operator verifies that.
      if (row.baaRevokedAt) throw baaRevoked("it cannot be verified again");
      if (!baaMatchesPin(row, expected)) {
        throw conflict(
          "CLEARINGHOUSE_BAA_CHANGED",
          "the tenant's BAA record changed since it was read; read it again and verify what it now says",
        );
      }
      if (row.baaVerifiedAt) return viewOf(row, actor.organizationId, isOperator(actor)); // idempotent
      // The tenant re-recorded the very document an operator revoked: verifying it is allowed, but only knowingly (the audit row says so).
      if (isPreviouslyRevokedDocument(row) && options?.acknowledgePreviousRevocation !== true) {
        throw conflict(
          "CLEARINGHOUSE_BAA_PREVIOUSLY_REVOKED",
          "this document is the one a platform operator revoked before; verify it only with acknowledgePreviousRevocation: true",
        );
      }
      const saved = await save(store, row, {
        baaVerifiedAt: now(),
        baaVerifiedByMembershipId: actor.membershipId,
      });
      return viewOf(saved, actor.organizationId, isOperator(actor));
    },

    async revokeBaa(store, actor, expected, input) {
      if (!isOperator(actor)) {
        throw new ChartWardenError(
          "FORBIDDEN",
          "only a platform operator may revoke a clearinghouse vendor BAA",
          403,
        );
      }
      const { reasonCode, ticketRef } = normalizeRevokeInput(input);
      const row = await lockedRow(store, actor.organizationId);
      requireVendorAccount(row);
      if (!row.baaRecordedAt) {
        throw conflict(
          "CLEARINGHOUSE_BAA_NOT_RECORDED",
          "the tenant has not recorded a vendor BAA, so there is none to revoke",
        );
      }
      if (!baaMatchesPin(row, expected)) {
        throw conflict(
          "CLEARINGHOUSE_BAA_CHANGED",
          "the tenant's BAA record changed since it was read; read it again and revoke what it now says",
        );
      }
      if (row.baaRevokedAt) throw baaRevoked("it cannot be revoked again");
      const at = now();
      const wasActive = row.status === "active";
      const attempts = await store.countRecentProductionAttempts(
        actor.organizationId,
        responseWindowStart(at),
      );
      const waiting = await deps.waitingWork?.(actor.organizationId, store.tx);
      // The credential is not touched (see saveBaaOnly), except for the one legacy shape the table's CHECK would refuse.
      const credentialCleared = row.secretCipher !== null && row.credentialFingerprint === null;
      const saved = await saveBaaOnly(store, row, {
        baaRevokedAt: at,
        baaRevokedByMembershipId: actor.membershipId,
        baaRevokedReasonCode: reasonCode,
        baaRevokedTicketRef: ticketRef,
        // the history survives a re-record and a vendor change: the next verification can see this document was revoked
        baaLastRevokedAt: at,
        baaLastRevokedDocumentRef: row.baaDocumentRef,
        // a revoked record holds no verification (the table's CHECK), and a live config cannot rest on one
        ...BAA_VERIFICATION_CLEARED,
        ...(credentialCleared ? CREDENTIAL_DROPPED : {}),
        ...(wasActive && !credentialCleared
          ? { status: "verified", activatedAt: null, activatedByMembershipId: null }
          : {}),
      });
      return {
        view: viewOf(saved, actor.organizationId, true),
        wasActive,
        impact: {
          attemptsInFlight: attempts.inFlight,
          attemptsSentInWindow: attempts.sent,
          queuedClaims: waiting?.claims ?? 0,
          queuedCommercialSubmissions: waiting?.commercialSubmissions ?? 0,
        },
        configId: saved.id,
        reasonCode,
        vendor: row.vendor as TransmittingClearinghouseVendor,
        credentialCleared,
      };
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
        return { view: viewOf(saved, organizationId, isOperator(actor)), test: null };
      }
      const tested = { lastTestAt: at, lastTestOutcome: outcome };
      if (outcome !== "ok") {
        const saved = await save(store, row, tested);
        return { view: viewOf(saved, organizationId, isOperator(actor)), test: { outcome } };
      }
      const saved = await save(store, row, {
        ...tested,
        status: keepStatus,
        verificationKind: "connection_test",
        verificationEvidence: null,
        verifiedAt: at,
        verifiedByMembershipId: actor.membershipId,
      });
      return { view: viewOf(saved, organizationId, isOperator(actor)), test: { outcome } };
    },

    async activate(store, actor) {
      // A platform operator sets up and verifies a tenant's clearinghouse during onboarding, but only the tenant's own billing admin
      // activates it (the step that lets claims go out under its account). Checked first: an operator gets the refusal even over an
      // already-active config, never an idempotent success.
      if (!isTenant(actor)) {
        throw new ChartWardenError(
          "CLEARINGHOUSE_ACTIVATION_TENANT_ONLY",
          "only the organization's own billing administrator may activate its clearinghouse",
          403,
        );
      }
      const { organizationId } = actor;
      const row = await lockedRow(store, organizationId);
      if (row.status === "active") return viewOf(row, organizationId, isOperator(actor)); // idempotent; `outside` is always here
      // Before the other refusals: a revoked BAA is the larger blocker, and a draft config needs a new BAA as well as a fresh check.
      if (row.baaRevokedAt) throw baaRevoked("the clearinghouse cannot be activated");
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
      return viewOf(saved, organizationId, isOperator(actor));
    },

    async releaseCredentials(store, actor, reason) {
      if (!isOperator(actor)) {
        throw new ChartWardenError(
          "FORBIDDEN",
          "only a platform operator may release a clearinghouse credential",
          403,
        );
      }
      const { organizationId } = actor;
      const row = await lockedRow(store, organizationId);
      await assertReleasable(store, organizationId, now());
      const released = await store.releaseCredentials(organizationId, await keepOf(row), {
        userId: actor.userId,
        reason,
        at: now(),
      });
      return { released, view: viewOf(row, organizationId, isOperator(actor)) };
    },
  };
}
