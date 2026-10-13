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
      `${status.legacyRows.total} message body row(s) are still on the legacy envelope (message: ${status.legacyRows.message}, message_revision: ${status.legacyRows.message_revision}) but MESSAGING_ENCRYPTION_KEY is missing or malformed; refusing to boot with unreadable history (ADR-0058 P1)`,
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
  const total = counts.message + counts.message_revision;
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
      };
    },
  );
}
