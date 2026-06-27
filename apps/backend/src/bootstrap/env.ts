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
    key: "TWO_FACTOR_ENCRYPTION_KEY",
    rule: (v) => {
      try {
        return Buffer.from(v, "base64").length === 32 ? null : "must decode to 32 base64 bytes";
      } catch {
        return "must be valid base64";
      }
    },
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
