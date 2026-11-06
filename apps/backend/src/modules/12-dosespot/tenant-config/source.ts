// apps/backend/src/modules/12-dosespot/tenant-config/source.ts — the database-backed {@link DoseSpotTenantConfigSource}: the
// per-tenant `dosespot_clinic_registration` row behind the layered resolver (the env map stays the fallback for an org with NO
// row). The clearinghouse resolver's discipline: every lookup re-reads the org's row (one indexed lookup, RLS-scoped by
// `withOrgContext`), but the sealed credential is opened once per row `version`, so a rotation takes effect on the next call
// and a deactivation on the very next lookup. Relay ticks and workers are not requests: this never reads a request context.
//
// FAIL CLOSED. Only an `active` row operates (a `verified` one may also do setup: a prescriber's vendor enrolment). A row whose
// environment the platform cannot serve (production with the flag off, or no host) is not usable. A credential that cannot be
// opened, or with no Subscription-Key anywhere, THROWS a typed 503 (the job fails and retries, loudly) rather than going
// unbound silently or sending a request without one.
import { type DbClient, schema } from "@chartwarden/db";
import {
  type DoseSpotConfigPurpose,
  type DoseSpotEnvironment,
  type DoseSpotTenantConfig,
  type DoseSpotTenantConfigSource,
  resolveDoseSpotEnvironment,
  subscriptionKeyFallback,
} from "@chartwarden/dosespot";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import type { ConfigRow } from "./config-store";
import type { ClinicSecretCipher } from "./secret-cipher";

const R = schema.dosespotClinicRegistrations;

const unreadable = (why: string): ChartWardenError =>
  new ChartWardenError(
    "DOSESPOT_CREDENTIAL_UNREADABLE",
    `this organization's DoseSpot credential cannot be used: ${why}`,
    503,
  );

export interface DrizzleTenantConfigSourceDeps {
  /** The TENANT pool (NOBYPASSRLS): the read is bound by the org's own RLS scope. */
  readonly db?: DbClient;
  readonly cipher?: ClinicSecretCipher | undefined;
  /** The platform's settings (production flag, hosts, Subscription-Key fallbacks), passed in by the composition root. */
  readonly platformEnv: Readonly<Record<string, string | undefined>>;
  /** Test seam: replaces the RLS-scoped Drizzle read of the org's row. */
  readonly readRow?: (organizationId: string) => Promise<ConfigRow | null>;
}

const usableFor = (status: string, purpose: DoseSpotConfigPurpose): boolean =>
  purpose === "operate" ? status === "active" : status === "active" || status === "verified";

export function createDrizzleTenantConfigSource(
  deps: DrizzleTenantConfigSourceDeps,
): DoseSpotTenantConfigSource {
  const built = new Map<
    string,
    { readonly version: number; readonly config: DoseSpotTenantConfig }
  >();

  const readRow = (organizationId: string): Promise<ConfigRow | null> => {
    if (deps.readRow) return deps.readRow(organizationId);
    const db = deps.db;
    if (!db) throw new Error("the DoseSpot config source needs a database or a row reader");
    return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const [row] = await (tx as unknown as DbClient)
        .select()
        .from(R)
        .where(eq(R.organizationId, organizationId))
        .limit(1);
      return row ?? null;
    });
  };

  async function build(row: ConfigRow, baseUrl: string): Promise<DoseSpotTenantConfig> {
    const cached = built.get(row.organizationId);
    if (cached?.version === row.version) return cached.config;
    if (
      !deps.cipher ||
      !row.secretCipher ||
      !row.secretDekRef ||
      !row.clinicId ||
      !row.serviceClinicianId
    ) {
      throw unreadable("it has no sealed key");
    }
    const environment = row.environment as DoseSpotEnvironment;
    let bundle: Awaited<ReturnType<ClinicSecretCipher["decrypt"]>>;
    try {
      bundle = await deps.cipher.decrypt(
        row.organizationId,
        { environment, clinicId: row.clinicId },
        row.secretCipher,
        row.secretDekRef,
      );
    } catch {
      // the cipher's refusal is generic by design; nothing about the key leaks
      throw unreadable("the sealed key could not be opened; it must be entered again");
    }
    const subscriptionKey =
      bundle.subscriptionKey ?? subscriptionKeyFallback(environment, deps.platformEnv);
    if (!subscriptionKey) throw unreadable("no Subscription-Key is available for its environment");
    const config: DoseSpotTenantConfig = {
      baseUrl,
      subscriptionKey,
      clinicId: row.clinicId,
      clinicKey: bundle.clinicKey,
      serviceClinicianId: row.serviceClinicianId,
      epcsCertified: false, // EPCS stays under the D18 certification gate: no registration can switch it on
      version: row.version,
    };
    built.set(row.organizationId, { version: row.version, config });
    return config;
  }

  return {
    async lookup(organizationId, purpose) {
      const row = await readRow(organizationId);
      if (!row) return { kind: "absent" };
      const resolved = resolveDoseSpotEnvironment(
        row.environment as DoseSpotEnvironment,
        deps.platformEnv,
      );
      return {
        kind: "present",
        usable: usableFor(row.status, purpose) && resolved.ok,
        load: () =>
          resolved.ok
            ? build(row, resolved.baseUrl)
            : Promise.reject(unreadable("its environment is not available")),
      };
    },
  };
}
