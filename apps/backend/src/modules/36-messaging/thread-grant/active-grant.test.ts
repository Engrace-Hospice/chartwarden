import { describe, expect, it } from "vitest";
import { type ThreadGrantFacts, hasActiveThreadGrant } from "./active-grant";

const NOW = new Date("2026-10-19T12:00:00Z");
const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const base: ThreadGrantFacts = {
  requestId: "r1",
  granteeUserId: "u1",
  revokedAt: null,
  grantedAt: at(-1),
  expiresAt: at(3),
};
const q = { requestId: "r1", granteeUserId: "u1", now: NOW };

describe("hasActiveThreadGrant", () => {
  it.each([
    ["live grant", [base], true],
    ["no rows", [], false],
    ["expired", [{ ...base, expiresAt: at(-0.5) }], false],
    ["expires exactly now", [{ ...base, expiresAt: NOW }], false],
    ["revoked", [{ ...base, revokedAt: at(-0.1) }], false],
    ["wrong user", [{ ...base, granteeUserId: "u2" }], false],
    ["wrong request", [{ ...base, requestId: "r2" }], false],
    ["future grant", [{ ...base, grantedAt: at(1), expiresAt: at(5) }], false],
    ["one live among dead", [{ ...base, revokedAt: at(-1) }, base], true],
  ] as const)("%s -> %s", (_name, rows, expected) => {
    expect(hasActiveThreadGrant(rows, q)).toBe(expected);
  });
});
