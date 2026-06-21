// @wardenx/backend — Fastify host entry + COMPOSITION ROOT (not in any module codePath, so
// exempt from the module-boundary import rules — it may import every module's init). It builds
// the server, runs the seam/eraser boot gate, and registers each Phase-1 module's real seams
// via `wireModuleSeams` (M1's bootstrap cannot import a downstream module; the composition
// root does, then hands the registration into the boot gate before validateSeams()).
import {
  createConsoleEmailTransport,
  createDbActorEnrichmentReader,
  createDbAdminMembershipReader,
  createDbSessionContextStore,
  createIdentityAuth,
  createNoopEmailTransport,
  getIdentitySession,
  registerDbEffectivePermissionResolver,
  registerIdentityAuth,
} from "@wardenx/auth";
import type { SessionContextStore } from "@wardenx/auth";
import { type DbClient, createDbClient } from "@wardenx/db";
import { buildServer, createSessionAuthenticate, getSeam } from "./bootstrap/index";
import { assertAuditActionCatalog, mountAuditRoutes, registerAuditErasers } from "./modules/04-audit/index";
import {
  mountIdentityRoutes,
  registerIdentityErasers,
  registerIdentitySeams,
} from "./modules/02-identity/index";
import { mountAuthorizationRoutes } from "./modules/03-authorization/index";
import {
  mountMessagingRoutes,
  registerMessagingErasers,
  registerMessagingSeams,
} from "./modules/36-messaging/index";
import {
  createDbTerminologyStore,
  mountTerminologyRoutes,
  registerTerminologyErasers,
  registerTerminologySeams,
} from "./modules/38-terminology/index";
import {
  createDbBaaStore,
  createDbMdmStore,
  mountMdmRoutes,
  registerMdmErasers,
  registerMdmSeams,
} from "./modules/40-mdm/index";
import {
  mountPatientRoutes,
  registerPatientErasers,
  registerPatientSeams,
} from "./modules/05-patient/index";
import {
  createDbConsentStore,
  mountConsentRoutes,
  registerConsentAbacPredicates,
  registerConsentErasers,
  registerConsentSeams,
} from "./modules/39-consent/index";

export { buildServer };
export * from "./bootstrap/index";

/**
 * Register every Phase-1 producer module's real seams into the M1 registry. Passed to
 * buildServer() as `registerModuleSeams`, it runs inside bootSeams() after M1's wireSeams()
 * and before validateSeams(), so the real seams stand over the deny-stubs (§3.18).
 */
export function wireModuleSeams(
  deps: { sessionContextStore?: SessionContextStore; db?: DbClient } = {},
): void {
  // AUTH-T05b: pass the DB-backed SessionContextStore in production (composition root supplies it when
  // a DB client is present); the slice/tests fall back to M2's in-memory store.
  registerIdentitySeams({ sessions: deps.sessionContextStore }); // M2 — SessionContextResolver + AuditorSessionMinter (§4.7)
  // M3 — register the live RBAC resolver (DB-backed effective permissions) when a DB client is present,
  // turning `requirePermission` from fail-closed to real resolution. Slice/tests keep the default.
  if (deps.db) registerDbEffectivePermissionResolver(deps.db);
  // M38 — TerminologyProvider (§4.5). Production backs it with the Drizzle store over the real M38
  // tables (FB-T01); slice/tests keep the in-memory default.
  registerTerminologySeams(deps.db ? { store: createDbTerminologyStore(deps.db) } : {});
  registerMessagingSeams(); // M36 — AlertEmitter (§4.6); MessagingProvider stays deny-stub until T07/T08
  // M40 — MdmEntityProvider (§4.5) + BaaStatusProvider (§4.6 §7.7 as-of gate). Production backs both
  // seams with Drizzle stores over the real M40 tables (FB-T02); slice/tests keep the in-memory default.
  registerMdmSeams(
    deps.db ? { store: createDbMdmStore(deps.db), baaStore: createDbBaaStore(deps.db) } : {},
  );
  registerPatientSeams(); // M5 — CaseloadProvider (§4.1, + caseload_membership predicate); PatientReader/Mutator land T08
  // M39 — ConsentEvaluator (§4.3, the disclosure/redaction gate). Production backs it with the Drizzle
  // store over the real M39 consent tables (FB-T03); slice/tests keep the in-memory default.
  registerConsentSeams(deps.db ? { store: createDbConsentStore(deps.db) } : {});
  registerConsentAbacPredicates(); // M39 — the 11 §4.8 ABAC predicate resolvers (resolve via the seam)
  // Phase-1 producers append here as they land: M22 DocumentRenderer, …
}

/**
 * Register every module's REAL data eraser over the Phase-0 deny-stubs. Passed to
 * buildServer() as `registerModuleErasers`, it runs inside bootSeams() AFTER wireErasers()
 * (which deny-stubs every REQUIRED_ERASERS class) and before validateErasers(), so a real
 * eraser stands over its stub. A right-to-erasure request then hits a working eraser, not a
 * silent no-op (M2-T10).
 */
