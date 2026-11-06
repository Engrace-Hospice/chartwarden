// apps/backend/src/modules/12-dosespot/tenant-config/service.ts — the rules of a tenant's DoseSpot clinic registration (tenant
// onboarding slice 4, ADR-0110). Pure of transport and HTTP: every method takes a `ConfigStore` bound to one open org-scoped
// transaction, so the tenant's own routes and a platform operator's onboarding writes run the SAME code under the tenant's own
// RLS, and a rule is tested without a database.
//
//   put         save the environment, clinic id, service clinician and credential. Complete => `registered`; incomplete =>
//               `draft` (the wizard can resume). ANY change to the target (environment, clinic), the clinician or a secret puts
//               the row back to `registered` / `draft` for the new credential: what the old one earned (the test, the activation)
//               is cleared and e-prescribing pauses until it is re-tested and re-activated. A change of environment or clinic
//               also drops the sealed key (it is bound to the old target). The tenant lane may rotate a Subscription-Key but
//               never introduce one (it may be the platform's own key); ops may set it.
//   verify      registered -> verified, in three steps that never hold a transaction across the vendor call: `prepareVerify`
//               reads and unseals (read-only, no lock), `runProbe` mints one token with no transaction open, `completeVerify`
//               locks the row and compare-and-sets on the version it read (409 when the config moved meanwhile).
//   activate    verified -> active (production only when the platform has enabled it).
//   deactivate  active -> verified: nothing the credential earned is lost, so no new test is owed.
//
// The credential is write-only: no view carries it (a `hasSecret` flag is derived). Nothing here logs or audits a value; the
// row's M4 write-audit trigger records that the secret changed, never what it was.
import {
  type ConnectionProbeOutcome,
  type DoseSpotConnectionProbe,
  type DoseSpotEnvironment,
  type DoseSpotTenantConfig,
  resolveDoseSpotEnvironment,
  subscriptionKeyFallback,
} from "@chartwarden/dosespot";
import { ChartWardenError, ValidationError } from "@chartwarden/types";
import type { ConfigPatch, ConfigRow, ConfigStore } from "./config-store";
import { isUniqueViolation } from "./config-store";
import type { ClinicSecretBundle, ClinicSecretCipher } from "./secret-cipher";

export type DoseSpotClinicStatus = "draft" | "registered" | "verified" | "active";

const ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;
const SECRET_SHAPE = /^[\x21-\x7e]{8,512}$/; // printable ASCII, no whitespace

/** Who acts: server-assembled from the session (a tenant admin, or the platform operator acting for the tenant). */
export interface ClinicActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
  /** `platform` only for the platform-ops lane. Absent = the tenant's own lane: the safe default for anything that did not say. */
  readonly lane?: "platform";
}

export interface PutClinicInput {
  readonly environment: DoseSpotEnvironment;
  readonly clinicId?: string;
  readonly serviceClinicianId?: string;
  /** Write-only. Omit to keep the stored one (an unchanged target) or to leave a draft without it. */
  readonly clinicKey?: string;
  /** Write-only. Ops may set it; the tenant lane may only rotate one that exists. */
  readonly subscriptionKey?: string;
}

export interface ClinicConfigView {
  readonly source: "tenant" | "platform_env" | "none";
  readonly status: DoseSpotClinicStatus | null;
  readonly environment: DoseSpotEnvironment | null;
  readonly clinicId: string | null;
  readonly serviceClinicianId: string | null;
  readonly hasSecret: boolean;
  readonly registeredAt: string | null;
  readonly verifiedAt: string | null;
  readonly activatedAt: string | null;
  readonly lastTest: {
    readonly outcome: ConnectionProbeOutcome;
    readonly at: string;
  } | null;
  /** Roster prescribers already linked to DoseSpot. A fact for the screen, never a gate on activation. */
  readonly prescribersEnrolled: number;
  /** Signed orders waiting to transmit: they pause while the registration is not active. */
  readonly queuedTransmissions: number;
  readonly version: number | null;
  readonly updatedAt: string | null;
}

