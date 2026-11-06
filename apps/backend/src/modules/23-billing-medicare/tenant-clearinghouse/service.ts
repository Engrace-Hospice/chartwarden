// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/service.ts — the rules of a tenant's clearinghouse
// config (ADR-0053 amendment 2026-11-06). Pure of transport and HTTP: every method takes a `ConfigStore` bound to one open
// org-scoped transaction, so the tenant's own routes and a platform operator's onboarding writes run the SAME code under
// the tenant's own RLS, and a rule is tested without a database.
//
//   put       choose stedi | claimmd | outside, its mode and its credential. A vendor or mode change (or a first choice)
//             starts at `draft` and needs the new credential; a credential rotation alone keeps the status (rotating a key
//             must not take a live tenant offline) and clears the last test. `outside` is stored `active`: nothing to verify.
//             Once a PRODUCTION submission exists for the org, vendor and mode are locked (409): its acknowledgments are
//             still owed by the old vendor, and a switch would stop pulling them.
//   verify    draft -> verified. Where the vendor has a safe no-PHI probe (Claim.MD `uploadlist`) the probe runs; where it
//             has none (Stedi) the caller attests with an evidence note. Recorded as `connection_test` / `attested`.
//   activate  verified -> active: claims and eligibility work is allowed (the claims-billing gate reads this).
//
// The credential is write-only: no view carries it (a `hasSecret` flag is derived). Nothing here logs or audits a value; the
// row's M4 write-audit trigger records that the secret changed, never what it was.
import { looksLikeMbi } from "@chartwarden/billing";
import {
  ChartWardenError,
  type TenantClearinghouseMode,
  type TenantClearinghouseStatus,
  type TenantClearinghouseVendor,
  type TransmittingClearinghouseVendor,
  ValidationError,
} from "@chartwarden/types";
import type { ConnectionProbeOutcome } from "@chartwarden/x12-837-client";
import type { ConfigPatch, ConfigRow, ConfigStore } from "./config-store";
import { isUniqueViolation } from "./config-store";
import type { ClearinghouseSecretCipher } from "./secret-cipher";

export const EVIDENCE_MIN = 8;
export const EVIDENCE_MAX = 500;
const SECRET_SHAPE = /^[\x21-\x7e]{8,512}$/; // printable ASCII, no whitespace (Claim.MD keys hold # and *)
const SSN_SHAPE = /(?<!\d)\d{3}[\s.-]?\d{2}[\s.-]?\d{4}(?!\d)/u;

/** Who acts: server-assembled from the session (a tenant admin, or the platform operator acting for the tenant). */
export interface ClearinghouseActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
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
}

export interface TenantClearinghouseService {
  view(store: ConfigStore, organizationId: string): Promise<ClearinghouseConfigView>;
  put(
    store: ConfigStore,
    actor: ClearinghouseActor,
    input: PutClearinghouseInput,
    expectedVersion: number | undefined,
  ): Promise<{ readonly created: boolean; readonly view: ClearinghouseConfigView }>;
  verify(
    store: ConfigStore,
    actor: ClearinghouseActor,
    input: { readonly evidenceNote?: string },
  ): Promise<{
    readonly view: ClearinghouseConfigView;
    readonly test: { readonly outcome: ConnectionProbeOutcome } | null;
  }>;
  activate(store: ConfigStore, actor: ClearinghouseActor): Promise<ClearinghouseConfigView>;
}

const invalid = (field: string, code: string, message: string): ValidationError =>
  new ValidationError("request validation failed", [{ field, code, message }]);
const conflict = (code: string, message: string): ChartWardenError =>
  new ChartWardenError(code, message, 409);
const versionConflict = (message: string): ChartWardenError =>
  new ChartWardenError("VERSION_CONFLICT", message, 412);

const isTransmitting = (vendor: string): vendor is TransmittingClearinghouseVendor =>
  vendor === "stedi" || vendor === "claimmd";

/** Evidence the operator typed: whitespace folded, control characters dropped, length-bounded, never a patient identifier. */
export function normalizeEvidence(raw: unknown): string {
  const text =
    typeof raw === "string"
      ? raw
          .replace(/\s+/gu, " ")
          .replace(/\p{C}+/gu, "")
          .trim()
      : "";
  if (text.length < EVIDENCE_MIN || text.length > EVIDENCE_MAX) {
    throw invalid(
      "evidenceNote",
      "CLEARINGHOUSE_EVIDENCE_REQUIRED",
      `evidenceNote must be ${EVIDENCE_MIN}-${EVIDENCE_MAX} characters: say what was checked and by whom`,
    );
  }
  if (SSN_SHAPE.test(text) || looksLikeMbi(text)) {
    throw invalid(
      "evidenceNote",
      "EVIDENCE_LOOKS_LIKE_PHI",
      "evidenceNote looks like it contains a patient identifier; describe what was checked without naming a patient",
    );
  }
  return text;
}

