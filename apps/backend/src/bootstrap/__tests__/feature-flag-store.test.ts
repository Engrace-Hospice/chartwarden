/**
 * F-091 — the `feature_flag` resolution rules, as a pure function.
 *
 * `resolveFeatureFlags` is the whole of the reader apart from one SELECT, so every rule the live suite
 * exercises against Postgres is also pinned here without a database. The cases that matter are the ones
 * that decide a CAPABILITY GATE: each rule below has a fail-open sibling that would have been easy to
 * write (coerce a truthy string, bucket a rollout by org, keep serving an expired flag), and a capability
 * gate that fails open is a feature the operator did not turn on.
 */
import { describe, expect, it } from "vitest";
import { type FeatureFlagResolutionRow, resolveFeatureFlags } from "../feature-flag-store";

const NOW = new Date("2026-08-28T12:00:00.000Z");

function row(over: Partial<FeatureFlagResolutionRow> = {}): FeatureFlagResolutionRow {
  return {
    flagKey: "ai.full",
    organizationId: null,
    valueType: "bool",
    value: true,
    rolloutPercent: null,
    targeting: [],
    killSwitchActive: false,
    expiresAt: null,
    ...over,
  };
}

describe("resolveFeatureFlags", () => {
  it("resolves a plain boolean product flag in both directions", () => {
    expect(resolveFeatureFlags([row({ value: true })], NOW)).toEqual({ "ai.full": true });
    expect(resolveFeatureFlags([row({ value: false })], NOW)).toEqual({ "ai.full": false });
  });

  it("a tenant row wins over the global row, whichever order they arrive in", () => {
    const global = row({ organizationId: null, value: true });
    const tenant = row({ organizationId: "org-a", value: false });
    expect(resolveFeatureFlags([global, tenant], NOW)).toEqual({ "ai.full": false });
    expect(resolveFeatureFlags([tenant, global], NOW)).toEqual({ "ai.full": false });
  });

  it("a tenant row that yields no opinion does NOT fall back to the global row", () => {
    // The whole point of the precedence rule: an expiring tenant override must not silently hand the key
    // back to the platform default, which would read as "the platform re-enabled this here".
    const global = row({ organizationId: null, value: true });
    const expiredTenant = row({
      organizationId: "org-a",
      value: false,
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    expect(resolveFeatureFlags([global, expiredTenant], NOW)).toEqual({});
  });

  it("an active kill switch forces false, ahead of every other rule", () => {
    // Including rules that would otherwise make the key ABSENT — a killed flag says false out loud.
    expect(
      resolveFeatureFlags(
        [row({ killSwitchActive: true, value: true, valueType: "string", rolloutPercent: 25 })],
        NOW,
      ),
    ).toEqual({ "ai.full": false });
  });

  it("expiry is applied at the boundary instant, not after it", () => {
    expect(resolveFeatureFlags([row({ expiresAt: NOW })], NOW)).toEqual({});
    expect(resolveFeatureFlags([row({ expiresAt: new Date(NOW.getTime() + 1) })], NOW)).toEqual({
      "ai.full": true,
    });
  });

  it("a non-boolean value type is absent, never coerced", () => {
    // `"premium"` and `1` are both truthy in JS. Coercing either would turn a configuration value into
    // an enabled capability.
    expect(resolveFeatureFlags([row({ valueType: "string", value: "premium" })], NOW)).toEqual({});
    expect(resolveFeatureFlags([row({ valueType: "number", value: 1 })], NOW)).toEqual({});
    expect(resolveFeatureFlags([row({ valueType: "json", value: { on: true } })], NOW)).toEqual({});
  });

  it("a subject-dependent flag is absent — this port carries no subject", () => {
    expect(resolveFeatureFlags([row({ rolloutPercent: 100 })], NOW)).toEqual({});
    expect(resolveFeatureFlags([row({ rolloutPercent: 0 })], NOW)).toEqual({});
    expect(
      resolveFeatureFlags([row({ targeting: [{ roleKey: "rn", value: true }] })], NOW),
    ).toEqual({});
    // An EMPTY targeting list is the column default and means "no predicates" — not subject-dependent.
    expect(resolveFeatureFlags([row({ targeting: [] })], NOW)).toEqual({ "ai.full": true });
  });

  it("a non-true jsonb value is false, not truthy", () => {
    // jsonb round-trips `"true"` (a string) distinctly from `true`. Only the boolean counts.
    expect(resolveFeatureFlags([row({ value: "true" })], NOW)).toEqual({ "ai.full": false });
    expect(resolveFeatureFlags([row({ value: 1 })], NOW)).toEqual({ "ai.full": false });
    expect(resolveFeatureFlags([row({ value: null })], NOW)).toEqual({ "ai.full": false });
  });

  it("resolves independent keys independently", () => {
    expect(
      resolveFeatureFlags(
        [
          row({ flagKey: "ai.full", value: true }),
          row({ flagKey: "documents.doclens", organizationId: "org-a", value: false }),
          row({ flagKey: "m1.shim", expiresAt: new Date("2020-01-01T00:00:00.000Z") }),
        ],
        NOW,
      ),
    ).toEqual({ "ai.full": true, "documents.doclens": false });
  });

  it("no rows is an empty map — the same answer the unbound default gave, now for a real reason", () => {
    expect(resolveFeatureFlags([], NOW)).toEqual({});
  });
});
