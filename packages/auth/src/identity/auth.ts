// @wardenx/auth · identity — Better Auth integration (M2-T01; M2 spec §1, §3.1).
//
// This file is the ONE place `better-auth` may be imported (vendor-adapter mandate,
// ARCHITECTURE §25.14 / manifest VENDOR_ADAPTERS["better-auth"] = "packages/auth";
// enforced by the `vendor-adapter-better-auth` dependency-cruiser rule). The rest of the
// system depends on this module's typed exports — never on `better-auth` directly.
//
// It configures Better Auth against Module 1's identity tables (`user`, `session`,
// `account`, `verification`); M1 owns those tables, M2 owns their auth behavior
// (M02-F01). Per ADR-0026, Better Auth is the SINGLE authentication surface — no module
// mints its own session tokens.
//
// Scope note: M2-T01 landed the base Better Auth instance + Drizzle binding. M2-T03 adds
// the four session classes + the session additionalFields (class / scope / engagement
// window / screen-lock / step-up freshness) below — see ./session-classes for the class
// taxonomy + lifecycle state machine. Argon2id password hashing + HIBP breach check
// (password-policy), the org / two-factor / passkey / magic-link plugins (M2-T02+), the
// explicit step-up route that writes the step-up fields (M2-T05), and the published
// session seams (M2-T07) land in their own tasks.
import { schema } from "@wardenx/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

/**
 * The Drizzle database handle Better Auth reads/writes through. Typed as the adapter's
 * own `DB` contract so this module stays decoupled from any particular Drizzle client
 * construction — the live pg client is injected at boot (no shared client exists in the
 * slice; the codebase injects `db` structurally everywhere, cf. `withOrgContext`).
 */
export type IdentityAuthDb = Parameters<typeof drizzleAdapter>[0];

/**
 * Maps Better Auth's canonical model names onto M1's Drizzle table objects. M1 names the
 * tables in plural JS bindings (`users`) over singular SQL tables (`"user"`); Better Auth
 * keys models singularly, so we map explicitly rather than rely on `usePlural`.
 */
const m1Schema = {
  user: schema.users,
  session: schema.sessions,
  account: schema.accounts,
  verification: schema.verifications,
};

/**
 * Builds the Better Auth instance bound to M1's identity tables.
 *
 * `db` is injected so the host wires the real pooled pg client at boot while tests/build
 * stay infra-free. `account.fields` reconciles Better Auth's canonical column names with
 * M1's at-rest-encrypted naming (`passwordHash`, `accessTokenEncrypted`,
 * `refreshTokenEncrypted`); `session.additionalFields` declares M1's server-bound
 * `active_organization_id` so Better Auth round-trips the org binding for a session.
 */
export function createIdentityAuth(db: IdentityAuthDb) {
  return betterAuth({
    appName: "WardenX",
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: m1Schema,
    }),
    emailAndPassword: {
      // Email + password is enabled; NIST-aligned policy, Argon2id hashing and the HIBP
      // k-anonymity breach check are configured by the password-policy task (M2 §3.1).
      enabled: true,
    },
    account: {
      fields: {
        password: "passwordHash",
        accessToken: "accessTokenEncrypted",
        refreshToken: "refreshTokenEncrypted",
      },
    },
    session: {
      // M2-T03 (M2 spec §3.6): the session-class / lifecycle / step-up fields are carried
      // as Better Auth additionalFields over M1's `session` table (their at-rest columns +
      // CHECK invariants live in packages/db/src/schema/sessions.ts). All are server-bound:
      // a session's class, scope, engagement window, and step-up freshness are decided by
      // the auth flow, never by client input. See SESSION_CLASSES / sessionLifecycle below.
      additionalFields: {
        activeOrganizationId: {
          type: "string",
          required: false,
          // Server-bound at session issuance / `select-organization` — never client input.
          input: false,
        },
        sessionClass: {
          type: "string",
          required: false,
          defaultValue: "staff",
          input: false,
        },
        // Class-specific scope, e.g. { patientId } for external_collaborator / funeral_home.
        scope: { type: "json", required: false, input: false },
        // Auditor engagement window (both bounds set for the auditor class).
        engagementStart: { type: "date", required: false, input: false },
        engagementEnd: { type: "date", required: false, input: false },
        // UI screen-lock timestamp (staff / auditor lifecycle).
        screenLockedAt: { type: "date", required: false, input: false },
        // Step-up freshness (paired-write: both set or both null) — M2-T05 writes these.
        lastStepUpAt: { type: "date", required: false, input: false },
        lastStepUpFactor: { type: "string", required: false, input: false },
      },
    },
  });
}

/** The configured Better Auth instance type, for consumers that hold a built instance. */
export type IdentityAuth = ReturnType<typeof createIdentityAuth>;
