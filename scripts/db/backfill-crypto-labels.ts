#!/usr/bin/env bun
/**
 * ChartWarden - crypto context-label rename, RELEASE 2: re-seal every stored value under the CURRENT label, and count what
 * still opens ONLY under the legacy one. OPERATOR TOOL: never run in CI, never scheduled, never a migration. Read the
 * runbook in the release-2 PR description first (order, backup, verify step, expected output).
 *
 *   bun run crypto-labels:verify  -- --all-orgs                  read-only count per module (the release-3 gate)
 *   bun run crypto-labels:backfill -- --dry-run --all-orgs        what a real run would re-seal
 *   bun run crypto-labels:backfill -- --apply --module m24,m23,m35,m5,m36-body,m36-search,m36-export --all-orgs
 *   bun run crypto-labels:backfill -- --apply --module m34 --all-orgs --i-have-a-backup      LAST, with a backup
 *
 * Flags: --verify | --dry-run | --apply (exactly one) · --module <csv|all> · --org <uuid[,uuid]> | --all-orgs ·
 *        --batch-size N (default 100) · --pause-ms N · --max-rows N (per table per tenant; the next run resumes) ·
 *        --i-have-a-backup (required for --apply of m34).
 *
 * Needs DATABASE_URL (the tenant role), DATABASE_PLATFORM_URL (key ring, pseudonym keys, tenant list), M34_TENANT_KEK (+ _RETIRED),
 * M24_CREDENTIAL_ENCRYPTION_KEY (m23, m24), M35_PSEUDONYM_KEY_KEK (+ _RETIRED) (m35), MESSAGING_ENCRYPTION_KEY (v1 message bodies)
 * and, for m36-body's revision / poll / draft / scheduled tables, DATABASE_BODY_BACKFILL_URL (chartwarden_body_backfill_login).
 * A module whose input is missing FAILS (it never reports a silent zero). Safe to stop and re-run: every module is idempotent and
 * resumes by probing. Prints one JSON report on stdout (counts and row ids only; never plaintext, keys or ciphertext).
 *
 * Exit: 0 = ok (verify: zero legacy-only rows and nothing unreadable) · 1 = usage / configuration / fault · 2 = ran, but legacy-only
 * or unreadable or failed rows remain.
 */
import { type DbClient, createDbClient } from "@chartwarden/db";
import { loadMessagingKek } from "@chartwarden/messaging";
import { PseudonymKekError, loadPseudonymKekRing } from "@chartwarden/subscription-billing";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import {
  PlatformKekError,
  createPlatformKekAdapter,
  loadPlatformKekRing,
} from "../../apps/backend/src/bootstrap/tenant-kek";
import { createPatientIdentifierCipher } from "../../apps/backend/src/modules/05-patient/identifiers/identifier-cipher";
import { patientNameFragmentsPageForOrg } from "../../apps/backend/src/modules/05-patient/seams/patient-name-fragments-page-for-org";
import { buildMacSecretCipher } from "../../apps/backend/src/modules/23-billing-medicare/routes/secret-cipher";
import { loadCredentialKek } from "../../apps/backend/src/modules/24-billing-medicaid/credential-crypto";
import { buildKeyProvider } from "../../apps/backend/src/modules/34-saas-tenant-platform/seam-registration";
import { createRingDekCache } from "../../apps/backend/src/modules/36-messaging/body-key-ring";
import { createIndexWriter } from "../../apps/backend/src/modules/36-messaging/global-search/index-writer";
import { createNameExclusions } from "../../apps/backend/src/modules/36-messaging/global-search/name-exclusion";
import { createPlatformSearchFlag } from "../../apps/backend/src/modules/36-messaging/global-search/platform-flag";
import { createBodyReader } from "../../apps/backend/src/modules/36-messaging/global-search/ports";
import { createRingSearchKeyProvider } from "../../apps/backend/src/modules/36-messaging/global-search/search-key-provider";
import { createMessageBodyCipher } from "../../apps/backend/src/modules/36-messaging/messaging-write-core";
import {
  ALL_MODULES,
  type BackfillDeps,
  EmptyScopeError,
  MissingDependencyError,
  type ModuleId,
  runBackfill,
} from "./crypto-label-backfill";
import { DEFAULT_BATCH_SIZE, type Mode } from "./crypto-label-backfill/core";
import { BackupNotConfirmedError, RingRestoreFailedError } from "./crypto-label-backfill/m34";
import { MissingResealCredentialError } from "./crypto-label-backfill/m36-body";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class UsageError extends Error {}

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "module",
  "org",
  "batch-size",
  "pause-ms",
  "max-rows",
]);
const SWITCH_FLAGS: ReadonlySet<string> = new Set([
  "verify",
  "dry-run",
  "apply",
  "all-orgs",
  "i-have-a-backup",
]);

