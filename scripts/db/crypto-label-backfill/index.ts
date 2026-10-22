// ChartWarden - crypto context-label rename, RELEASE 2: the module registry and the per-tenant driver of the label backfill.
// The CLI (scripts/db/backfill-crypto-labels.ts) builds the dependencies; the live suite builds them over private containers.
import type { Buffer } from "node:buffer";
import type { DbClient } from "@chartwarden/db";
import type { PseudonymKekRing } from "@chartwarden/subscription-billing";
import type { PlatformKekAdapter } from "../../../apps/backend/src/bootstrap/tenant-kek";
import type { PatientIdentifierCipher } from "../../../apps/backend/src/modules/05-patient/identifiers/identifier-cipher";
import type { MacSecretCipher } from "../../../apps/backend/src/modules/23-billing-medicare/routes/secret-cipher";
import {
  type Counts,
  type Mode,
  type RunOptions,
  type Scan,
  type TableReport,
  addCounts,
  emptyCounts,
  runScan,
} from "./core";
import { m5IdentifierScan } from "./m5";
import { m23MacCredentialScan } from "./m23";
import { m24TradingPartnerScan } from "./m24";
import { type M34Hooks, m34KeyRingScan } from "./m34";
import { m35PseudonymKeyScan } from "./m35";
import {
  type M36BodyKit,
  M36_VIA_FUNCTION_TABLES,
  MissingResealCredentialError,
  m36BodyScan,
} from "./m36-body";
import { m36ExportJobScan } from "./m36-export";
import {
  type M36SearchDeps,
  m36SearchFinish,
  m36SearchPrepare,
  m36SearchScan,
  m36SearchState,
} from "./m36-search";

/** Lowest-risk first; the tenant key ring (every tenant's PHI depends on it) last. */
export const ALL_MODULES = [
  "m24",
  "m23",
  "m35",
  "m5",
  "m36-body",
  "m36-search",
  "m36-export",
  "m34",
] as const;
export type ModuleId = (typeof ALL_MODULES)[number];

/** Modules whose table has no organization_id: they run once, not per tenant. */
const GLOBAL_MODULES: ReadonlySet<ModuleId> = new Set(["m35"]);

export class MissingDependencyError extends Error {
  constructor(
    readonly module: ModuleId,
    what: string,
  ) {
    super(`module ${module} cannot run: ${what}`);
    this.name = "MissingDependencyError";
  }
}

export interface BackfillDeps {
  /** The tenant pool (chartwarden_app, RLS enforced). */
  readonly db: DbClient;
  /** The platform pool: key ring and pseudonym keys. */
  readonly platformDb: DbClient;
  /** A member of chartwarden_m36_reseal (M36 revision / poll / draft / scheduled tables). */
  readonly resealDb?: DbClient | undefined;
  readonly identifierCipher?: PatientIdentifierCipher | undefined;
  readonly macCipher?: MacSecretCipher | undefined;
  /** M24_CREDENTIAL_ENCRYPTION_KEY. */
  readonly credentialKek?: Buffer | undefined;
  readonly kekAdapter?: PlatformKekAdapter | undefined;
  readonly pseudonymRing?: PseudonymKekRing | null | undefined;
  readonly bodyKit?: M36BodyKit | undefined;
  readonly search?: M36SearchDeps | undefined;
  /** `--i-have-a-backup`. */
  readonly backupConfirmed: boolean;
  readonly m34Hooks?: M34Hooks | undefined;
}

export interface BackfillRequest extends RunOptions {
  readonly modules: readonly ModuleId[];
  /** The tenants to process (already resolved by the caller; never empty for a tenant module). */
  readonly organizationIds: readonly string[];
}

export interface ModuleReport {
  readonly module: ModuleId;
  readonly tables: readonly TableReport[];
  readonly total: Counts;
}

export interface BackfillReport {
  readonly mode: Mode;
  readonly modules: readonly ModuleReport[];
  /** Rows that still open ONLY under the legacy label, summed (apply: those this run could not fix). */
  readonly legacyOnlyTotal: number;
  /** Rows that open under neither label, plus failed re-seals: either one blocks release 3. */
  readonly problemTotal: number;
}

