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
  /** A requirement may belong to an explicitly disabled integration capability. */
  readonly when?: (env: EnvLike) => boolean;
}

/**
 * Production integration switches are deliberately opt-out: an existing deployment keeps its
 * fail-closed contract until an operator explicitly writes `false`.  A bare missing gateway URL is
 * never interpreted as consent to disable a capability.
 */
export const M23_LAUNCH_GATEWAY_ENABLED_ENV = "M23_LAUNCH_GATEWAY_ENABLED";
export const M34_PROVISION_GATEWAY_ENABLED_ENV = "M34_PROVISION_GATEWAY_ENABLED";
export const FHIR_TOKEN_ENDPOINT_ENABLED_ENV = "FHIR_TOKEN_ENDPOINT_ENABLED";
/** GAP-146 — the M24 Oregon launch-gateway capability gate. Opt-OUT in production like the M23 switch (it was
 *  opt-in, so a production deploy that never set it silently built no Medicaid submit/poll workers). It is a
 *  capability gate only: every real endpoint comes from a provider entity's own trading-partner credential, so
 *  an enabled gate with no credential calls nothing. dev/test keep the unset-means-off default. */
export const M24_LAUNCH_GATEWAY_ENABLED_ENV = "M24_LAUNCH_GATEWAY_ENABLED";

const INTEGRATION_SWITCHES = [
  M23_LAUNCH_GATEWAY_ENABLED_ENV,
  M34_PROVISION_GATEWAY_ENABLED_ENV,
  FHIR_TOKEN_ENDPOINT_ENABLED_ENV,
  M24_LAUNCH_GATEWAY_ENABLED_ENV,
] as const;

/** Whether an opt-out production integration capability should be bound (defaults to true). */
export function integrationEnabled(
  env: EnvLike,
  key: (typeof INTEGRATION_SWITCHES)[number],
): boolean {
  return env[key]?.trim().toLowerCase() !== "false";
}

/**
 * GAP-146 — the env the M24 launch-gateway gate reads: in production an UNSET switch means enabled (an explicit
 * `false` still disables); outside production the value is passed through untouched, so dev/test/CI keep
 * "unset = nothing calls out by accident".
 */