export function wireModuleErasers(): void {
  registerIdentityErasers(); // M2 — `identity` data class (two_factor/passkey + invitations)
  registerAuditErasers(); // M4-T08 — `audit_event` data class (legal-hold + Part 2 lifetime aware)
  registerTerminologyErasers(); // M38-T10 — `terminology_tenant_extensions` (D8 tenant offboarding)
  registerMessagingErasers(); // M36-T10 — `messages` (D9 tenant offboarding; DEK crypto-erase §7.8)
  registerMdmErasers(); // M40-T10 — `mdm_tenant_overlays` (D7 tenant offboarding; canonical untouched)
  registerPatientErasers(); // M5-T12 — `clinical_record` (patient-subtree destruction-cert callback; D7/D8)
  registerConsentErasers(); // M39-T10 — `consent` (subtree erase; legal-hold + 42 CFR Part 2 lifetime refusal)
  // Phase-1 data-class owners append here as they land.
}

// Start only when run directly (not when imported by tests/tooling).
// `import.meta.main` is a Bun runtime flag; cast keeps tsc happy without bun-types.
if ((import.meta as { main?: boolean }).main) {
  // M4-T10 — fail closed if the consolidated audit action catalog has a D9 namespace/uniqueness
  // violation (§4.6.7) before the server serves a single request.
  assertAuditActionCatalog();
  // AUTH-T01 (ADR-0033): build the production DB client when configured, and inject it. Consumed by
  // the Better Auth mount (AUTH-T02) + repositories. Absent DATABASE_URL → the host still boots
  // (the auth handler is mounted only when a DB client is present).
  const dbHandle = process.env.DATABASE_URL
    ? createDbClient({ connectionString: process.env.DATABASE_URL })
    : undefined;
  // AUTH-T02/T03: when a DB client is present, build the Better Auth instance + the authenticate hook
  // (getIdentitySession → SessionContextResolver seam → request.context). The seam is resolved lazily
  // at request time, after bootSeams() has registered it.
  // Transactional email transport for reset + magic-link links. A real provider (SMTP/Postmark) plugs
  // in here when credentials exist; until then dev logs the link (console) and production drops it
  // (no-op — a link in prod logs is a credential in logs). #4/#3 light up once a provider is wired.
  const emailTransport =
    process.env.NODE_ENV === "production"
      ? createNoopEmailTransport()
      : createConsoleEmailTransport();
  const auth = dbHandle
    ? createIdentityAuth(dbHandle.db as Parameters<typeof createIdentityAuth>[0], { emailTransport })
    : undefined;
  const authenticate = auth
    ? createSessionAuthenticate({
        getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
        getResolver: () => getSeam("SessionContextResolver"),
      })
    : undefined;
  const app = buildServer({
    db: dbHandle?.db,
    authenticate,
    // Mount module REST routes when a DB client is present (progressive backend wiring). M3 first:
    // the role catalog runs on the real Drizzle RoleStore; other module routes append here as their
    // stores land. The slice/tests boot without this (foundation routes only).
    registerModuleRoutes: dbHandle
      ? (app) => {
          mountAuthorizationRoutes(app, dbHandle.db); // M3 — role catalog + grants on real stores
          // M2 — member roster on the real MembershipRepository; isAdmin via the M3 admin reader.
          mountIdentityRoutes(app, dbHandle.db, createDbAdminMembershipReader(dbHandle.db));
          mountAuditRoutes(app, dbHandle.db); // M4 — audit-log search on the real Drizzle AuditQuery
          mountPatientRoutes(app, dbHandle.db); // M5 — patient census/chart READS on the real patient table
          mountTerminologyRoutes(app, dbHandle.db); // M38 — terminology read surface + tenant value-set extensions (FB-T01)
          mountMdmRoutes(app, dbHandle.db); // M40 — MDM entity directory + overlay/BAA + platform-ops (FB-T02)
          mountConsentRoutes(app, dbHandle.db); // M39 — consent catalog/records/decision-audit reads (FB-T03)
          mountMessagingRoutes(app, dbHandle.db); // M36 — channel/thread/alert-inbox/prefs reads (FB-T04; writes → FB-T05)
        }
      : undefined,
    registerModuleSeams: () =>
      wireModuleSeams({
        sessionContextStore: dbHandle
          ? createDbSessionContextStore(dbHandle.db, createDbActorEnrichmentReader(dbHandle.db))
          : undefined,
        db: dbHandle?.db,
      }),
    registerModuleErasers: wireModuleErasers,
  });
  if (dbHandle && auth) {
    registerIdentityAuth(app, auth); // AUTH-T02: mount /api/auth/* (needs BETTER_AUTH_SECRET/URL in prod)
    app.addHook("onClose", () => dbHandle.close());
  }
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