function validatePut(input: PutClearinghouseInput): void {
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
  if (input.secret !== undefined && !SECRET_SHAPE.test(input.secret)) {
    throw invalid(
      "secret",
      "CLEARINGHOUSE_SECRET_INVALID",
      "the credential must be 8-512 printable characters with no spaces",
    );
  }
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

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

  /** The patch that puts a row on `input`: a draft for a transmitting vendor, active for `outside`. */
  async function patchFor(
    actor: ClearinghouseActor,
    existing: ConfigRow | null,
    input: PutClearinghouseInput,
  ): Promise<ConfigPatch> {
    const at = now();
    const base = { vendor: input.vendor, setByMembershipId: actor.membershipId, updatedAt: at };
    if (input.vendor === "outside") {
      return {
        ...base,
        mode: null,
        status: "active",
        secretCipher: null,
        secretDekVersion: null,
        verificationKind: null,
        verificationEvidence: null,
        verifiedAt: null,
        verifiedByMembershipId: null,
        lastTestAt: null,
        lastTestOutcome: null,
        activatedAt: null,
        activatedByMembershipId: null,
      };
    }
    const mode = input.mode as TenantClearinghouseMode;
    const sealed = input.secret
      ? await requireCipher().encrypt(actor.organizationId, input.secret, {
          vendor: input.vendor,
          mode,
        })
      : null;
    const sameTarget = existing?.vendor === input.vendor && existing.mode === mode;
    if (sameTarget && sealed) {
      // A credential rotation: the status stays (the tenant is not taken offline), the last test no longer describes it.
      return {
        ...base,
        mode,
        secretCipher: sealed.cipher,
        secretDekVersion: sealed.dekVersion,
        lastTestAt: null,
        lastTestOutcome: null,
      };
    }
    return {
      ...base,
      mode,
      status: "draft",
      secretCipher: sealed?.cipher ?? null,
      secretDekVersion: sealed?.dekVersion ?? null,
      verificationKind: null,
      verificationEvidence: null,
      verifiedAt: null,
      verifiedByMembershipId: null,
      lastTestAt: null,
      lastTestOutcome: null,
      activatedAt: null,
      activatedByMembershipId: null,
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

  return {
    async view(store, organizationId) {
      return viewOf(await store.find(organizationId), organizationId);
    },

    async put(store, actor, input, expectedVersion) {
      validatePut(input);
      const { organizationId } = actor;
      const existing = await store.findForUpdate(organizationId);
      if (!existing) {
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
          return { created: true, view: viewOf(row, organizationId) };
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          throw versionConflict(
            "a clearinghouse config was created concurrently; read it and send its version in If-Match",
          );
        }
      }
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
        return { created: false, view: viewOf(existing, organizationId) }; // nothing changes
      }
      if (
        retargeted &&
        existing.vendor !== "outside" &&
        (await store.hasProductionAttempts(organizationId))
      ) {
        throw conflict(
          "CLEARINGHOUSE_VENDOR_LOCKED",
          "this organization has production submissions in flight; its vendor and mode cannot change until an operator migrates them",
        );
      }
      if (retargeted && input.vendor !== "outside" && input.secret === undefined) {
        throw invalid(
          "secret",
          "CLEARINGHOUSE_SECRET_REQUIRED",
          "a new vendor or mode needs its own credential",
        );
      }
      const row = await save(store, existing, await patchFor(actor, existing, input));
      return { created: false, view: viewOf(row, organizationId) };
    },

    async verify(store, actor, input) {
      const { organizationId } = actor;
      const row = await lockedRow(store, organizationId);
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
      const at = now();
      const keepStatus = row.status === "active" ? "active" : "verified";
      const probe = deps.probes[vendor];
      if (!probe) {
        const evidence = normalizeEvidence(input.evidenceNote);
        const saved = await save(store, row, {
          status: keepStatus,
          verificationKind: "attested",
          verificationEvidence: evidence,
          verifiedAt: at,
          verifiedByMembershipId: actor.membershipId,
        });
        return { view: viewOf(saved, organizationId), test: null };
      }
      let secret: string;
      try {
        secret = await requireCipher().decrypt(organizationId, { vendor, mode }, row.secretCipher);
      } catch (err) {
        if (err instanceof ChartWardenError) throw err;
        throw conflict(
          "CLEARINGHOUSE_SECRET_UNREADABLE",
          "the stored credential could not be opened; enter it again",
        );
      }
      const outcome = await probe(secret, mode);
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
      const saved = await save(store, row, {
        status: "active",
        activatedAt: now(),
        activatedByMembershipId: actor.membershipId,
      });
      return viewOf(saved, organizationId);
    },
  };
}