function need<T>(module: ModuleId, what: string, value: T | null | undefined): T {
  if (value === null || value === undefined) throw new MissingDependencyError(module, what);
  return value;
}

async function runModuleForOrg(
  module: ModuleId,
  deps: BackfillDeps,
  organizationId: string | null,
  options: RunOptions,
): Promise<TableReport[]> {
  const run = <R>(scan: Scan<R>) => runScan(scan, options);
  const org = organizationId as string;
  switch (module) {
    case "m5":
      return [
        await run(
          m5IdentifierScan(
            {
              db: deps.db,
              cipher: need(module, "no identifier cipher (M34 key ring)", deps.identifierCipher),
            },
            org,
          ),
        ),
      ];
    case "m23":
      return [
        await run(
          m23MacCredentialScan(
            {
              db: deps.db,
              cipher: need(module, "M24_CREDENTIAL_ENCRYPTION_KEY is not set", deps.macCipher),
            },
            org,
          ),
        ),
      ];
    case "m24":
      return [
        await run(
          m24TradingPartnerScan(
            {
              db: deps.db,
              kek: need(module, "M24_CREDENTIAL_ENCRYPTION_KEY is not set", deps.credentialKek),
            },
            org,
          ),
        ),
      ];
    case "m34":
      return [
        await run(
          m34KeyRingScan(
            {
              platformDb: deps.platformDb,
              kek: need(module, "M34_TENANT_KEK is not set", deps.kekAdapter),
              backupConfirmed: deps.backupConfirmed,
              ...(deps.m34Hooks ? { hooks: deps.m34Hooks } : {}),
            },
            org,
          ),
        ),
      ];
    case "m35":
      return [
        await run(
          m35PseudonymKeyScan({
            platformDb: deps.platformDb,
            ring: need(module, "M35_PSEUDONYM_KEY_KEK is not set", deps.pseudonymRing),
          }),
        ),
      ];
    case "m36-body": {
      const kit = need(module, "no message-body key kit", deps.bodyKit);
      // Checked BEFORE the first table: a run must not re-seal `message` and then fail on the next table.
      if (!deps.resealDb) throw new MissingResealCredentialError();
      const tables = ["message", ...M36_VIA_FUNCTION_TABLES] as const;
      const reports: TableReport[] = [];
      for (const table of tables) {
        reports.push(
          await run(m36BodyScan({ db: deps.db, resealDb: deps.resealDb, kit }, org, table)),
        );
      }
      return reports;
    }
    case "m36-export":
      return [
        await run(
          m36ExportJobScan(
            { db: deps.db, kek: need(module, "M34_TENANT_KEK is not set", deps.kekAdapter) },
            org,
          ),
        ),
      ];
    case "m36-search": {
      const search = need(module, "no search key provider", deps.search);
      const { keyVersion, tagBits } = await m36SearchState(search, org);
      const prepared =
        options.mode === "apply" && tagBits !== undefined
          ? await m36SearchPrepare(search, org, keyVersion)
          : undefined;
      const report = await run(m36SearchScan(search, org, keyVersion, tagBits));
      if (prepared) await m36SearchFinish(search, org, prepared, report);
      return [report];
    }
  }
}

/** Run the selected modules, in the safe order, for every tenant (platform-wide modules once). */
export async function runBackfill(
  deps: BackfillDeps,
  request: BackfillRequest,
): Promise<BackfillReport> {
  const selected = ALL_MODULES.filter((m) => request.modules.includes(m));
  const reports: ModuleReport[] = [];
  for (const module of selected) {
    const tables: TableReport[] = [];
    const orgs = GLOBAL_MODULES.has(module) ? [null] : request.organizationIds;
    for (const organizationId of orgs) {
      tables.push(...(await runModuleForOrg(module, deps, organizationId, request)));
    }
    reports.push({
      module,
      tables,
      total: tables.reduce((sum, t) => addCounts(sum, t.counts), emptyCounts),
    });
  }
  const sum = (pick: (c: Counts) => number) => reports.reduce((n, r) => n + pick(r.total), 0);
  return {
    mode: request.mode,
    modules: reports,
    legacyOnlyTotal: sum((c) => c.legacyOnly),
    problemTotal: sum((c) => c.unreadable + c.failed),
  };
}