export function withM24LaunchGatewayDefault(env: EnvLike): EnvLike {
  if (env.NODE_ENV !== "production" || env[M24_LAUNCH_GATEWAY_ENABLED_ENV]?.trim()) return env;
  return { ...env, [M24_LAUNCH_GATEWAY_ENABLED_ENV]: "true" };
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
    when: (env) => integrationEnabled(env, M23_LAUNCH_GATEWAY_ENABLED_ENV),
  },
  {
    key: "M23_X12_GATEWAY_TOKEN",
    rule: (v) => (v.length < 32 ? "must be at least 32 characters" : null),
    when: (env) => integrationEnabled(env, M23_LAUNCH_GATEWAY_ENABLED_ENV),
  },
  {
    key: "M23_MAC_GATEWAY_URL",
    rule: (v) => (/^https:\/\//.test(v) ? null : "must be an https:// URL"),
    when: (env) => integrationEnabled(env, M23_LAUNCH_GATEWAY_ENABLED_ENV),
  },
  {
    key: "M23_MAC_GATEWAY_TOKEN",
    rule: (v) => (v.length < 32 ? "must be at least 32 characters" : null),
    when: (env) => integrationEnabled(env, M23_LAUNCH_GATEWAY_ENABLED_ENV),
  },
  {
    key: "M34_PROVISION_GATEWAY_URL",
    rule: (v) => (/^https:\/\//.test(v) ? null : "must be an https:// URL"),
    when: (env) => integrationEnabled(env, M34_PROVISION_GATEWAY_ENABLED_ENV),
  },
  {
    key: "M34_PROVISION_GATEWAY_TOKEN",
    rule: (v) => (v.length < 32 ? "must be at least 32 characters" : null),
    when: (env) => integrationEnabled(env, M34_PROVISION_GATEWAY_ENABLED_ENV),
  },
  {
    key: "M34_INVITATION_ACCEPT_URL",
    rule: (v) => (/^https:\/\//.test(v) ? null : "must be an https:// URL"),
    when: (env) => integrationEnabled(env, M34_PROVISION_GATEWAY_ENABLED_ENV),
  },
  {
    // F-035 (#95) — the absolute URL of M28's `/fhir/oauth2/token`, which is the `aud` every SMART
    // Backend Services client assertion must carry. Required in production while the assertion flow is
    // enabled; disabling it makes that flow fail closed with 503 rather than accepting an unbound audience.
    key: "FHIR_TOKEN_ENDPOINT_URL",
    rule: (v) => (/^https:\/\//.test(v) ? null : "must be an https:// URL"),
    when: (env) => integrationEnabled(env, FHIR_TOKEN_ENDPOINT_ENABLED_ENV),
  },
  {
    // GAP-096 — declares a single-tenant deployment, where M32 lets a tenant `clinical_safety_lead` act as
    // AI Safety Owner. Optional (unset = multi-tenant, the safe default); a SET value must be exactly
    // `true`/`false`, so a typo such as `TRUE` or `yes` refuses the boot instead of silently reading as
    // multi-tenant on a deployment that meant otherwise.
    key: "WARDENX_SINGLE_TENANT_DEPLOYMENT",
    rule: (v) => (v === "true" || v === "false" ? null : "must be 'true' or 'false'"),
    when: (env) => env.WARDENX_SINGLE_TENANT_DEPLOYMENT !== undefined,
  },
  {
    // GAP-055 follow-up (ADR-0035) — require a valid device attestation and bind M18 EVV capture to the
    // session's device. Optional (unset = NOT enforced: no attested client exists yet, so enforcing would 403
    // every production capture); a SET value must be exactly `true`/`false`, so a typo such as `TRUE` refuses
    // the boot instead of silently leaving the control off on a deployment that meant to turn it on.
    key: "EVV_DEVICE_ATTESTATION_ENFORCED",
    rule: (v) => (v === "true" || v === "false" ? null : "must be 'true' or 'false'"),
    when: (env) => env.EVV_DEVICE_ATTESTATION_ENFORCED !== undefined,
  },
  {
    // GAP-009 — closed registration. `true`/`false` only (a typo must refuse the boot, not silently read as
    // the default). Unset: strict in production, open in dev (the seeds sign users up without an invite).
    key: "WARDENX_SIGNUP_REQUIRES_INVITE",
    rule: (v) => (v === "true" || v === "false" ? null : "must be 'true' or 'false'"),
    when: (env) => env.WARDENX_SIGNUP_REQUIRES_INVITE !== undefined,
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
    // #105 — the platform KEK that wraps every tenant's DEK (`bootstrap/tenant-kek.ts`, ADR-0045). The
    // root of M34's §3.5 key envelope: unset, `dekForOrg` refuses for every org, and with it every
    // consumer of per-tenant encryption — M8's signed HearthNote narrative, M27's raw payload ciphers,
    // M29's stored HL7 payloads, M31's portal contact ciphers, M39's consent notes. Shaped
    // `<kekId>:<base64 32 bytes>` rather than a bare key because the id is stored beside every wrapped
    // DEK (`tenant_key_ring.current_dek_kek_id`) and is what makes a KEK rotation resolvable.
    key: "M34_TENANT_KEK",
    rule: (v) => {
      const sep = v.indexOf(":");
      if (sep <= 0) return "must be '<kekId>:<base64 32-byte key>'";
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(v.slice(0, sep))) {
        return "kekId must be 1-64 chars of [A-Za-z0-9._-]";
      }
      try {
        return Buffer.from(v.slice(sep + 1), "base64").length === 32
          ? null
          : "key must decode to 32 base64 bytes";
      } catch {
        return "key must be valid base64";
      }
    },
  },
  {
    // F-172 (#248) — the platform KEK that wraps M35's platform-singleton `patient_pseudonym_key`
    // (`packages/subscription-billing/src/pseudonym/key-envelope.ts`). A SEPARATE secret from
    // `M34_TENANT_KEK` (different key, different AAD, never interchangeable) — unset, `activeKey()`
    // refuses per-delivery rather than silently pseudonymizing under a derived/zero key, so the D6
    // `m2.session.created` / `m5.patient.{deceased,merged}` consumers dead-letter loudly instead of
    // writing a wrong-key pseudonym into `patient_active_period`/`user_active_period`. Same
    // `<kekId>:<base64 32 bytes>` shape as `M34_TENANT_KEK` for the same reason (the id travels beside
    // the wrapped ciphertext in `patient_pseudonym_key.key_kms_ref`).
    key: "M35_PSEUDONYM_KEY_KEK",
    rule: (v) => {
      const sep = v.indexOf(":");
      if (sep <= 0) return "must be '<kekId>:<base64 32-byte key>'";
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(v.slice(0, sep))) {
        return "kekId must be 1-64 chars of [A-Za-z0-9._-]";
      }
      try {
        return Buffer.from(v.slice(sep + 1), "base64").length === 32
          ? null
          : "key must decode to 32 base64 bytes";
      } catch {
        return "key must be valid base64";
      }
    },
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
 * Hostnames reserved by RFC 2606 to never resolve to anything real. `.invalid` (§2) exists so that a
 * name is *guaranteed* to fail resolution; `.test` (§2) is reserved for testing; `example.com`/`.net`/
 * `.org` and the `.example` TLD (§2, §3) are reserved for documentation. None of them can be a working
 * production endpoint anywhere, for anyone.
 *
 * Deliberately NOT here: `localhost` and loopback literals. A single-host deployment that runs Postgres
 * or an object store beside the API and addresses it as `localhost` is doing something ordinary and
 * correct, and rejecting that would break real deployments to catch a mistake this rule already catches.
 */
const RESERVED_HOST_NAMES: readonly string[] = [
  "invalid",
  "example",
  "test",
  "example.com",
  "example.net",
  "example.org",
];

/**
 * Is this hostname one RFC 2606 guarantees is not real? Matches the reserved name itself or any
 * subdomain of it, on a LABEL boundary — `notexample.com` merely ends with the characters of
 * `example.com` and is somebody's real domain, so a bare `endsWith` would reject it.
 */
export function isReservedPlaceholderHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return false;
  return RESERVED_HOST_NAMES.some((name) => host === name || host.endsWith(`.${name}`));
}

/**
 * Pull every hostname out of a config value. A value may be a URL (`https://gw.example.invalid/x`), a
 * connection string (`postgresql://u:p@host:5432/db`), a comma- or space-separated origin list
 * (`TRUSTED_ORIGINS`), or a bare host (`PASSKEY_RP_ID`). Anything that is neither parses to no host and
 * contributes nothing — a base64 key or a hex token has no dots and cannot be mistaken for a hostname.
 */
export function hostnamesIn(value: string): string[] {
  const hosts: string[] = [];
  for (const part of value.split(/[,\s]+/).filter(Boolean)) {
    try {
      const { hostname } = new URL(part);
      if (hostname) {
        hosts.push(hostname);
        continue;
      }
    } catch {
      // Not a URL — fall through to the bare-hostname shape below.
    }
    if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.?$/i.test(part)) {
      hosts.push(part);
    }
  }
  return hosts;
}

/**
 * The placeholder problem for one value, or null. Applied to EVERY requirement rather than only the
 * ones whose rule mentions a URL: the point is that `.env.example` ships reserved hosts in four values
 * and the per-key rules ask only for `https://`, so a copied example file passes production validation
 * intact and the stack boots "validated" against hosts DNS is guaranteed never to answer (#115).
 */
export function reservedPlaceholderProblem(value: string): string | null {
  const reserved = hostnamesIn(value).filter(isReservedPlaceholderHost);
  if (reserved.length === 0) return null;
  const names = [...new Set(reserved)].join(", ");
  return `must not use an RFC 2606 reserved host (${names}) — these never resolve, so this looks like an unedited .env.example placeholder`;
}

/**
 * F-181 — switches that exist ONLY for non-production use and must be ABSENT in production. A production
 * deployment that carries one is misconfigured in the dangerous direction, so the boot refuses rather than
 * trusting the runtime guard alone (the M29 outbound worker and inbound listener also ignore `M29_ALLOW_MLLP_PLAIN` in
 * production — this makes the mistake loud instead of silently inert).
 */
const FORBIDDEN_IN_PRODUCTION: readonly { readonly key: string; readonly problem: string }[] = [
  {
    key: "M29_ALLOW_MLLP_PLAIN",
    problem:
      "must not be set in production — it opts an HL7 feed (outbound sender or inbound listener) into cleartext `mllp_plain` (PHI on the wire) and is honoured only in non-production environments",
  },
];

/**
 * Collect every unmet production requirement (empty array = OK). Pure, so the rules are unit-testable
 * without mutating the process environment. Returns [] for any non-production `NODE_ENV`.
 */
export function collectEnvProblems(env: EnvLike): EnvProblem[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: EnvProblem[] = [];
  for (const { key, problem } of FORBIDDEN_IN_PRODUCTION) {
    if (env[key]?.trim()) problems.push({ key, problem });
  }
  for (const key of INTEGRATION_SWITCHES) {
    const value = env[key]?.trim().toLowerCase();
    if (value && value !== "true" && value !== "false") {
      problems.push({ key, problem: "must be 'true' or 'false'" });
    }
  }
  for (const { key, rule, when } of REQUIREMENTS) {
    if (when && !when(env)) continue;
    const value = env[key]?.trim();
    if (!value) {
      problems.push({ key, problem: "is required in production" });
      continue;
    }
    const ruleProblem = rule?.(value);
    if (ruleProblem) {
      problems.push({ key, problem: ruleProblem });
      continue;
    }
    const placeholder = reservedPlaceholderProblem(value);
    if (placeholder) problems.push({ key, problem: placeholder });
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
