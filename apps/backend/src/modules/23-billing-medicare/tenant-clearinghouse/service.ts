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
  baaMatchesPin,
  baaViewOf,
  normalizeBaaInput,
  sameBaa,
} from "./baa";
import type { ConfigPatch, ConfigRow, ConfigStore } from "./config-store";
import { isUniqueViolation } from "./config-store";
import {
  accountInUse,
  assertReleasable,
  backfillFingerprint,
  isFingerprintViolation,
  reserveCredential,
} from "./credential-reservation";
import { invalid, screenedText } from "./screening";
import type { ClearinghouseSecretCipher, CredentialFingerprint } from "./secret-cipher";
import type {
  ClearinghouseActor,
  ClearinghouseConfigView,
  ConfigTx,
  PutClearinghouseInput,
  PutResult,
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
    if (input.vendor === "outside") {
      const patch: ConfigPatch = {
        ...base,
        ...BACK_TO_DRAFT,
        ...BAA_CLEARED,
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
    const full = await backfillFingerprint(
      store,
      row,
      patch,
      requireCipher,
      deps.platformCredentialFingerprints,
    );
    let updated: ConfigRow | null;
    try {
      updated = await store.update(row.organizationId, row.version, { ...full, updatedAt: now() });
    } catch (err) {
      if (isFingerprintViolation(err)) throw accountInUse();
      throw err;
    }
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
        view: viewOf(row, organizationId),
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
    existing: ConfigRow,
    actor: ClearinghouseActor,
  ): Promise<void> {
    const { organizationId } = actor;
    if (existing.vendor === "outside") {
      // Nothing was ever sent through a vendor, so no queue or production lock applies; but the tenant's own lane may not leave outside
      // while a pricing contract exists: the mode that follows is the operator's to set.
      if (actor.lane !== "platform") await refuseOutsideSwitchWithContract(store, organizationId);
      return;
    }
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
  ): Promise<"change" | "unchanged"> {
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
    if (retargeted) await assertSwitchAllowed(store, existing, actor);
    if (retargeted && input.vendor !== "outside" && input.secret === undefined) {
      throw invalid(
        "secret",
        "CLEARINGHOUSE_SECRET_REQUIRED",
        "a new vendor or mode needs its own credential",
      );
    }
    return "change";
  }

  async function changeExisting(
    store: ConfigStore,
    actor: ClearinghouseActor,
    existing: ConfigRow,
    input: PutClearinghouseInput,
    expectedVersion: number | undefined,
  ): Promise<PutResult> {
    const { organizationId } = actor;
    if ((await checkChange(store, actor, existing, input, expectedVersion)) === "unchanged") {
      return { created: false, view: viewOf(existing, organizationId), changedFields: [] }; // nothing changes
    }
    const { patch, credential } = await patchFor(actor, existing, input);
    await reserveFor(store, organizationId, patch, credential);
    const row = await save(store, existing, patch);
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

    async releaseCredentials(store, actor, reason) {
      if (actor.lane !== "platform") {
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
      return { released, view: viewOf(row, organizationId) };
    },
  };
}