export interface DoseSpotClinicServiceDeps {
  /** Seals and opens the credential; absent => a credential write answers 503 and nothing is stored. */
  readonly cipher?: ClinicSecretCipher;
  readonly probe: DoseSpotConnectionProbe;
  /** The platform's environment variables (production flag, hosts, Subscription-Key fallbacks). Read per call, never cached. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  /** Is this org served by the env fallback (`DOSESPOT_TENANT_CONFIGS`) because it has no row? */
  readonly envFallbackFor?: (organizationId: string) => boolean;
}

/** What `prepareVerify` read: everything `completeVerify` needs, so no store call is open while the vendor is called. */
export interface VerifyPlan {
  /** The row version the plan was read at; `completeVerify` compare-and-sets on it. */
  readonly version: number;
  /** The candidate config, unsealed. Held in memory for the one probe; never logged, audited or returned. */
  readonly config: DoseSpotTenantConfig;
}

export interface PutResult {
  readonly created: boolean;
  readonly view: ClinicConfigView;
  /** Names of the fields the put changed (never values), for the field-level audit row. */
  readonly changedFields: readonly string[];
  /** The registration was `active` and this change took it out of service. */
  readonly leftActive: boolean;
}

export interface TransitionResult {
  readonly view: ClinicConfigView;
  /** False when the call found the row already there (idempotent): emit nothing. */
  readonly changed: boolean;
}

export interface DoseSpotClinicService {
  view(store: ConfigStore, organizationId: string): Promise<ClinicConfigView>;
  put(
    store: ConfigStore,
    actor: ClinicActor,
    input: PutClinicInput,
    expectedVersion: number | undefined,
  ): Promise<PutResult>;
  /** Step 1: read-only, no lock. */
  prepareVerify(store: ConfigStore, actor: ClinicActor): Promise<VerifyPlan>;
  /** Step 2: the vendor call (no store, no transaction). Never throws: a probe that fails is `unreachable`. */
  runProbe(plan: VerifyPlan): Promise<ConnectionProbeOutcome>;
  /** Step 3: lock, compare-and-set on the plan's version, record. */
  completeVerify(
    store: ConfigStore,
    actor: ClinicActor,
    plan: VerifyPlan,
    outcome: ConnectionProbeOutcome,
  ): Promise<{
    readonly view: ClinicConfigView;
    readonly test: { readonly outcome: ConnectionProbeOutcome };
  }>;
  activate(store: ConfigStore, actor: ClinicActor): Promise<TransitionResult>;
  deactivate(store: ConfigStore, actor: ClinicActor): Promise<TransitionResult>;
}

/** Opens one transaction and hands the callback a store bound to it (each call is its own transaction). */
export type ConfigTx = <T>(fn: (store: ConfigStore) => Promise<T>) => Promise<T>;

/**
 * The verify flow across its two transactions: read and unseal, probe with NO transaction open, then lock and write. A probe is
 * a network call to the vendor: it must never run while a row lock or a pooled connection is held.
 */
export async function verifyConnection(
  service: DoseSpotClinicService,
  tx: ConfigTx,
  actor: ClinicActor,
): Promise<{
  readonly view: ClinicConfigView;
  readonly test: { readonly outcome: ConnectionProbeOutcome };
}> {
  const plan = await tx((store) => service.prepareVerify(store, actor));
  const outcome = await service.runProbe(plan);
  return tx((store) => service.completeVerify(store, actor, plan, outcome));
}

const conflict = (code: string, message: string): ChartWardenError =>
  new ChartWardenError(code, message, 409);
const versionConflict = (message: string): ChartWardenError =>
  new ChartWardenError("VERSION_CONFLICT", message, 412);
const invalid = (field: string, code: string, message: string): ValidationError =>
  new ValidationError("request validation failed", [{ field, code, message }]);

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Everything a credential the vendor has not been shown yet has NOT earned. */
const EARNED_CLEARED = {
  verifiedAt: null,
  verifiedByMembershipId: null,
  lastTestAt: null,
  lastTestOutcome: null,
  activatedAt: null,
  activatedByMembershipId: null,
} as const satisfies ConfigPatch;

