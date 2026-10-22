// ChartWarden - crypto context-label rename, RELEASE 3: the module registry and the per-tenant driver of the READ-ONLY label verifier.
// The CLI (scripts/db/backfill-crypto-labels.ts) builds the dependencies; the live suite builds them over private containers.
import type { Buffer } from "node:buffer";
import type { DbClient } from "@chartwarden/db";
import type { PseudonymKekRing } from "@chartwarden/subscription-billing";
import type { PlatformKekAdapter } from "../../../apps/backend/src/bootstrap/tenant-kek";
import type { PatientIdentifierCipher } from "../../../apps/backend/src/modules/05-patient/identifiers/identifier-cipher";
import type { MacSecretCipher } from "../../../apps/backend/src/modules/23-billing-medicare/routes/secret-cipher";
import {
  type Counts,
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
import { m34KeyRingScan } from "./m34";
import { m35PseudonymKeyScan } from "./m35";
import { type M36BodyKit, m36BodyScan } from "./m36-body";
import { m36ExportJobScan } from "./m36-export";
import { type M36SearchDeps, m36SearchScan, m36SearchState } from "./m36-search";

/** The tenant key ring (every tenant's PHI depends on it) last. */
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

export interface VerifyDeps {
  /** The tenant pool (chartwarden_app, RLS enforced). */
  readonly db: DbClient;
  /** The platform pool: key ring and pseudonym keys. */
  readonly platformDb: DbClient;
  readonly identifierCipher?: PatientIdentifierCipher | undefined;
  readonly macCipher?: MacSecretCipher | undefined;
  /** M24_CREDENTIAL_ENCRYPTION_KEY. */
  readonly credentialKek?: Buffer | undefined;
  readonly kekAdapter?: PlatformKekAdapter | undefined;
  readonly pseudonymRing?: PseudonymKekRing | null | undefined;
  readonly bodyKit?: M36BodyKit | undefined;
  readonly search?: M36SearchDeps | undefined;
}

export interface VerifyRequest extends RunOptions {
  readonly modules: readonly ModuleId[];
  /** The tenants to process (already resolved by the caller; never empty for a tenant module). */
  readonly organizationIds: readonly string[];
}

export interface ModuleReport {
  readonly module: ModuleId;
  readonly tables: readonly TableReport[];
  readonly total: Counts;
}

export interface VerifyReport {
  readonly modules: readonly ModuleReport[];
  /** Rows that do not open under the one remaining label (corrupt, key gone, or still sealed under the removed legacy label). */
  readonly problemTotal: number;
  /**
   * True only when every selected table of every selected tenant was scanned to its end. A run stopped by `--max-rows` or an
   * interrupt is NOT complete, whatever its counts say, and must never be read as "nothing unreadable".
   */
  readonly complete: boolean;
  /** The modules this run covered. */
  readonly modulesCovered: readonly ModuleId[];
  /**
   * True only when EVERY module was selected. A `--module m5` run covers one module and must never be read as "nothing is
   * unreadable"; the CLI exits 2 unless this is true. (message_revision / message_poll_option / message_draft /
   * scheduled_message are never covered by this build; only the release-2 build can check them.)
   */
  readonly allModules: boolean;
}

function need<T>(module: ModuleId, what: string, value: T | null | undefined): T {
  if (value === null || value === undefined) throw new MissingDependencyError(module, what);
  return value;
}

async function runModuleForOrg(
  module: ModuleId,
  deps: VerifyDeps,
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
    case "m36-body":
      return [
        await run(
          m36BodyScan(
            { db: deps.db, kit: need(module, "no message-body key kit", deps.bodyKit) },
            org,
          ),
        ),
      ];
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
      const reports: TableReport[] = [];
      for (const { keyVersion, tagBits } of await m36SearchState(search, org)) {
        if (options.interrupted?.()) break;
        reports.push(await run(m36SearchScan(search, org, keyVersion, tagBits)));
      }
      return reports;
    }
  }
}

/** Nothing to do is an error, not a clean result: an empty tenant list would otherwise print zeros and exit 0. */
export class EmptyScopeError extends Error {
  constructor() {
    super("no organizations selected: refusing to report a clean result over nothing");
    this.name = "EmptyScopeError";
  }
}

/** Every selected module's inputs, checked BEFORE any module runs, so a run never half-completes and a missing input is never a zero. */
export function assertDependencies(
  deps: VerifyDeps,
  modules: readonly ModuleId[],
  organizationIds: readonly string[],
): void {
  const tenantModules = modules.filter((m) => !GLOBAL_MODULES.has(m));
  if (tenantModules.length > 0 && organizationIds.length === 0) throw new EmptyScopeError();
  for (const module of modules) {
    switch (module) {
      case "m5":
        need(module, "no identifier cipher (M34_TENANT_KEK)", deps.identifierCipher);
        break;
      case "m23":
        need(module, "M24_CREDENTIAL_ENCRYPTION_KEY is not set", deps.macCipher);
        break;
      case "m24":
        need(module, "M24_CREDENTIAL_ENCRYPTION_KEY is not set", deps.credentialKek);
        break;
      case "m34":
      case "m36-export":
        need(module, "M34_TENANT_KEK is not set", deps.kekAdapter);
        break;
      case "m35":
        need(module, "M35_PSEUDONYM_KEY_KEK is not set", deps.pseudonymRing);
        break;
      case "m36-body":
        need(module, "no message-body key kit (M34_TENANT_KEK)", deps.bodyKit);
        break;
      case "m36-search":
        need(module, "no search key provider (M34_TENANT_KEK)", deps.search);
        break;
    }
  }
}

/** Run the selected modules for every tenant (platform-wide modules once). */
export async function runVerify(deps: VerifyDeps, request: VerifyRequest): Promise<VerifyReport> {
  const selected = ALL_MODULES.filter((m) => request.modules.includes(m));
  assertDependencies(deps, selected, request.organizationIds);
  const reports: ModuleReport[] = [];
  const interrupted = () => request.interrupted?.() === true;
  let stoppedEarly = false;
  for (const module of selected) {
    const tables: TableReport[] = [];
    const orgs = GLOBAL_MODULES.has(module) ? [null] : request.organizationIds;
    for (const organizationId of orgs) {
      // After an interrupt nothing further is started: no org, no module, no search preparation.
      if (interrupted()) {
        stoppedEarly = true;
        break;
      }
      tables.push(...(await runModuleForOrg(module, deps, organizationId, request)));
    }
    reports.push({
      module,
      tables,
      total: tables.reduce((sum, t) => addCounts(sum, t.counts), emptyCounts),
    });
    if (stoppedEarly || interrupted()) {
      stoppedEarly = true;
      break;
    }
  }
  const sum = (pick: (c: Counts) => number) => reports.reduce((n, r) => n + pick(r.total), 0);
  const allExhausted = reports.every((r) => r.tables.every((t) => t.stoppedBy === "exhausted"));
  return {
    modules: reports,
    modulesCovered: selected,
    allModules: ALL_MODULES.every((m) => selected.includes(m)),
    // Only a run that looked at EVERY row of EVERY selected table says anything about "zero left".
    complete: !stoppedEarly && allExhausted && reports.length === selected.length,
    problemTotal: sum((c) => c.unreadable),
  };
}