interface ParsedArgs {
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

/** Strict: an unknown flag, a value flag with no value (or whose "value" is another flag) and a repeated flag are usage errors. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) throw new UsageError(`unexpected argument '${token}'`);
    const name = token.slice(2);
    if (SWITCH_FLAGS.has(name)) {
      switches.add(name);
    } else if (VALUE_FLAGS.has(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`--${name} needs a value`);
      }
      if (values.has(name)) throw new UsageError(`--${name} given twice`);
      values.set(name, value);
      i++;
    } else {
      throw new UsageError(`unknown flag '${token}'`);
    }
  }
  return { values, switches };
}

let args: ParsedArgs = { values: new Map(), switches: new Set() };
const flag = (name: string): string | undefined => args.values.get(name);
const has = (name: string): boolean => args.switches.has(name);
function intFlag(name: string, min: number): number | undefined {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min) {
    throw new UsageError(`--${name} must be an integer >= ${min}`);
  }
  return n;
}

function parseMode(): Mode {
  const modes = (["verify", "dry-run", "apply"] as const).filter((m) => has(m));
  if (modes.length !== 1) throw new UsageError("pass exactly one of --verify, --dry-run, --apply");
  return modes[0] as Mode;
}

function parseModules(): ModuleId[] {
  const raw = flag("module") ?? "all";
  if (raw === "all") return [...ALL_MODULES];
  const wanted = raw.split(",").map((s) => s.trim());
  const unknown = wanted.filter((m) => !(ALL_MODULES as readonly string[]).includes(m));
  if (unknown.length > 0) {
    throw new UsageError(
      `unknown module(s) ${unknown.join(", ")}; known: ${ALL_MODULES.join(", ")}`,
    );
  }
  return wanted as ModuleId[];
}

async function resolveOrgs(platformDb: DbClient): Promise<string[]> {
  const orgFlag = flag("org");
  if (orgFlag !== undefined) {
    const ids = orgFlag.split(",").map((s) => s.trim().toLowerCase());
    if (ids.some((id) => !UUID.test(id))) throw new UsageError("--org takes organization uuids");
    const result = await platformDb.execute(
      sql`SELECT id::text AS id FROM organization WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`,
    );
    const found = new Set(
      (result as unknown as { rows: Array<{ id: string }> }).rows.map((r) => r.id),
    );
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw new UsageError(`no such organization: ${missing.join(", ")}`);
    return ids;
  }
  const result = await platformDb.execute(sql`SELECT id::text AS id FROM organization ORDER BY id`);
  return (result as unknown as { rows: Array<{ id: string }> }).rows.map((r) => r.id);
}

/**
 * A key variable that is SET but unusable is an error that says so; one that is not set is simply absent (the modules that need it
 * then fail with their own "is not set"). Neither ever prints the value.
 */
function keyIfSet(name: string, load: () => Buffer): Buffer | undefined {
  if (!process.env[name]?.trim()) return undefined;
  try {
    return load();
  } catch {
    throw new UsageError(`${name} is set but malformed (it must be a base64-encoded 32-byte key)`);
  }
}

async function main(): Promise<number> {
  args = parseArgs(process.argv.slice(2));
  const mode = parseMode();
  const modules = parseModules();
  // Every flag is validated before any connection is opened.
  if (has("all-orgs") === (flag("org") !== undefined)) {
    throw new UsageError("pass exactly one of --org <uuid[,uuid]> or --all-orgs");
  }
  const batchSize = intFlag("batch-size", 1) ?? DEFAULT_BATCH_SIZE;
  const pauseMs = intFlag("pause-ms", 0);
  const maxRows = intFlag("max-rows", 1);
  const backupConfirmed = has("i-have-a-backup");
  if (mode === "apply" && modules.includes("m34") && !backupConfirmed) {
    throw new UsageError(
      "refusing to re-wrap tenant key rings: take a restorable backup of tenant_key_ring and pass --i-have-a-backup",
    );
  }
  const { DATABASE_URL, DATABASE_PLATFORM_URL, DATABASE_BODY_BACKFILL_URL } = process.env;
  if (!DATABASE_URL || !DATABASE_PLATFORM_URL) {
    throw new UsageError("DATABASE_URL and DATABASE_PLATFORM_URL are required");
  }

  const tenant = createDbClient({ connectionString: DATABASE_URL });
  const platform = createDbClient({ connectionString: DATABASE_PLATFORM_URL });
  const reseal = DATABASE_BODY_BACKFILL_URL
    ? createDbClient({ connectionString: DATABASE_BODY_BACKFILL_URL })
    : undefined;
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error(
      "interrupt received: finishing the current row, then stopping (re-run to resume)",
    );
  });

  try {
    const organizationIds = await resolveOrgs(platform.db);
    const kekRing = loadPlatformKekRing();
    const kekAdapter = kekRing ? createPlatformKekAdapter(kekRing) : undefined;
    const keys = kekAdapter
      ? buildKeyProvider({
          kekUnwrap: kekAdapter,
          runInKeyRingContext: (orgId, fn) =>
            withOrgContext(
              platform.db,
              { organizationId: orgId, userId: "", systemActor: true },
              fn,
            ),
        })
      : undefined;
    const ringCache = keys ? createRingDekCache(keys) : undefined;
    const messagingKek = keyIfSet("MESSAGING_ENCRYPTION_KEY", () => loadMessagingKek());
    const credentialKek = keyIfSet("M24_CREDENTIAL_ENCRYPTION_KEY", () => loadCredentialKek());
    const macCipher = credentialKek ? buildMacSecretCipher(credentialKek) : undefined;

    let search: BackfillDeps["search"];
    if (ringCache && keys) {
      const searchKeys = createRingSearchKeyProvider(() => ringCache);
      const cipher = createMessageBodyCipher({
        ...(messagingKek ? { kek: messagingKek } : {}),
        keys,
        ringCache,
      });
      const bodies = createBodyReader(cipher);
      const exclusions = createNameExclusions({
        db: tenant.db,
        keys: searchKeys,
        names: {
          fragmentsPage: (orgId, afterId, limit) =>
            patientNameFragmentsPageForOrg(tenant.db, orgId, afterId, limit),
        },
      });
      search = {
        db: tenant.db,
        keys: searchKeys,
        bodies,
        exclusions,
        writer: createIndexWriter({
          db: tenant.db,
          bodies,
          keys: searchKeys,
          exclusions,
          platformFlag: createPlatformSearchFlag(tenant.db),
        }),
      };
    }

    const deps: BackfillDeps = {
      db: tenant.db,
      platformDb: platform.db,
      resealDb: reseal?.db,
      identifierCipher: keys ? createPatientIdentifierCipher(keys) : undefined,
      macCipher,
      credentialKek,
      kekAdapter,
      pseudonymRing: loadPseudonymKekRing(),
      bodyKit: ringCache
        ? { kek: messagingKek, ringDek: (org, version) => ringCache.byVersion(org, version) }
        : undefined,
      search,
      backupConfirmed,
    };

    const report = await runBackfill(deps, {
      modules,
      organizationIds,
      mode,
      batchSize,
      ...(pauseMs === undefined ? {} : { pauseMs }),
      ...(maxRows === undefined ? {} : { maxRows }),
      interrupted: () => interrupted,
      onBatch: ({ label, counts }) =>
        console.error(
          `${label.module} ${label.table} ${label.organizationId ?? "-"}: scanned ${counts.scanned}, current ${counts.current}, legacy-only ${counts.legacyOnly}, resealed ${counts.resealed}`,
        ),
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.complete) {
      console.error(
        "the run did not scan every row (--max-rows or an interrupt): its counts say nothing about what is left",
      );
      return 2;
    }
    if (report.problemTotal > 0) return 2;
    // A dry run only plans: legacy-only rows are expected there. Everywhere else they are what is still left to do.
    return mode === "dry-run" || report.legacyOnlyTotal === 0 ? 0 : 2;
  } finally {
    await tenant.close();
    await platform.close();
    await reseal?.close();
  }
}

try {
  process.exit(await main());
} catch (err) {
  console.error(describeFailure(err));
  process.exit(1);
}

/**
 * What the operator sees when the run aborts. Only this tool's own errors (written to name no value) print their message: a
 * database driver error message embeds the failed statement AND its parameters, which here are sealed values, so for anything
 * else only the error class and the Postgres SQLSTATE are printed.
 */
function describeFailure(err: unknown): string {
  if (
    err instanceof UsageError ||
    err instanceof MissingDependencyError ||
    err instanceof MissingResealCredentialError ||
    err instanceof BackupNotConfirmedError ||
    err instanceof EmptyScopeError ||
    err instanceof RingRestoreFailedError ||
    err instanceof PlatformKekError ||
    err instanceof PseudonymKekError
  ) {
    return err.message;
  }
  if (!(err instanceof Error)) return "crypto label backfill failed: unknown error";
  const code =
    (err as { code?: unknown }).code ?? (err as { cause?: { code?: unknown } }).cause?.code;
  return `crypto label backfill failed: ${err.name}${typeof code === "string" ? ` (SQLSTATE ${code})` : ""}`;
}
