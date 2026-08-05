// apps/backend/src/bootstrap/env.ts — production environment validation (audit #M2, M2 spec §4.3).
//
// The auth/runtime config reads its secrets straight from `process.env` with DEV fallbacks
// (BETTER_AUTH_SECRET, BETTER_AUTH_URL, TRUSTED_ORIGINS, TWO_FACTOR_ENCRYPTION_KEY, DATABASE_URL).
// That is correct for dev/test, but in production a missing/weak secret would otherwise reach runtime
// — better-auth warns rather than refuses, the 2FA key only fails closed lazily on first use, etc.
// This module makes the boot FAIL CLOSED: when NODE_ENV=production every required secret must be
// present and meet its strength rule, or the server throws before serving a single request. Dev/test
// keep their safe fallbacks (the check is a no-op outside production).
import { Buffer } from "node:buffer";

/** Environment surface this validator reads — `process.env` in production, an injected map in tests. */
export type EnvLike = Record<string, string | undefined>;

/** One unmet production requirement. */
export interface EnvProblem {
  readonly key: string;
  readonly problem: string;
}

/** A required-in-production secret + an optional strength rule (returns a problem string, or null when OK). */
interface Requirement {
  readonly key: string;
  readonly rule?: (value: string) => string | null;
}

const REQUIREMENTS: readonly Requirement[] = [
  { key: "DATABASE_URL" },
  {
    key: "BETTER_AUTH_SECRET",
    rule: (v) => (v.length < 32 ? "must be at least 32 characters" : null),
  },
  {
    key: "BETTER_AUTH_URL",
    rule: (v) => (/^https:\/\//.test(v) ? null : "must be an https:// origin"),
  },
  { key: "TRUSTED_ORIGINS" },
  {
    // M24 §8.7 — the master KEK for state trading-partner secrets (client secret / SFTP key). Required in
    // production: without it a credential write fails closed, so Medicaid submission could never be
    // configured — better to refuse to boot than to serve a billing surface that cannot store its secrets.
    key: "M24_CREDENTIAL_ENCRYPTION_KEY",
    rule: (v) => {
      try {
        return Buffer.from(v, "base64").length === 32 ? null : "must decode to 32 base64 bytes";
      } catch {
        return "must be valid base64";
      }
    },
  },
  {
    key: "TWO_FACTOR_ENCRYPTION_KEY",
    rule: (v) => {
      try {
        return Buffer.from(v, "base64").length === 32 ? null : "must decode to 32 base64 bytes";
      } catch {
        return "must be valid base64";
      }
    },
  },
  {
    // TASK-008/SEC-001 — the §7.4 witness-attestation HMAC secret (M13 emar-route-service-db.ts). Raw
    // HMAC key material (not base64), so the length rule mirrors BETTER_AUTH_SECRET, not the base64 KEKs.
    key: "M13_WITNESS_SIGNING_KEY",
    rule: (v) => (v.length < 32 ? "must be at least 32 characters" : null),
  },
  {
    // TASK-010/SEC-005 — required so BullMQ workers (outbox dispatcher, cron jobs) actually run in
    // production instead of silently not constructing (index.ts today only warns when unset).
    key: "REDIS_URL",
    rule: (v) => (/^rediss?:\/\//.test(v) ? null : "must be a redis:// or rediss:// URL"),
  },
  {
    key: "M23_X12_GATEWAY_URL",
    rule: (v) => (/^https:\/\//.test(v) ? null : "must be an https:// URL"),
  },
  {
    key: "M23_X12_GATEWAY_TOKEN",
    rule: (v) => (v.length < 32 ? "must be at least 32 characters" : null),
  },
  {
    key: "M23_MAC_GATEWAY_URL",
    rule: (v) => (/^https:\/\//.test(v) ? null : "must be an https:// URL"),
  },
  {
    key: "M23_MAC_GATEWAY_TOKEN",
    rule: (v) => (v.length < 32 ? "must be at least 32 characters" : null),
  },
  {
    key: "M34_PROVISION_GATEWAY_URL",
    rule: (v) => (/^https:\/\//.test(v) ? null : "must be an https:// URL"),
  },
  {
    key: "M34_PROVISION_GATEWAY_TOKEN",
    rule: (v) => (v.length < 32 ? "must be at least 32 characters" : null),
  },
  {
    key: "M34_INVITATION_ACCEPT_URL",
    rule: (v) => (/^https:\/\//.test(v) ? null : "must be an https:// URL"),
  },
  {
    // TASK-010/OPS-010 — the platform-scoped DB connection (M34/M35/outbox dispatcher). Presence-only,
    // like DATABASE_URL: format is a connection string, not something to pattern-match here.
    key: "DATABASE_PLATFORM_URL",
  },
  {
    // TASK-010/SEC-005 — WebAuthn relying-party id for the Better Auth passkey plugin
    // (packages/auth/src/identity/auth.ts). Unset previously fell through to a hardcoded "localhost".
    key: "PASSKEY_RP_ID",
  },
  {
    // TASK-010/SEC-005 — WebAuthn relying-party id for the step-up re-auth ceremony
    // (02-identity/routes/session-step-up.ts). A DIFFERENT var from PASSKEY_RP_ID (both are real,
    // independently-read WebAuthn RP ids in this codebase) with the same "localhost" fallback bug.
    key: "WEBAUTHN_RP_ID",
  },
  {
    // TASK-010/SEC-005 — the messaging body-encryption KEK (packages/messaging/src/crypto/body-crypto.ts),
    // which today only fails closed LAZILY on first use. Same base64/32-byte shape as its own local check.
    key: "MESSAGING_ENCRYPTION_KEY",
    rule: (v) => {
      try {
        return Buffer.from(v, "base64").length === 32 ? null : "must decode to 32 base64 bytes";
      } catch {
        return "must be valid base64";
      }
    },
  },
  {
    // TASK-010/SEC-005 — the shared cursor-signing secret M19/M20 concurrency.ts fall back to (each also
    // accepts a module-specific M19_/M20_CURSOR_SIGNING_KEY override). Unset, cursors are signed with a
    // process-local random key and stop verifying across a restart/redeploy — safe, but an avoidable
    // re-page for every caller in production.
    key: "CURSOR_SIGNING_KEY",
    rule: (v) => (v.length < 32 ? "must be at least 32 characters" : null),
  },
  {
    // TASK-010/OPS-010 — the trusted-proxy CIDR allowlist (bootstrap/index.ts parseTrustedProxies).
    // Unset today, Fastify's trustProxy is `false` (fails open to "trust no proxy", not a boot failure) —
    // in production behind a load balancer that silently breaks client-IP-derived rate limiting/audit.
    key: "TRUSTED_PROXY_CIDRS",
  },
  {
    // TASK-013/ARCH-008 — the shared secret an internal (non-interactive) caller presents to
    // authenticate as a system principal (`bootstrap/plugins/authenticate.ts`), the only way
    // `requireSystemPrincipal()`-gated routes (M23 #39/#40, M15's `/internal/...` seams) become
    // reachable. Required in production for the same reason as M13_WITNESS_SIGNING_KEY: without it
    // the feature the fix ships is silently inert (those routes stay permanently 403), which is safe
    // but should be a deliberate deploy choice, not an unset-and-forgotten secret.
    key: "INTERNAL_SERVICE_TOKEN",
    rule: (v) => (v.length < 32 ? "must be at least 32 characters" : null),
  },
];

/**
 * Collect every unmet production requirement (empty array = OK). Pure, so the rules are unit-testable
 * without mutating the process environment. Returns [] for any non-production `NODE_ENV`.
 */
export function collectEnvProblems(env: EnvLike): EnvProblem[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: EnvProblem[] = [];
  for (const { key, rule } of REQUIREMENTS) {
    const value = env[key]?.trim();
    if (!value) {
      problems.push({ key, problem: "is required in production" });
      continue;
    }
    const ruleProblem = rule?.(value);
    if (ruleProblem) problems.push({ key, problem: ruleProblem });
  }
  return problems;
}

/**
 * Fail-closed production env gate (audit #M2). Throws — listing every problem at once — when
 * NODE_ENV=production and a required secret is missing or weak. A no-op in dev/test. Call at the
 * very top of the composition-root boot, before any secret is consumed.
 */
export function assertProductionEnv(env: EnvLike = process.env): void {
  const problems = collectEnvProblems(env);
  if (problems.length === 0) return;
  const lines = problems.map((p) => `  - ${p.key} ${p.problem}`).join("\n");
  throw new Error(
    `Production environment validation failed (fail-closed — refusing to boot):\n${lines}`,
  );
}