function validateInput(input: PutClinicInput): void {
  if (input.clinicId !== undefined && !ID_SHAPE.test(input.clinicId)) {
    throw invalid(
      "clinicId",
      "DOSESPOT_CLINIC_ID_INVALID",
      "the clinic id must be 1-64 letters, digits, dots, dashes or underscores",
    );
  }
  if (input.serviceClinicianId !== undefined && !ID_SHAPE.test(input.serviceClinicianId)) {
    throw invalid(
      "serviceClinicianId",
      "DOSESPOT_CLINICIAN_ID_INVALID",
      "the service clinician id must be 1-64 letters, digits, dots, dashes or underscores",
    );
  }
  for (const field of ["clinicKey", "subscriptionKey"] as const) {
    const value = input[field];
    if (value !== undefined && !SECRET_SHAPE.test(value)) {
      throw invalid(
        field,
        "DOSESPOT_SECRET_INVALID",
        "a key must be 8-512 printable characters with no spaces",
      );
    }
  }
}

export function createDoseSpotClinicService(
  deps: DoseSpotClinicServiceDeps,
): DoseSpotClinicService {
  const now = deps.now ?? (() => new Date());
  const env = (): Readonly<Record<string, string | undefined>> => deps.env ?? {};

  async function viewOf(
    store: ConfigStore,
    row: ConfigRow | null,
    organizationId: string,
  ): Promise<ClinicConfigView> {
    const [prescribersEnrolled, queuedTransmissions] = await Promise.all([
      store.vendorEnrolledPrescribers(organizationId),
      store.queuedTransmissions(organizationId),
    ]);
    if (!row) {
      const fallback = deps.envFallbackFor?.(organizationId) === true;
      return {
        source: fallback ? "platform_env" : "none",
        status: fallback ? "active" : null,
        environment: null,
        clinicId: null,
        serviceClinicianId: null,
        hasSecret: false,
        registeredAt: null,
        verifiedAt: null,
        activatedAt: null,
        lastTest: null,
        prescribersEnrolled,
        queuedTransmissions,
        version: null,
        updatedAt: null,
      };
    }
    return {
      source: "tenant",
      status: row.status as DoseSpotClinicStatus,
      environment: row.environment as DoseSpotEnvironment,
      clinicId: row.clinicId,
      serviceClinicianId: row.serviceClinicianId,
      hasSecret: row.secretCipher !== null,
      registeredAt: iso(row.registeredAt),
      verifiedAt: iso(row.verifiedAt),
      activatedAt: iso(row.activatedAt),
      lastTest:
        row.lastTestOutcome && row.lastTestAt
          ? {
              outcome: row.lastTestOutcome as ConnectionProbeOutcome,
              at: row.lastTestAt.toISOString(),
            }
          : null,
      prescribersEnrolled,
      queuedTransmissions,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  const requireCipher = (): ClinicSecretCipher => {
    if (!deps.cipher) {
      throw new ChartWardenError(
        "DOSESPOT_CIPHER_UNBOUND",
        "DoseSpot credentials cannot be stored: no tenant key ring is bound in this deployment",
        503,
      );
    }
    return deps.cipher;
  };

  /** The base URL for the row's environment, or the typed 409 that says why none is available. */
  function baseUrlFor(environment: DoseSpotEnvironment): string {
    const resolved = resolveDoseSpotEnvironment(environment, env());
    if (resolved.ok) return resolved.baseUrl;
    const refusal = {
      production_disabled: [
        "DOSESPOT_PRODUCTION_NOT_ENABLED",
        "DoseSpot production is not enabled on this deployment; use the sandbox environment",
      ],
      production_url_unset: [
        "DOSESPOT_PRODUCTION_URL_UNSET",
        "the DoseSpot production host is not configured on this deployment",
      ],
      base_url_invalid: [
        "DOSESPOT_BASE_URL_INVALID",
        "the configured DoseSpot host for this environment is not an acceptable https dosespot.com address",
      ],
    }[resolved.reason];
    throw conflict(refusal[0] as string, refusal[1] as string);
  }

  async function lockedRow(store: ConfigStore, organizationId: string): Promise<ConfigRow> {
    const row = await store.findForUpdate(organizationId);
    if (!row) {
      throw conflict(
        "DOSESPOT_NOT_CONFIGURED",
        "no DoseSpot clinic has been registered for this organization yet",
      );
    }
    return row;
  }

  async function save(store: ConfigStore, row: ConfigRow, patch: ConfigPatch): Promise<ConfigRow> {
    const updated = await store.update(row.organizationId, row.version, {
      ...patch,
      updatedAt: now(),
    });
    if (!updated)
      throw versionConflict("the DoseSpot registration changed while it was being updated");
    return updated;
  }

  /** The stored bundle, or null when it cannot be opened (the caller decides whether that matters). */
  async function openStored(row: ConfigRow): Promise<ClinicSecretBundle | null> {
    if (!row.secretCipher || !row.secretDekRef || !row.clinicId) return null;
    try {
      return await requireCipher().decrypt(
        row.organizationId,
        { environment: row.environment as DoseSpotEnvironment, clinicId: row.clinicId },
        row.secretCipher,
        row.secretDekRef,
      );
    } catch (err) {
      if (err instanceof ChartWardenError) throw err;
      return null;
    }
  }

  /** What a put means for the secrets of the row: the new bundle (or none), and the names of what changed. */
  async function nextSecrets(
    actor: ClinicActor,
    existing: ConfigRow | null,
    input: PutClinicInput,
    target: { readonly environment: DoseSpotEnvironment; readonly clinicId: string | null },
    retargeted: boolean,
  ): Promise<{
    readonly bundle: ClinicSecretBundle | null;
    readonly changed: readonly string[];
    readonly keep: boolean;
  }> {
    const supplied = input.clinicKey !== undefined || input.subscriptionKey !== undefined;
    const changed: string[] = [];
    // A retarget drops the old key (it is bound to the old target); nothing supplied => nothing carried.
    const stored = existing && !retargeted && supplied ? await openStored(existing) : null;
    if (input.subscriptionKey !== undefined && actor.lane !== "platform") {
      if (!stored?.subscriptionKey) {
        throw invalid(
          "subscriptionKey",
          "DOSESPOT_SUBSCRIPTION_KEY_PLATFORM_ONLY",
          "a Subscription-Key can only be set by platform support; you may rotate one that platform support set",
        );
      }
    }
    if (!supplied) {
      if (retargeted && existing?.secretCipher)
        return { bundle: null, changed: ["clinicKey"], keep: false };
      return { bundle: null, changed, keep: true };
    }
    const clinicKey = input.clinicKey ?? stored?.clinicKey;
    if (clinicKey === undefined) {
      if (existing?.secretCipher && !retargeted) {
        throw conflict(
          "DOSESPOT_SECRET_UNREADABLE",
          "the stored DoseSpot key could not be opened; enter the clinic key again",
        );
      }
      throw invalid(
        "clinicKey",
        "DOSESPOT_CLINIC_KEY_REQUIRED",
        "the clinic key is required to store a Subscription-Key",
      );
    }
    if (target.clinicId === null) {
      throw invalid(
        "clinicId",
        "DOSESPOT_CLINIC_ID_REQUIRED",
        "the clinic id is needed to seal the key against",
      );
    }
    const subscriptionKey = input.subscriptionKey ?? stored?.subscriptionKey;
    if (input.clinicKey !== undefined) changed.push("clinicKey");
    if (input.subscriptionKey !== undefined) changed.push("subscriptionKey");
    return {
      bundle: { clinicKey, ...(subscriptionKey ? { subscriptionKey } : {}) },
      changed,
      keep: false,
    };
  }

  async function put(
    store: ConfigStore,
    actor: ClinicActor,
    input: PutClinicInput,
    expectedVersion: number | undefined,
  ): Promise<PutResult> {
    validateInput(input);
    const { organizationId } = actor;
    const existing = await store.findForUpdate(organizationId);
    if (!existing && expectedVersion !== undefined) {
      throw versionConflict(
        "no DoseSpot registration exists for this organization; omit If-Match to create it",
      );
    }
    if (existing) {
      if (expectedVersion === undefined) {
        throw new ChartWardenError(
          "IF_MATCH_REQUIRED",
          "an If-Match header is required on this route",
          428,
        );
      }
      if (expectedVersion !== existing.version) {
        throw versionConflict("the DoseSpot registration changed since it was read");
      }
    }
    const clinicId = input.clinicId ?? existing?.clinicId ?? null;
    const clinician = input.serviceClinicianId ?? existing?.serviceClinicianId ?? null;
    const retargeted =
      existing !== null &&
      (existing.environment !== input.environment ||
        (existing.clinicId !== null && existing.clinicId !== clinicId));
    const secrets = await nextSecrets(
      actor,
      existing,
      input,
      { environment: input.environment, clinicId },
      retargeted,
    );

    const changedFields = [
      ...(!existing || existing.environment !== input.environment ? ["environment"] : []),
      ...(clinicId !== (existing?.clinicId ?? null) ? ["clinicId"] : []),
      ...(clinician !== (existing?.serviceClinicianId ?? null) ? ["serviceClinicianId"] : []),
      ...secrets.changed,
    ];
    if (existing && changedFields.length === 0) {
      return {
        created: false,
        view: await viewOf(store, existing, organizationId),
        changedFields,
        leftActive: false,
      };
    }

    const sealed =
      secrets.bundle && clinicId !== null
        ? await requireCipher().encrypt(organizationId, secrets.bundle, {
            environment: input.environment,
            clinicId,
          })
        : null;
    const cipher = secrets.keep ? (existing?.secretCipher ?? null) : (sealed?.cipher ?? null);
    const dekRef = secrets.keep ? (existing?.secretDekRef ?? null) : (sealed?.dekRef ?? null);
    const complete = clinicId !== null && clinician !== null && cipher !== null;
    const patch: ConfigPatch = {
      environment: input.environment,
      clinicId,
      serviceClinicianId: clinician,
      secretCipher: cipher,
      secretDekRef: dekRef,
      status: complete ? "registered" : "draft",
      registeredAt: complete ? now() : null,
      registeredByMembershipId: complete ? actor.membershipId : null,
      setByMembershipId: actor.membershipId,
      ...EARNED_CLEARED,
    };
    if (!existing) {
      try {
        const row = await store.insert({
          organizationId,
          ...patch,
          setByMembershipId: actor.membershipId,
          version: 1,
        } as never);
        return {
          created: true,
          view: await viewOf(store, row, organizationId),
          changedFields,
          // an org the env fallback was serving stops being served the moment it has a row of its own (a row is authoritative)
          leftActive: deps.envFallbackFor?.(organizationId) === true,
        };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        throw versionConflict(
          "a DoseSpot registration was created concurrently; read it and send its version in If-Match",
        );
      }
    }
    const row = await save(store, existing, patch);
    return {
      created: false,
      view: await viewOf(store, row, organizationId),
      changedFields,
      leftActive: existing.status === "active",
    };
  }

  async function prepareVerify(store: ConfigStore, actor: ClinicActor): Promise<VerifyPlan> {
    const row = await store.find(actor.organizationId);
    if (!row) {
      throw conflict(
        "DOSESPOT_NOT_CONFIGURED",
        "no DoseSpot clinic has been registered for this organization yet",
      );
    }
    if (row.status === "draft" || !row.clinicId || !row.serviceClinicianId || !row.secretCipher) {
      throw conflict(
        "DOSESPOT_NOT_REGISTERED",
        "save the clinic id, the service clinician and the clinic key before testing the connection",
      );
    }
    const environment = row.environment as DoseSpotEnvironment;
    const baseUrl = baseUrlFor(environment);
    const bundle = await openStored(row);
    if (!bundle) {
      throw conflict(
        "DOSESPOT_SECRET_UNREADABLE",
        "the stored DoseSpot key could not be opened; enter the clinic key again",
      );
    }
    const subscriptionKey = bundle.subscriptionKey ?? subscriptionKeyFallback(environment, env());
    if (!subscriptionKey) {
      throw conflict(
        "DOSESPOT_SUBSCRIPTION_KEY_MISSING",
        "no DoseSpot Subscription-Key is available for this environment; platform support must provide one",
      );
    }
    return {
      version: row.version,
      config: {
        baseUrl,
        subscriptionKey,
        clinicId: row.clinicId,
        clinicKey: bundle.clinicKey,
        serviceClinicianId: row.serviceClinicianId,
        epcsCertified: false,
        version: row.version,
      },
    };
  }

  async function runProbe(plan: VerifyPlan): Promise<ConnectionProbeOutcome> {
    try {
      return await deps.probe.probe(plan.config);
    } catch {
      return "unreachable"; // a probe that throws is a vendor we could not reach, not a failed request
    }
  }

  async function completeVerify(
    store: ConfigStore,
    actor: ClinicActor,
    plan: VerifyPlan,
    outcome: ConnectionProbeOutcome,
  ) {
    const { organizationId } = actor;
    const row = await store.findForUpdate(organizationId);
    if (!row || row.version !== plan.version) {
      throw conflict(
        "DOSESPOT_CHANGED_DURING_VERIFY",
        "the DoseSpot registration changed while it was being tested; test it again",
      );
    }
    const at = now();
    const tested = { lastTestAt: at, lastTestOutcome: outcome };
    // Only a registered row is promoted; a live or verified one keeps its status (a failed re-test never deactivates it).
    const promote =
      outcome === "ok" && row.status === "registered"
        ? { status: "verified", verifiedAt: at, verifiedByMembershipId: actor.membershipId }
        : {};
    const saved = await save(store, row, { ...tested, ...promote });
    return { view: await viewOf(store, saved, organizationId), test: { outcome } };
  }

  async function activate(store: ConfigStore, actor: ClinicActor): Promise<TransitionResult> {
    const { organizationId } = actor;
    const row = await lockedRow(store, organizationId);
    if (row.status === "active")
      return { view: await viewOf(store, row, organizationId), changed: false };
    // `verified` AND the latest test passed: a failed re-test leaves the row `verified` (it never demotes a live one) but it must pass again
    if (row.status !== "verified" || row.lastTestOutcome !== "ok") {
      throw conflict("DOSESPOT_NOT_VERIFIED", "test the DoseSpot connection before activating it");
    }
    baseUrlFor(row.environment as DoseSpotEnvironment); // production re-checks the platform flag at the moment of activation
    const saved = await save(store, row, {
      status: "active",
      activatedAt: now(),
      activatedByMembershipId: actor.membershipId,
    });
    return { view: await viewOf(store, saved, organizationId), changed: true };
  }

  async function deactivate(store: ConfigStore, actor: ClinicActor): Promise<TransitionResult> {
    const { organizationId } = actor;
    const row = await lockedRow(store, organizationId);
    if (row.status === "verified")
      return { view: await viewOf(store, row, organizationId), changed: false };
    if (row.status !== "active") {
      throw conflict(
        "DOSESPOT_NOT_ACTIVE",
        "only an active DoseSpot registration can be deactivated",
      );
    }
    const saved = await save(store, row, {
      status: "verified",
      activatedAt: null,
      activatedByMembershipId: null,
    });
    return { view: await viewOf(store, saved, organizationId), changed: true };
  }

  return {
    view: async (store, organizationId) =>
      viewOf(store, await store.find(organizationId), organizationId),
    put,
    prepareVerify,
    runProbe,
    completeVerify,
    activate,
    deactivate,
  };
}
