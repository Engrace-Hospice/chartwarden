// apps/backend/src/modules/36-messaging/body-legacy-key-check.ts — WP 2.13 / ADR-0058 P1: the boot-time answer to
// "can this deployment still read the legacy message history?".
//
// Until every `message` / `message_revision` row is re-sealed under the M34 ring, MESSAGING_ENCRYPTION_KEY is the only
// way to read the rows still on the legacy envelope. `assertProductionEnv` already refuses a production boot without it,
// and this change does NOT relax that (retiring the legacy key is a later, separately gated step). This check is the
// belt for the day it is relaxed: if legacy rows exist and the key is missing or malformed, a production boot FAILS
// CLOSED rather than starting with unreadable history. With zero legacy rows a missing key is the legitimate
// "retired" state. Outside production it only reports (a dev database may hold rows and no key).
import { type DbClient, schema } from "@wardenx/db";
import { type PlatformBypassAuditor, withPlatformContext } from "@wardenx/tenancy";
import { eq, sql } from "drizzle-orm";
import type { LegacyBodyCounts } from "./jobs/body-backfill";

/** The audited platform-context job id the boot count runs under (registered at the composition root). */
export const M36_BODY_LEGACY_COUNT_JOB_ID = "m36.body_legacy_count";
const LEGACY_ENVELOPE = 1;
const KEY_BYTES = 32;

export type LegacyBodyKeyState =
  | "ring_only"
  | "legacy_rows_key_present"
  | "legacy_rows_key_missing";

export interface LegacyBodyKeyStatus {
  readonly state: LegacyBodyKeyState;
  readonly legacyRows: LegacyBodyCounts & { readonly total: number };
  readonly keyUsable: boolean;
}

export class LegacyBodyKeyMissingError extends Error {
  constructor(readonly status: LegacyBodyKeyStatus) {
    super(
      `${status.legacyRows.total} message body row(s) are still on the legacy envelope (message: ${status.legacyRows.message}, message_revision: ${status.legacyRows.message_revision}, message_poll_option: ${status.legacyRows.message_poll_option}) but MESSAGING_ENCRYPTION_KEY is missing or malformed; refusing to boot with unreadable history (ADR-0058 P1)`,
    );
    this.name = "LegacyBodyKeyMissingError";
  }
}

function keyUsable(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return Buffer.from(raw, "base64").length === KEY_BYTES;
  } catch {
    return false;
  }
}

/** Classify the legacy-row/key situation. Throws only in production when legacy rows exist and the key is unusable. */
export function assertLegacyBodyKeyAvailable(
  counts: LegacyBodyCounts,
  env: NodeJS.ProcessEnv = process.env,
): LegacyBodyKeyStatus {
  const total = counts.message + counts.message_revision + counts.message_poll_option;
  const usable = keyUsable(env.MESSAGING_ENCRYPTION_KEY);
  const state: LegacyBodyKeyState =
    total === 0 ? "ring_only" : usable ? "legacy_rows_key_present" : "legacy_rows_key_missing";
  const status: LegacyBodyKeyStatus = {
    state,
    legacyRows: { ...counts, total },
    keyUsable: usable,
  };
  if (state === "legacy_rows_key_missing" && env.NODE_ENV === "production") {
    throw new LegacyBodyKeyMissingError(status);
  }
  return status;
}

/**
 * Cross-tenant legacy-row counts for the boot check. One audited platform-context read over the platform login's COLUMN
 * grant on `(organization_id, body_envelope_version)` (scripts/db/provision-runtime-roles.ts): it can count the scheme,
 * never read a byte of ciphertext.
 */
export async function countLegacyBodiesAllTenants(deps: {
  platformDb: DbClient;
  auditBypass: PlatformBypassAuditor<DbClient>;
  jobId: string;
}): Promise<LegacyBodyCounts> {
  return withPlatformContext<DbClient, LegacyBodyCounts>(
    deps.platformDb,
    {
      jobId: deps.jobId,
      reason: "M36 WP 2.13 legacy message body count (boot check)",
      crossTenant: true,
    },
    deps.auditBypass,
    async (tx) => {
      const count = async (table: typeof schema.messages | typeof schema.messageRevisions) => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(table)
          .where(eq(table.bodyEnvelopeVersion, LEGACY_ENVELOPE));
        return Number(row?.n ?? 0);
      };
      return {
        message: await count(schema.messages),
        message_revision: await count(schema.messageRevisions),
        message_poll_option: Number(
          (
            await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(schema.messagePollOptions)
              .where(eq(schema.messagePollOptions.labelEnvelopeVersion, LEGACY_ENVELOPE))
          )[0]?.n ?? 0,
        ),
      };
    },
  );
}

export class LegacyBodyCountUnavailableError extends Error {
  constructor(readonly causeMessage: string) {
    super(
      `the legacy message-body count could not be taken at boot (${causeMessage}); refusing to boot in production without knowing whether legacy rows exist. Re-run \`bun run db:provision-roles\` (column grant on body_envelope_version) BEFORE deploying this build (ADR-0058 P1).`,
    );
    this.name = "LegacyBodyCountUnavailableError";
  }
}

/**
 * The boot step: take the cross-tenant count and classify it. In production an unavailable count is FATAL (we cannot claim the
 * history is readable); elsewhere it is reported and boot continues. The caller (index.ts) awaits this before listen().
 */
export async function runLegacyBodyBootCheck(deps: {
  count: () => Promise<LegacyBodyCounts>;
  env?: NodeJS.ProcessEnv;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<LegacyBodyKeyStatus | undefined> {
  const env = deps.env ?? process.env;
  let counts: LegacyBodyCounts;
  try {
    counts = await deps.count();
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    if (env.NODE_ENV === "production") throw new LegacyBodyCountUnavailableError(message);
    deps.log.warn(`M36 legacy message-body count unavailable at boot: ${message}`);
    return undefined;
  }
  const status = assertLegacyBodyKeyAvailable(counts, env);
  deps.log.info(
    `M36 message bodies: ${status.state} (legacy rows: message ${counts.message}, message_revision ${counts.message_revision}, message_poll_option ${counts.message_poll_option})`,
  );
  return status;
}

/**
 * Boot-time validation of the WP 2.13 environment (called unconditionally, beside `assertProductionEnv`): a typo in
 * M36_BODY_SEAL_SCHEME must stop the boot, not surface as a 500 on the first send; `ring` additionally needs the platform KEK and
 * the platform pool (the ring is read through them). It does NOT check that every tenant has a provisioned ring: that is an
 * operator precondition (runbook stage 2); a tenant without one fails its sends with BodyKeyUnavailableError.
 */
export function assertM36BodyBootEnv(env: NodeJS.ProcessEnv = process.env): "legacy" | "ring" {
  const raw = env.M36_BODY_SEAL_SCHEME?.trim().toLowerCase();
  if (!raw || raw === "legacy") return "legacy";
  if (raw !== "ring") {
    throw new Error(`M36_BODY_SEAL_SCHEME must be 'legacy' or 'ring' (got '${raw}')`);
  }
  for (const key of ["M34_TENANT_KEK", "DATABASE_PLATFORM_URL"]) {
    if (!env[key]?.trim()) {
      throw new Error(
        `M36_BODY_SEAL_SCHEME=ring requires ${key} (the tenant ring DEK is read through it)`,
      );
    }
  }
  return "ring";
}
