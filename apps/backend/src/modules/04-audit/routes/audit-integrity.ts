// apps/backend/src/modules/04-audit/routes/audit-integrity.ts — GAP-003 the §10.4 tamper-evidence
// report surface.
//
// `verifyAppendOnly()` (@chartwarden/audit `integrity/index.ts`) is pure logic over an injected
// `GrantSnapshot[]` — this file is the live adapter: a `pg_catalog`/`aclexplode` read of the
// PRIVILEGES actually granted on `audit_event`, the same catalog-metadata read Postgres exposes to
// any connected role (no elevated credential needed — this is not a `SELECT audit_event` read, it
// never touches a row). `appendOnly.grantsVerified` is therefore a REAL, live compliance signal, not
// a static assertion.
//
// `sealChain` / `integritySample` come from the sealed audit hash chain and its sampled verification
// (`audit_seal` + `audit_integrity_run`, jobs/audit-integrity-job.ts) and are OMITTED until the org has a
// seal / a run — "never checked" must not read as "verified clean". `backupSampling` (a pgBackRest
// comparison) stays absent: no backup reader exists in this repo, which `integritySample
// .backupCrossReference` states explicitly rather than fabricating a section.
import { type GrantSnapshot, verifyAppendOnly, verifySealLinkage } from "@chartwarden/audit";
import { requirePermission } from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { UnauthorizedError } from "@chartwarden/types";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readIntegrityState } from "../jobs/audit-integrity-job";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AuditIntegrityRouteDeps {
  readonly db: DbClient;
  /** Injectable for tests; defaults to the wall clock. */
  readonly now?: () => Date;
}

const AUDIT_TABLE = "audit_event";
/** The app roles the append-only model must hold for (§10.4) — mirrors `@chartwarden/audit`'s default. */
const APP_ROLE = "chartwarden_app";

const integrityPermission = requirePermission("audit.integrity") as PreHandler;

function actorOf(request: FastifyRequest): string {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return ctx.organizationId;
}

/** First partition a stored run recorded as broken, or null. */
function firstRecordedBreak(detail: unknown): string | null {
  const breaks = (detail as { breaks?: unknown } | null)?.breaks;
  if (!Array.isArray(breaks)) return null;
  const first = breaks[0] as { partition?: unknown } | undefined;
  return typeof first?.partition === "string" ? first.partition : null;
}

/**
 * Read the privileges Postgres has actually granted `APP_ROLE` on `AUDIT_TABLE` via
 * `pg_class.relacl` (`aclexplode`) — the same catalog view `\dp` reads, unrestricted by RLS (it is
 * catalog metadata, not table rows) and readable by any connected role. `COALESCE(..., acldefault
 * (...))` covers the (here, never-true) case of a table with no explicit ACL, where Postgres implies
 * the owner-only default rather than an empty one.
 */
async function readAuditEventGrants(db: DbClient): Promise<GrantSnapshot[]> {
  const rows = await db.execute<{ privilege: string }>(sql`
    SELECT a.privilege_type AS privilege
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'public' AND c.relname = ${AUDIT_TABLE} AND r.rolname = ${APP_ROLE}
  `);
  return [
    {
      role: APP_ROLE,
      table: AUDIT_TABLE,
      privileges: rows.rows.map((r) => r.privilege),
    },
  ];
}

/**
 * Mount `GET /api/v1/audit/integrity/report` (§4.2). Behind `audit.integrity` (M4 spec §4.5); runs
 * the live append-only GRANT verification and returns the report — see the file header for why
 * `backupSampling`/`sealChain` are honestly absent rather than fabricated.
 */
export function registerAuditIntegrityRoutes(
  app: FastifyInstance,
  deps: AuditIntegrityRouteDeps,
): void {
  const now = deps.now ?? (() => new Date());

  app.get(
    "/api/v1/audit/integrity/report",
    { preHandler: [integrityPermission] },
    async (request) => {
      const organizationId = actorOf(request);
      const grants = await readAuditEventGrants(deps.db);
      const violations = verifyAppendOnly(grants, {
        appRoles: [APP_ROLE],
        auditTables: [AUDIT_TABLE],
      });
      // The hash-chain half. Omitted entirely while the org has neither seals nor a run (the flag is
      // off and the job never ran): "never checked" must not read as "verified clean".
      const { seals, lastSample } = await readIntegrityState(deps.db, organizationId);
      const liveBreaks = verifySealLinkage(seals);
      const newestSeal = seals[seals.length - 1];
      const brokenAt =
        liveBreaks[0]?.partition ??
        (lastSample?.result === "mismatch" ? firstRecordedBreak(lastSample.detail) : null);
      return {
        appendOnly: {
          grantsVerified: violations.length === 0,
          lastChecked: now().toISOString(),
        },
        ...(newestSeal
          ? {
              sealChain: {
                contiguous: brokenAt === null,
                lastSealedPartition: newestSeal.partition,
                brokenAt,
              },
            }
          : {}),
        ...(lastSample
          ? {
              integritySample: {
                lastRun: lastSample.finishedAt.toISOString(),
                result: lastSample.result,
                sealsTotal: lastSample.sealsTotal,
                sealsSampled: lastSample.sealsSampled,
                eventsHashed: lastSample.eventsHashed,
                mismatches: lastSample.mismatches,
                backupCrossReference: lastSample.backupCrossReference,
              },
            }
          : {}),
      };
    },
  );
}
